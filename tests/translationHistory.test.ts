import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TranslationHistoryStore, TRANSLATION_HISTORY_LIMIT } from '../src/main/translationHistory'

const input = (text: string) => ({ original: text, translation: `译文 ${text}`, sourceLang: 'EN', targetLang: 'ZH', provider: 'google', origin: 'selection' as const })

async function fixture(run: (path: string, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'translation-history-'))
  try { await run(join(directory, 'history.json'), directory) } finally { await rm(directory, { recursive: true, force: true }) }
}

test('完整翻译应跨进程实例保留原文、译文、语言和时间', async () => fixture(async (path) => {
  const store = new TranslationHistoryStore(path, () => 123456789)
  await store.record(input('Hello'))
  const [entry] = await new TranslationHistoryStore(path).list()
  assert.equal(entry?.original, 'Hello')
  assert.equal(entry?.translation, '译文 Hello')
  assert.equal(entry?.createdAt, 123456789)
  assert.equal(entry?.sourceLang, 'EN')
  assert.ok(entry?.id)
  await store.record({ ...input(''), translation: '' })
  assert.equal((await store.list()).length, 1)
}))

test('并发写入保持顺序，重复结果移到最近位置，超过 200 条淘汰最早记录', async () => fixture(async (path) => {
  let clock = 0
  const store = new TranslationHistoryStore(path, () => ++clock)
  await Promise.all(Array.from({ length: 205 }, (_, index) => store.record(input(String(index)))))
  const entries = await store.list()
  assert.equal(entries.length, TRANSLATION_HISTORY_LIMIT)
  assert.equal(entries[0]?.original, '204')
  assert.equal(entries.at(-1)?.original, '5')
  await store.record(input('20'))
  const updated = await store.list()
  assert.equal(updated.length, 200)
  assert.equal(updated[0]?.original, '20')
  assert.equal(updated.filter((entry) => entry.original === '20').length, 1)
}))

test('清空后重新读取为空，写盘失败保留上一次已提交记录', async () => fixture(async (path) => {
  const store = new TranslationHistoryStore(path)
  await store.record(input('saved'))
  await mkdir(`${path}.tmp`)
  await assert.rejects(store.record(input('failed')))
  assert.equal((await store.list())[0]?.original, 'saved')
  await rm(`${path}.tmp`, { recursive: true })
  await store.clear()
  assert.deepEqual(await new TranslationHistoryStore(path).list(), [])
}))

test('损坏记录文件应备份，非法记录不进入视图', async () => fixture(async (path, directory) => {
  await writeFile(path, '{broken json')
  const store = new TranslationHistoryStore(path, () => 111)
  assert.deepEqual(await store.list(), [])
  assert.ok((await readdir(directory)).includes('history.json.invalid-111'))
  assert.equal(await readFile(`${path}.invalid-111`, 'utf8'), '{broken json')
  await store.record(input('<script>untrusted text</script>'))
  assert.equal((await store.list())[0]?.original, '<script>untrusted text</script>')
  await writeFile(path, JSON.stringify([{ ...input('invalid'), id: 'x', createdAt: 1e100 }]))
  assert.deepEqual(await new TranslationHistoryStore(path).list(), [])
}))
