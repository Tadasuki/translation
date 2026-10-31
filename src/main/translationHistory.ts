import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { TranslationHistoryEntry } from '../shared/types'

export const TRANSLATION_HISTORY_LIMIT = 200
const TEXT_LIMIT = 100_000

type HistoryInput = Omit<TranslationHistoryEntry, 'id' | 'createdAt'>

function parseEntry(value: unknown): TranslationHistoryEntry | null {
  if (!value || typeof value !== 'object') return null
  const entry = value as Record<string, unknown>
  if (typeof entry.id !== 'string' || !entry.id || typeof entry.createdAt !== 'number' || !Number.isFinite(new Date(entry.createdAt).getTime())) return null
  if (typeof entry.original !== 'string' || !entry.original.trim() || typeof entry.translation !== 'string' || !entry.translation.trim()) return null
  if (typeof entry.sourceLang !== 'string' || typeof entry.targetLang !== 'string') return null
  return {
    id: entry.id.slice(0, 80), createdAt: entry.createdAt,
    original: entry.original.slice(0, TEXT_LIMIT), translation: entry.translation.slice(0, TEXT_LIMIT),
    sourceLang: entry.sourceLang.slice(0, 24), targetLang: entry.targetLang.slice(0, 24),
    provider: typeof entry.provider === 'string' ? entry.provider.slice(0, 80) : undefined,
    origin: entry.origin === 'manual' || entry.origin === 'ocr' ? entry.origin : 'selection'
  }
}

/** 本机翻译记录；串行、原子写入，失败时不改变已提交的内存状态。 */
export class TranslationHistoryStore {
  private entries: TranslationHistoryEntry[] = []
  private loaded = false
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly path: string, private readonly now: () => number = Date.now) {}

  private async load(): Promise<void> {
    if (this.loaded) return
    let raw: string
    try { raw = await readFile(this.path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.loaded = true
      return
    }
    try {
      const data: unknown = JSON.parse(raw)
      if (!Array.isArray(data)) throw new Error('Invalid history file')
      this.entries = data.map(parseEntry).filter((entry): entry is TranslationHistoryEntry => entry !== null)
        .sort((a, b) => b.createdAt - a.createdAt).slice(0, TRANSLATION_HISTORY_LIMIT)
    } catch {
      // 损坏文件单独保留，后续写入不会覆盖可供恢复的原始数据。
      await rename(this.path, `${this.path}.invalid-${this.now()}`)
      this.entries = []
    }
    this.loaded = true
  }

  private run<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => { await this.load(); return action() })
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  private async commit(entries: TranslationHistoryEntry[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.tmp`
    await writeFile(temporary, JSON.stringify(entries), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.path)
    this.entries = entries
  }

  list(): Promise<TranslationHistoryEntry[]> {
    return this.run(async () => this.entries.map((entry) => ({ ...entry })))
  }

  record(input: HistoryInput): Promise<void> {
    return this.run(async () => {
      const entry = parseEntry({ ...input, id: randomUUID(), createdAt: this.now() })
      if (!entry) return
      const remaining = this.entries.filter((item) => !(item.original === entry.original && item.translation === entry.translation && item.sourceLang === entry.sourceLang && item.targetLang === entry.targetLang))
      await this.commit([entry, ...remaining].slice(0, TRANSLATION_HISTORY_LIMIT))
    })
  }

  clear(): Promise<void> { return this.run(() => this.commit([])) }
}
