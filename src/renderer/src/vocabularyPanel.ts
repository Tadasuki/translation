import type { Api } from '../../shared/types'
import { filterVocabulary, type VocabularyEntry } from '../../shared/vocabulary'
import { startVocabularyExportPanel } from './vocabularyExportPanel'

/** A persistent library and a small spaced-review session inside Settings. */
export function startVocabularyPanel(api: Api, t: (key: string, params?: Record<string, string | number>) => string): void {
  const root = document.getElementById('vocabulary-root')!
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
    const element = document.createElement(tag); element.className = className; element.textContent = text; return element
  }
  const toolbar = node('div', 'vocabulary-toolbar')
  const search = node('input'); search.type = 'search'
  search.maxLength = 500
  const review = node('button', 'btn primary'); review.type = 'button'
  const count = node('p', 'vocabulary-summary')
  const status = node('p', 'vocabulary-summary'); status.setAttribute('role', 'status')
  const content = node('div', 'vocabulary-content')
  toolbar.append(search, review); root.append(toolbar, count, status, content)
  let entries: VocabularyEntry[] = [], session: string[] | null = null, revealed = false, busy = false, error = false, version = 0, visibleCount = 50
  let exporter: ReturnType<typeof startVocabularyExportPanel> | undefined

  const updateSummary = (): void => {
    review.disabled = busy || !entries.some(entry => entry.dueAt <= Date.now())
    count.textContent = t('vocabulary.summary', { total: entries.length, due: entries.filter(entry => entry.dueAt <= Date.now()).length })
  }

  const makeButton = (label: string, action: () => void, primary = false): HTMLButtonElement => {
    const button = node('button', primary ? 'btn primary' : 'btn', label)
    button.type = 'button'; button.disabled = busy; button.addEventListener('click', action); return button
  }
  const describe = (entry: VocabularyEntry, parent: HTMLElement): void => {
    const ipa = node('p', 'vocabulary-phonetics', entry.phonetics.join(' · ')); parent.append(ipa)
    const definitions = node('div', 'vocabulary-definitions')
    for (const definition of entry.definitions) definitions.append(node('p', '', [definition.partOfSpeech, definition.text].filter(Boolean).join(' · ')))
    if (!entry.definitions.length) definitions.append(node('p', '', t('vocabulary.noDefinitions')))
    parent.append(definitions)
    if (entry.context) parent.append(node('blockquote', 'vocabulary-context', entry.context))
  }
  const mutate = async (action: () => Promise<unknown>, after?: () => void): Promise<void> => {
    if (busy) return
    busy = true; error = false; render()
    try { await action(); after?.(); await refresh() } catch { error = true } finally { busy = false; render() }
  }
  const render = (): void => {
    exporter?.render()
    search.placeholder = t('vocabulary.search'); search.setAttribute('aria-label', search.placeholder)
    review.textContent = t('vocabulary.review'); updateSummary()
    status.textContent = error ? t('vocabulary.error') : ''
    content.replaceChildren()
    if (session) {
      session = session.filter(id => entries.some(entry => entry.id === id))
      const entry = entries.find(item => item.id === session?.[0])
      const card = node('section', 'vocabulary-review-card'); card.setAttribute('aria-live', 'polite')
      if (!entry) {
        card.append(node('h2', '', t('vocabulary.finished')), node('p', 'vocabulary-summary', t('vocabulary.finishedHint')))
      } else {
        card.append(node('p', 'vocabulary-summary', t('vocabulary.remaining', { count: session.length })), node('h2', '', entry.word))
        if (revealed) {
          describe(entry, card)
          const actions = node('div', 'vocabulary-actions')
          const rate = (remembered: boolean): void => { void mutate(() => api.reviewVocabulary(entry.id, remembered), () => { session?.shift(); revealed = false }) }
          actions.append(makeButton(t('vocabulary.again'), () => rate(false)), makeButton(t('vocabulary.remembered'), () => rate(true), true)); card.append(actions)
        } else card.append(makeButton(t('vocabulary.reveal'), () => { revealed = true; render() }, true))
      }
      card.append(makeButton(t('vocabulary.back'), () => { session = null; render() })); content.append(card); return
    }
    const query = search.value.trim().toLowerCase()
    const filtered = filterVocabulary(entries, query)
    if (!filtered.length) { content.append(node('p', 'vocabulary-empty', t(query ? 'vocabulary.noMatches' : 'vocabulary.empty'))); return }
    for (const entry of filtered.slice(0, visibleCount)) {
      const card = node('article', 'vocabulary-entry')
      const heading = node('div', 'vocabulary-entry-heading')
      const remove = makeButton(t('vocabulary.remove'), () => { void mutate(() => api.removeVocabulary(entry.id)) })
      remove.setAttribute('aria-label', `${t('vocabulary.remove')} ${entry.word}`)
      heading.append(node('h3', '', entry.word), remove); card.append(heading); describe(entry, card)
      card.append(node('p', 'vocabulary-summary', t(entry.dueAt <= Date.now() ? 'vocabulary.due' : 'vocabulary.nextReview', { date: new Date(entry.dueAt).toLocaleDateString(document.documentElement.lang) })))
      content.append(card)
    }
    if (filtered.length > visibleCount) content.append(makeButton(t('vocabulary.more'), () => { visibleCount += 50; render() }))
  }
  const refresh = async (): Promise<void> => {
    const request = ++version
    try { const result = await api.getVocabulary(); if (version !== request) return; entries = result; error = false }
    catch { if (version === request) error = true }
    render()
  }
  search.addEventListener('input', () => { session = null; visibleCount = 50; render() })
  review.addEventListener('click', () => {
    session = entries.filter(entry => entry.dueAt <= Date.now()).sort((a, b) => a.dueAt - b.dueAt).map(entry => entry.id)
    revealed = false; render()
  })
  api.onVocabularyChanged(() => { void refresh() })
  document.addEventListener('locale:changed', render)
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh() })
  window.setInterval(updateSummary, 60000)
  exporter = startVocabularyExportPanel(api, t, { toolbar, container: root, before: count, entries: () => entries, query: () => search.value, busy: () => busy })
  render(); void refresh()
}
