import type { Api } from '../../shared/types'
import { VOCABULARY_EXPORT_FORMATS, filterVocabulary, type VocabularyEntry, type VocabularyExportFormat } from '../../shared/vocabulary'

export function startVocabularyExportPanel(api: Pick<Api, 'exportVocabulary'>, t: (key: string, params?: Record<string, string | number>) => string, options: {
  toolbar: HTMLElement; container: HTMLElement; before: HTMLElement
  entries(): VocabularyEntry[]; query(): string; busy(): boolean
}): { render(): void } {
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className = ''): HTMLElementTagNameMap[K] => {
    const element = document.createElement(tag); element.className = className; return element
  }
  const toggle = node('button', 'btn'); toggle.type = 'button'; toggle.id = 'vocabulary-export-toggle'
  toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-controls', 'vocabulary-export-panel')
  options.toolbar.append(toggle)
  const panel = node('section', 'vocabulary-export-panel'); panel.id = 'vocabulary-export-panel'; panel.hidden = true
  const heading = node('h3')
  const form = node('form', 'vocabulary-export-form')
  const format = node('select'); format.id = 'vocabulary-export-format'
  for (const value of VOCABULARY_EXPORT_FORMATS) { const option = node('option'); option.value = value; format.append(option) }
  const scope = node('select'); scope.id = 'vocabulary-export-scope'
  for (const value of ['all', 'filtered']) { const option = node('option'); option.value = value; scope.append(option) }
  const deck = node('input'); deck.id = 'vocabulary-export-deck'; deck.maxLength = 120; deck.type = 'text'
  const label = (key: string, control: HTMLElement): HTMLLabelElement => {
    const result = node('label', 'vocabulary-export-field'); const text = node('span'); text.dataset.exportLabel = key
    result.append(text, control); return result
  }
  const formatRow = label('vocabulary.export.formatLabel', format), scopeRow = label('vocabulary.export.scope', scope), deckRow = label('vocabulary.export.deck', deck)
  const hint = node('p', 'vocabulary-export-hint'); hint.id = 'vocabulary-export-hint'; format.setAttribute('aria-describedby', hint.id)
  const actions = node('div', 'vocabulary-actions')
  const save = node('button', 'btn primary'); save.type = 'submit'
  const close = node('button', 'btn'); close.type = 'button'
  const status = node('p', 'vocabulary-export-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite')
  actions.append(save, close); form.append(formatRow, scopeRow, deckRow, hint, actions)
  panel.append(heading, form); options.container.insertBefore(panel, options.before); options.container.insertBefore(status, options.before)
  let busy = false, touchedDeck = false, message: { key: string; params?: Record<string, string | number> } | null = null

  const render = (): void => {
    const entries = options.entries()
    const count = scope.value === 'filtered' ? filterVocabulary(entries, options.query()).length : entries.length
    toggle.textContent = t('vocabulary.export.open'); toggle.disabled = busy || options.busy() || !entries.length
    panel.setAttribute('aria-label', t('vocabulary.export.title')); heading.textContent = t('vocabulary.export.title')
    panel.querySelectorAll<HTMLElement>('[data-export-label]').forEach(element => { element.textContent = t(element.dataset.exportLabel!) })
    for (const option of format.options) option.textContent = t(`vocabulary.export.format.${option.value}`)
    scope.options[0].textContent = t('vocabulary.export.all', { count: entries.length })
    scope.options[1].textContent = t('vocabulary.export.filtered', { count: filterVocabulary(entries, options.query()).length })
    if (!touchedDeck) deck.value = t('vocabulary.export.defaultDeck')
    const needsDeck = format.value.startsWith('anki-')
    deckRow.hidden = !needsDeck
    hint.textContent = t(`vocabulary.export.hint.${format.value}`)
    for (const control of [format, scope, deck, close]) control.disabled = busy
    save.disabled = busy || !count || (needsDeck && !deck.value.trim())
    save.textContent = busy ? t('vocabulary.export.saving') : t('vocabulary.export.save', { count })
    close.textContent = t('vocabulary.export.close')
    status.textContent = message ? t(message.key, message.params) : ''
    panel.setAttribute('aria-busy', String(busy))
  }
  const hide = (): void => { panel.hidden = true; toggle.setAttribute('aria-expanded', 'false'); toggle.focus() }
  toggle.addEventListener('click', () => {
    if (!panel.hidden) { hide(); return }
    panel.hidden = false; toggle.setAttribute('aria-expanded', 'true')
    scope.value = options.query().trim() ? 'filtered' : 'all'; message = null; render(); format.focus()
  })
  close.addEventListener('click', hide)
  panel.addEventListener('keydown', event => { if (event.key === 'Escape' && !busy) { event.preventDefault(); hide() } })
  format.addEventListener('change', render); scope.addEventListener('change', render)
  deck.addEventListener('input', () => { touchedDeck = true; render() })
  form.addEventListener('submit', event => {
    event.preventDefault()
    if (busy || save.disabled) return
    busy = true; message = null; render()
    void api.exportVocabulary({ format: format.value as VocabularyExportFormat, scope: scope.value as 'all' | 'filtered', query: options.query().slice(0, 500), deckName: format.value.startsWith('anki-') ? deck.value : t('vocabulary.export.defaultDeck') })
      .then(result => {
        if (result.status === 'saved') message = { key: 'vocabulary.export.saved', params: { count: result.count } }
        else if (result.status === 'error') message = { key: `vocabulary.export.error.${result.error}` }
      }).catch(() => { message = { key: 'vocabulary.export.error.failed' } })
      .finally(() => { busy = false; render() })
  })
  document.addEventListener('locale:changed', render)
  render()
  return { render }
}
