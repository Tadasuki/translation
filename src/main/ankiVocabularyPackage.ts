import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import type { SqlJsStatic } from 'sql.js'
import type initializeSqlJs from 'sql.js'
import type { VocabularyEntry } from '../shared/vocabulary'

// Embedded WebAssembly avoids native ABI bindings, extra resource paths and Python.
let sqlite: Promise<SqlJsStatic> | undefined
async function loadSqlite(): Promise<SqlJsStatic> {
  if (!sqlite) {
    // Main ships as CJS; bundled ESM tests resolve dependencies from the repo cwd.
    const requireDependency = createRequire(typeof __filename === 'string' ? __filename : join(process.cwd(), 'package.json'))
    const initialize = requireDependency('sql.js/dist/sql-wasm-inline.js') as typeof initializeSqlJs
    sqlite = initialize().catch(error => { sqlite = undefined; throw error })
  }
  return sqlite
}

export function escapeAnkiHtml(value: string): string {
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/gu, '')
    .replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;').replace(/'/gu, '&#39;').replace(/\r\n?|\n/gu, '<br>').replace(/\t/gu, '&#9;')
}

export function vocabularyMeaning(entry: VocabularyEntry): string {
  return entry.definitions.map(def => [def.partOfSpeech, def.text].filter(Boolean).join(' · ')).join('\n')
}

const MODEL_ID = 1903158876021
const SCHEMA_TIME = 1700000000000
function numericId(text: string): number { return Number.parseInt(createHash('sha256').update(text).digest('hex').slice(0, 12), 16) }

const SCHEMA = `
CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null, scm integer not null, ver integer not null, dty integer not null, usn integer not null, ls integer not null, conf text not null, models text not null, decks text not null, dconf text not null, tags text not null);
CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null, mod integer not null, usn integer not null, tags text not null, flds text not null, sfld integer not null, csum integer not null, flags integer not null, data text not null);
CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null, ord integer not null, mod integer not null, usn integer not null, type integer not null, queue integer not null, due integer not null, ivl integer not null, factor integer not null, reps integer not null, lapses integer not null, left integer not null, odue integer not null, odid integer not null, flags integer not null, data text not null);
CREATE TABLE revlog (id integer primary key, cid integer not null, usn integer not null, ease integer not null, ivl integer not null, lastIvl integer not null, factor integer not null, time integer not null, type integer not null);
CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
CREATE INDEX ix_notes_usn ON notes(usn); CREATE INDEX ix_notes_csum ON notes(csum);
CREATE INDEX ix_cards_usn ON cards(usn); CREATE INDEX ix_cards_nid ON cards(nid);
CREATE INDEX ix_cards_sched ON cards(did, queue, due); CREATE INDEX ix_revlog_usn ON revlog(usn); CREATE INDEX ix_revlog_cid ON revlog(cid);
`

/** Anki's legacy deck-package schema is still supported by Anki and AnkiDroid. */
export async function buildAnkiVocabularyPackage(entries: readonly VocabularyEntry[], deckName: string, now: number): Promise<Uint8Array> {
  const SQL = await loadSqlite()
  const db = new SQL.Database()
  const deckId = numericId(`RinoNya-vocabulary-deck:${deckName}`)
  const seconds = Math.floor(now / 1000)
  const deck = (id: number, name: string) => ({ id, name, desc: '', conf: 1, dyn: 0, collapsed: false, extendNew: 0, extendRev: 50,
    mod: seconds, usn: -1, lrnToday: [0, 0], newToday: [0, 0], revToday: [0, 0], timeToday: [0, 0] })
  const model = { id: MODEL_ID, name: 'RinoNya Vocabulary', type: 0, mod: Math.floor(SCHEMA_TIME / 1000), usn: -1, sortf: 0, did: deckId,
    flds: ['Word', 'Phonetics', 'Meaning', 'Context'].map((name, ord) => ({ name, ord, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] })),
    tmpls: [{ name: 'Word → Meaning', ord: 0, did: null, bqfmt: '', bafmt: '',
      qfmt: '<div class="word">{{Word}}</div>',
      afmt: '{{FrontSide}}<hr id="answer">{{#Phonetics}}<div class="ipa">{{Phonetics}}</div>{{/Phonetics}}{{#Meaning}}<div class="meaning">{{Meaning}}</div>{{/Meaning}}{{#Context}}<div class="context">{{Context}}</div>{{/Context}}' }],
    css: '.card { font: 20px/1.7 -apple-system,BlinkMacSystemFont,"Hiragino Sans GB",Arial,sans-serif; text-align:left; color:#303030; background:#fafafa; padding:24px; } .word { font-size:34px; font-weight:600; } .ipa { color:#777; } .meaning { margin:20px 0; } .context { padding-left:14px; border-left:3px solid #c99aac; color:#666; } hr { border:0; border-top:1px solid #ddd; margin:20px 0; } .nightMode .card { color:#eee; background:#242424; } .nightMode .context,.nightMode .ipa { color:#bbb; }',
    latexPre: '\\documentclass[12pt]{article}\\begin{document}', latexPost: '\\end{document}', latexsvg: false, req: [[0, 'all', [0]]], tags: [], vers: [] }
  const configuration = { id: 1, name: 'Default', mod: 0, usn: 0, maxTaken: 60, timer: 0, autoplay: true, replayq: true,
    new: { bury: true, delays: [1, 10], initialFactor: 2500, ints: [1, 4, 7], order: 1, perDay: 20, separate: true },
    rev: { bury: true, ease4: 1.3, fuzz: 0.05, ivlFct: 1, maxIvl: 36500, minSpace: 1, perDay: 100 },
    lapse: { delays: [10], leechAction: 0, leechFails: 8, minInt: 1, mult: 0 } }
  try {
    db.run(SCHEMA)
    db.run('INSERT INTO col VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', [1, seconds, now, SCHEMA_TIME, 11, 0, -1, 0,
      JSON.stringify({ activeDecks: [deckId], curDeck: deckId, curModel: String(MODEL_ID), nextPos: entries.length + 1, newSpread: 0, sortType: 'noteFld', sortBackwards: false }),
      JSON.stringify({ [MODEL_ID]: model }), JSON.stringify({ 1: deck(1, 'Default'), [deckId]: deck(deckId, deckName) }), JSON.stringify({ 1: configuration }), '{}'])
    db.run('BEGIN')
    const note = db.prepare('INSERT INTO notes VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    const card = db.prepare('INSERT INTO cards VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    try {
      for (const [index, entry] of entries.entries()) {
        const id = now + index * 2
        const fields = [entry.word, entry.phonetics.join(' · '), vocabularyMeaning(entry), entry.context].map(escapeAnkiHtml)
        // Stable across packages and deck renames; Anki uses GUIDs to update existing notes.
        const guid = createHash('sha256').update(`RinoNya-vocabulary-v1:${entry.word.toLowerCase()}`).digest('hex').slice(0, 20)
        const checksum = Number.parseInt(createHash('sha1').update(entry.word).digest('hex').slice(0, 8), 16)
        note.run([id, guid, MODEL_ID, seconds, -1, ' RinoNya ', fields.join('\x1f'), entry.word, checksum, 0, ''])
        card.run([id + 1, id, deckId, 0, seconds, -1, 0, 0, index + 1, 0, 0, 0, 0, 0, 0, 0, 0, ''])
        if (index % 250 === 249) await new Promise<void>(resolve => setImmediate(resolve))
      }
    } finally { note.free(); card.free() }
    db.run('COMMIT')
    return zipSync({ 'collection.anki2': db.export(), media: strToU8('{}') }, { level: 6 })
  } finally { db.close() }
}
