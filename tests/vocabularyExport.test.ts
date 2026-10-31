import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { unzipSync, strFromU8 } from 'fflate'
import type initializeSqlJs from 'sql.js'
import { buildVocabularyExport, exportVocabularyToFile, normalizeVocabularyExportRequest } from '../src/main/vocabularyExport'
import type { VocabularyEntry, VocabularyExportRequest } from '../src/shared/vocabulary'

const requireDependency = createRequire(join(process.cwd(), 'package.json'))
const initialize = requireDependency('sql.js/dist/sql-wasm-inline.js') as typeof initializeSqlJs
const sqlite = initialize()
const timestamp = 1793450000000
const entry = (word: string): VocabularyEntry => ({ id: word.toLowerCase(), word, phonetics: ['/wɜːd/'],
  definitions: [{ text: '中文释义，含 "引号"\n<script>alert(1)</script>\t第二行', partOfSpeech: 'noun', language: 'zh', source: 'iscorevoc' }],
  context: 'An "example", with commas.\nAnd another line.', createdAt: timestamp, dueAt: timestamp, reviews: 5, streak: 2, reviewedAt: timestamp })
const options: VocabularyExportRequest = { format: 'anki-apkg', scope: 'all', deckName: 'My Vocabulary' }

async function openDeck(entries: VocabularyEntry[], now = timestamp) {
  const content = await buildVocabularyExport(entries, options, now)
  const zip = unzipSync(content)
  const SQL = await sqlite
  return { zip, db: new SQL.Database(zip['collection.anki2']) }
}

test('Anki package is a valid SQLite deck with escaped Unicode fields and fresh cards', async () => {
  const { zip, db } = await openDeck([entry('example'), entry("don't")])
  try {
    assert.deepEqual(Object.keys(zip).sort(), ['collection.anki2', 'media'])
    assert.equal(strFromU8(zip.media), '{}')
    assert.equal(db.exec('PRAGMA integrity_check')[0].values[0][0], 'ok')
    const rows = db.exec('SELECT guid,flds,sfld,csum FROM notes ORDER BY id')[0].values
    assert.equal(rows.length, 2)
    const fields = String(rows[0][1]).split('\x1f')
    assert.equal(fields.length, 4)
    assert.match(fields[2], /中文释义，含 &quot;引号&quot;<br>&lt;script&gt;/u)
    assert.doesNotMatch(fields[2], /<script>/u)
    assert.match(fields[3], /&quot;example&quot;, with commas\.<br>/u)
    assert.equal(db.exec('SELECT SUM(type+queue+reps+lapses+ivl) FROM cards')[0].values[0][0], 0)
    assert.equal(db.exec('SELECT COUNT(*) FROM revlog')[0].values[0][0], 0)
    const models = JSON.parse(String(db.exec('SELECT models FROM col')[0].values[0][0]))
    const model = Object.values(models)[0] as { flds: { name: string }[]; tmpls: { afmt: string }[] }
    assert.deepEqual(model.flds.map(field => field.name), ['Word', 'Phonetics', 'Meaning', 'Context'])
    assert.ok(model.tmpls[0].afmt.includes('{{Context}}'))
  } finally { db.close() }
})

test('Anki note identity stays stable across exports and updated meanings', async () => {
  const first = await openDeck([entry('Example')])
  const changed = entry('example'); changed.definitions[0].text = '新释义'
  const second = await openDeck([changed], timestamp + 5000)
  try {
    assert.equal(first.db.exec('SELECT guid FROM notes')[0].values[0][0], second.db.exec('SELECT guid FROM notes')[0].values[0][0])
    assert.notEqual(first.db.exec('SELECT flds FROM notes')[0].values[0][0], second.db.exec('SELECT flds FROM notes')[0].values[0][0])
    assert.ok(Number(second.db.exec('SELECT mod FROM notes')[0].values[0][0]) > Number(first.db.exec('SELECT mod FROM notes')[0].values[0][0]))
  } finally { first.db.close(); second.db.close() }
})

