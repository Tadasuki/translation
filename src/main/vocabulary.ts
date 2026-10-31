import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parsePronunciationWord } from '../shared/pronunciationWord'
import { reviewVocabulary, type VocabularyEntry, type VocabularyInput } from '../shared/vocabulary'

function clone(entry: VocabularyEntry): VocabularyEntry {
  return { ...entry, phonetics: [...entry.phonetics], definitions: entry.definitions.map(item => ({ ...item })) }
}

function normalizeInput(value: unknown): VocabularyInput {
  if (!value || typeof value !== 'object') throw new Error('INVALID_WORD')
  const input = value as Record<string, unknown>
  const parsed = typeof input.word === 'string' && parsePronunciationWord(input.word)
  if (!parsed) throw new Error('INVALID_WORD')
  const definitions: VocabularyInput['definitions'] = []
  if (Array.isArray(input.definitions)) for (const item of input.definitions.slice(0, 12)) {
    if (!item || typeof item !== 'object' || typeof item.text !== 'string' || !item.text.trim()) continue
    definitions.push({ text: item.text.trim().slice(0, 2000),
      partOfSpeech: typeof item.partOfSpeech === 'string' ? item.partOfSpeech.slice(0, 60) : undefined,
      language: item.language === 'zh' ? 'zh' : 'en', source: item.source === 'iscorevoc' ? 'iscorevoc' : 'dictionaryapi' })
  }
  return { word: parsed.word, definitions,
    phonetics: Array.isArray(input.phonetics) ? [...new Set(input.phonetics.filter((v): v is string => typeof v === 'string').map(v => v.slice(0, 100)))].slice(0, 6) : [],
    context: typeof input.context === 'string' ? input.context.slice(0, 3000) : '' }
}

/** Local vocabulary, with serialized atomic writes and preserved damaged files. */
export class VocabularyStore {
  private entries: VocabularyEntry[] = []
  private loaded = false
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly path: string, private readonly now = Date.now) {}

  private async load(): Promise<void> {
    if (this.loaded) return
    let raw: string
    try { raw = await readFile(this.path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.loaded = true; return
    }
    let data: unknown
    try { data = JSON.parse(raw); if (!Array.isArray(data)) throw new Error('INVALID_FILE') } catch {
      await rename(this.path, `${this.path}.invalid-${this.now()}`)
      this.loaded = true; return
    }
    const seen = new Set<string>()
    for (const value of data as unknown[]) {
      try {
        const input = normalizeInput(value)
        const item = value as VocabularyEntry
        const id = input.word.toLowerCase()
        if (seen.has(id) || !Number.isFinite(item.createdAt) || !Number.isFinite(item.dueAt)
          || !Number.isFinite(new Date(item.createdAt).getTime()) || !Number.isFinite(new Date(item.dueAt).getTime())) continue
        this.entries.push({ ...input, id, createdAt: item.createdAt, dueAt: item.dueAt,
          reviewedAt: typeof item.reviewedAt === 'number' && Number.isFinite(item.reviewedAt) ? item.reviewedAt : null,
          reviews: Number.isSafeInteger(item.reviews) && item.reviews >= 0 ? item.reviews : 0,
          streak: Number.isSafeInteger(item.streak) && item.streak >= 0 ? item.streak : 0 })
        seen.add(id)
      } catch { /* Ignore invalid records without losing valid words. */ }
    }
    this.loaded = true
  }

  private run<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => { await this.load(); return action() })
    this.queue = result.catch(() => undefined)
    return result
  }
  private async commit(entries: VocabularyEntry[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    await writeFile(`${this.path}.tmp`, JSON.stringify(entries), { encoding: 'utf8', mode: 0o600 })
    await rename(`${this.path}.tmp`, this.path)
    this.entries = entries
  }
  list(): Promise<VocabularyEntry[]> { return this.run(async () => this.entries.map(clone)) }
  add(value: unknown): Promise<VocabularyEntry> {
    return this.run(async () => {
      const input = normalizeInput(value), id = input.word.toLowerCase()
      const existing = this.entries.find(entry => entry.id === id)
      if (existing) return clone(existing)
      if (this.entries.length >= 10000) throw new Error('VOCABULARY_FULL')
      const now = this.now()
      const entry: VocabularyEntry = { ...input, id, createdAt: now, dueAt: now, reviewedAt: null, reviews: 0, streak: 0 }
      await this.commit([entry, ...this.entries]); return clone(entry)
    })
  }
  remove(id: unknown): Promise<void> {
    return this.run(async () => {
      if (typeof id !== 'string') throw new Error('INVALID_WORD')
      await this.commit(this.entries.filter(entry => entry.id !== id.toLowerCase()))
    })
  }
  review(id: unknown, remembered: unknown): Promise<VocabularyEntry> {
    return this.run(async () => {
      if (typeof id !== 'string' || typeof remembered !== 'boolean') throw new Error('INVALID_REVIEW')
      const entry = this.entries.find(entry => entry.id === id.toLowerCase())
      if (!entry) throw new Error('WORD_NOT_FOUND')
      const reviewed = reviewVocabulary(entry, remembered, this.now())
      await this.commit(this.entries.map(item => item.id === entry.id ? reviewed : item))
      return clone(reviewed)
    })
  }
}
