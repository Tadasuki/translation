import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { VocabularyStore } from '../src/main/vocabulary'

const input = (word: string) => ({ word, phonetics: ['/wɜːd/'], definitions: [{ text: '单词', language: 'zh' as const, source: 'iscorevoc' as const }], context: 'A word in context.' })

test('vocabulary persists, deduplicates case, and isolates returned state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vocabulary-'))
  try {
    const path = join(directory, 'words.json'), store = new VocabularyStore(path, () => 1000)
    await Promise.all([store.add(input('Hello')), store.add(input('hello')), store.add(input('world'))])
    const entries = await store.list()
    assert.equal(entries.length, 2)
    entries[0].definitions[0].text = 'changed'
    assert.equal((await store.list())[0].definitions[0].text, '单词')
    const restored = new VocabularyStore(path)
    assert.equal((await restored.list()).length, 2)
    await restored.remove('HELLO')
    assert.deepEqual((await new VocabularyStore(path).list()).map(entry => entry.id), ['world'])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('reviews grow the interval, reset forgotten words and survive restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vocabulary-review-'))
  try {
    let now = 1000
    const path = join(directory, 'words.json'), store = new VocabularyStore(path, () => now)
    await store.add(input('memory'))
    const first = await store.review('memory', true)
    assert.equal(first.dueAt, now + 86400000)
    now = first.dueAt
    const second = await store.review('memory', true)
    assert.equal(second.dueAt, now + 3 * 86400000)
    const forgotten = await store.review('memory', false)
    assert.equal(forgotten.streak, 0)
    assert.equal(forgotten.dueAt, now + 600000)
    assert.equal((await new VocabularyStore(path).list())[0].reviews, 3)
    await assert.rejects(store.review('missing', true), /WORD_NOT_FOUND/)
    await assert.rejects(store.review('memory', 'true'), /INVALID_REVIEW/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('damaged vocabulary files are retained; invalid words cannot be saved', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vocabulary-invalid-'))
  try {
    const path = join(directory, 'words.json')
    await writeFile(path, '{broken')
    const store = new VocabularyStore(path, () => 5000)
    assert.deepEqual(await store.list(), [])
    assert.equal(await readFile(`${path}.invalid-5000`, 'utf8'), '{broken')
    await assert.rejects(store.add(input('two words')), /INVALID_WORD/)
    await store.add(input('valid'))
    assert.equal((await store.list()).length, 1)
    assert.ok((await readdir(directory)).includes('words.json.invalid-5000'))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('a failed atomic save does not publish uncommitted vocabulary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vocabulary-failure-'))
  try {
    const path = join(directory, 'words.json'), store = new VocabularyStore(path)
    await store.add(input('safe'))
    await mkdir(`${path}.tmp`)
    await assert.rejects(store.add(input('lost')))
    assert.deepEqual((await store.list()).map(entry => entry.word), ['safe'])
    await rm(`${path}.tmp`, { recursive: true })
    await store.add(input('retry'))
    assert.equal((await store.list()).length, 2)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