test('word lists and Quizlet text preserve one card per line with correct columns', async () => {
  const entries = [entry('example'), entry("don't")]
  const words = Buffer.from(await buildVocabularyExport(entries, { ...options, format: 'eudic-txt' })).toString('utf8')
  assert.equal(words, "example\r\ndon't\r\n")
  const quizlet = Buffer.from(await buildVocabularyExport(entries, { ...options, format: 'quizlet-tsv' })).toString('utf8')
  const rows = quizlet.trim().split('\r\n')
  assert.equal(rows.length, 2)
  assert.ok(rows.every(row => row.split('\t').length === 2))
  assert.match(rows[0], /中文释义/u)
  assert.match(rows[0], /An "example", with commas\. And another line\./u)
})

test('Anki text supplies import headers and HTML escapes, while CSV handles quotes and formulas', async () => {
  const item = entry('example')
  const tsv = Buffer.from(await buildVocabularyExport([item], { ...options, format: 'anki-tsv' })).toString('utf8')
  assert.match(tsv, /^#separator:tab\n#html:true\n#deck:My Vocabulary\n#columns:Word\tBack\n/u)
  assert.equal(tsv.split('\n').filter(line => line && !line.startsWith('#')).length, 1)
  assert.match(tsv, /&lt;script&gt;/u)
  item.context = '=HYPERLINK("https://example.invalid")'
  const csv = Buffer.from(await buildVocabularyExport([item], { ...options, format: 'csv' })).toString('utf8')
  assert.equal(csv.charCodeAt(0), 0xfeff)
  assert.match(csv, /"Word","Phonetics","Meaning","Context"/u)
  assert.match(csv, /""引号""/u)
  assert.match(csv, /"'=HYPERLINK\(""https:\/\/example\.invalid""\)"/u)
})

test('filtered export uses the store snapshot and never changes review progress', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vocabulary-export-'))
  const entries = [entry('first'), entry('second')]
  entries[1].context = 'Unique context'
  const before = JSON.stringify(entries)
  try {
    const path = join(directory, 'words.txt')
    const result = await exportVocabularyToFile({ ...options, format: 'eudic-txt', scope: 'filtered', query: 'UNIQUE' }, {
      entries: async () => entries, chooseFile: async () => path
    })
    assert.equal(result.status, 'saved')
    if (result.status === 'saved') assert.equal(result.count, 1)
    assert.equal(await readFile(path, 'utf8'), 'second\r\n')
    assert.equal(JSON.stringify(entries), before)
    assert.deepEqual(await readdir(directory), ['words.txt'])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('cancelled, empty and invalid exports never write files', async () => {
  let dialogs = 0, reads = 0
  const dependencies = { entries: async () => { reads++; return [entry('example')] }, chooseFile: async () => { dialogs++; return null } }
  assert.deepEqual(await exportVocabularyToFile(options, dependencies), { status: 'cancelled' })
  assert.equal(dialogs, 1)
  assert.deepEqual(await exportVocabularyToFile({ ...options, scope: 'filtered', query: 'notfound' }, dependencies), { status: 'error', error: 'empty' })
  assert.equal(dialogs, 1)
  assert.deepEqual(await exportVocabularyToFile({ ...options, format: '../../bad' }, dependencies), { status: 'error', error: 'invalid-request' })
  assert.equal(reads, 2)
  assert.equal(normalizeVocabularyExportRequest({ ...options, deckName: '\n::\t' }), null)
})

test('an interrupted file replacement leaves the target and vocabulary intact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vocabulary-export-failure-'))
  try {
    const target = join(directory, 'existing')
    await mkdir(target); await writeFile(join(target, 'original.txt'), 'keep')
    const result = await exportVocabularyToFile({ ...options, format: 'eudic-txt' }, { entries: async () => [entry('example')], chooseFile: async () => target })
    assert.deepEqual(result, { status: 'error', error: 'failed' })
    assert.equal(await readFile(join(target, 'original.txt'), 'utf8'), 'keep')
    assert.deepEqual(await readdir(directory), ['existing'])
  } finally { await rm(directory, { recursive: true, force: true }) }
})
