import type { PronunciationDefinition } from './types'

export interface VocabularyInput {
  word: string
  definitions: PronunciationDefinition[]
  phonetics: string[]
  context: string
}

export interface VocabularyEntry extends VocabularyInput {
  id: string
  createdAt: number
  dueAt: number
  reviewedAt: number | null
  reviews: number
  streak: number
}

export const VOCABULARY_EXPORT_FORMATS = ['anki-apkg', 'anki-tsv', 'eudic-txt', 'quizlet-tsv', 'csv'] as const
export type VocabularyExportFormat = typeof VOCABULARY_EXPORT_FORMATS[number]
export interface VocabularyExportRequest {
  format: VocabularyExportFormat
  scope: 'all' | 'filtered'
  query?: string
  deckName: string
}
export type VocabularyExportResult =
  | { status: 'saved'; count: number; filePath: string }
  | { status: 'cancelled' }
  | { status: 'error'; error: 'invalid-request' | 'empty' | 'too-large' | 'failed' }

export function filterVocabulary(entries: readonly VocabularyEntry[], query: string): VocabularyEntry[] {
  const needle = query.trim().toLowerCase()
  return entries.filter(entry => `${entry.word} ${entry.definitions.map(def => def.text).join(' ')} ${entry.context}`.toLowerCase().includes(needle))
}

const REVIEW_DAYS = [1, 3, 7, 14, 30, 60]
export function reviewVocabulary(entry: VocabularyEntry, remembered: boolean, now: number): VocabularyEntry {
  const streak = remembered ? entry.streak + 1 : 0
  const delay = remembered ? REVIEW_DAYS[Math.min(streak - 1, REVIEW_DAYS.length - 1)] * 86400000 : 10 * 60000
  return { ...entry, streak, reviews: entry.reviews + 1, reviewedAt: now, dueAt: now + delay }
}
