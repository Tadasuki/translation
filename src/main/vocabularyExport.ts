import { randomUUID } from 'node:crypto'
import { writeFile, rename, unlink } from 'node:fs/promises'
import { VOCABULARY_EXPORT_FORMATS, filterVocabulary, type VocabularyEntry, type VocabularyExportRequest, type VocabularyExportResult } from '../shared/vocabulary'
import { buildAnkiVocabularyPackage, escapeAnkiHtml, vocabularyMeaning } from './ankiVocabularyPackage'

export function normalizeVocabularyExportRequest(value: unknown): VocabularyExportRequest | null {
  if (!value || typeof value !== 'object') return null
  const request = value as VocabularyExportRequest
  if (!(VOCABULARY_EXPORT_FORMATS as readonly unknown[]).includes(request.format) || !['all', 'filtered'].includes(request.scope)
    || typeof request.deckName !== 'string' || request.deckName.length > 120
    || (request.query !== undefined && (typeof request.query !== 'string' || request.query.length > 500))) return null
  const deckName = request.deckName.replace(/[\x00-\x1f\x7f]/gu, '').split('::').map(part => part.trim()).filter(Boolean).join('::')
  if (!deckName) return null
  return { format: request.format, scope: request.scope, deckName, query: request.query?.trim() ?? '' }
}

export function vocabularyExportExtension(format: VocabularyExportRequest['format']): string {
  return format === 'anki-apkg' ? 'apkg' : format === 'csv' ? 'csv' : format === 'anki-tsv' ? 'tsv' : 'txt'
}
const line = (value: string): string => value.replace(/[\r\n\t\x00-\x1f]+/gu, ' ').trim()
const csv = (value: string): string => `"${(/^[\s]*[=+\-@]/u.test(value) ? `'${value}` : value).replace(/"/gu, '""')}"`

export async function buildVocabularyExport(entries: readonly VocabularyEntry[], request: VocabularyExportRequest, now = Date.now()): Promise<Uint8Array> {
  if (request.format === 'anki-apkg') return buildAnkiVocabularyPackage(entries, request.deckName, now)
  let output: string
  switch (request.format) {
    case 'eudic-txt': output = entries.map(entry => line(entry.word)).join('\r\n'); break
    case 'quizlet-tsv': output = entries.map(entry => [line(entry.word), line([entry.phonetics.join(' · '), vocabularyMeaning(entry), entry.context].filter(Boolean).join(' · '))].join('\t')).join('\r\n'); break
    case 'anki-tsv': output = `#separator:tab\n#html:true\n#deck:${request.deckName}\n#columns:Word\tBack\n` + entries.map(entry => [escapeAnkiHtml(entry.word), [entry.phonetics.join(' · '), vocabularyMeaning(entry), entry.context].filter(Boolean).map(escapeAnkiHtml).join('<br><br>')].join('\t')).join('\n'); break
    case 'csv': output = '\ufeff' + [['Word', 'Phonetics', 'Meaning', 'Context'], ...entries.map(entry => [entry.word, entry.phonetics.join(' · '), vocabularyMeaning(entry), entry.context])].map(fields => fields.map(csv).join(',')).join('\r\n'); break
  }
  return new Uint8Array(Buffer.from(output + '\r\n', 'utf8'))
}

interface Dependencies {
  entries(): Promise<VocabularyEntry[]>
  chooseFile(request: VocabularyExportRequest, extension: string): Promise<string | null>
  now?(): number
}

/** Export an authoritative snapshot; cancellation never writes a file or changes vocabulary. */
export async function exportVocabularyToFile(value: unknown, dependencies: Dependencies): Promise<VocabularyExportResult> {
  const request = normalizeVocabularyExportRequest(value)
  if (!request) return { status: 'error', error: 'invalid-request' }
  let temporary: string | null = null
  try {
    const all = await dependencies.entries()
    const entries = request.scope === 'filtered' ? filterVocabulary(all, request.query ?? '') : all
    if (!entries.length) return { status: 'error', error: 'empty' }
    const bytes = entries.reduce((total, entry) => total + Buffer.byteLength(JSON.stringify(entry), 'utf8'), 0)
    if (bytes > 32 * 1024 * 1024) return { status: 'error', error: 'too-large' }
    const filePath = await dependencies.chooseFile(request, vocabularyExportExtension(request.format))
    if (!filePath) return { status: 'cancelled' }
    const content = await buildVocabularyExport(entries, request, dependencies.now?.() ?? Date.now())
    temporary = `${filePath}.${randomUUID()}.tmp`
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 })
    await rename(temporary, filePath)
    temporary = null
    return { status: 'saved', count: entries.length, filePath }
  } catch { return { status: 'error', error: 'failed' } }
  finally { if (temporary) await unlink(temporary).catch(() => {}) }
}
