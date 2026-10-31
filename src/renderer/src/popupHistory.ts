import type { Api, TranslationHistoryEntry } from '../../shared/types'
import type { Locale } from '../../shared/i18n/locale'
import { langLabel } from '../../shared/langs'

type HistoryApi = Pick<Api, 'getTranslationHistory' | 'clearTranslationHistory' | 'onTranslationHistoryChanged' | 'copy'>
interface HistoryOptions {
  t(key: string): string
  locale(): Locale
  onToggle(open: boolean): void
}

/** 独立的记录视图，不改写当前原文、译文或未提交的手动输入。 */
export function startPopupHistory(api: HistoryApi, options: HistoryOptions): void {
  const popup = document.getElementById('popup') as HTMLElement
  const toggle = document.getElementById('open-history') as HTMLButtonElement
  const view = document.getElementById('history-view') as HTMLElement
  const back = document.getElementById('history-back') as HTMLButtonElement
  const search = document.getElementById('history-search') as HTMLInputElement
  const clear = document.getElementById('history-clear') as HTMLButtonElement
  const list = document.getElementById('history-list') as HTMLElement
  const count = document.getElementById('history-count') as HTMLElement
  let entries: TranslationHistoryEntry[] = []
  let opened = false
  let loading = false
  let error = false
  let clearArmed = false
  let loadSequence = 0

  function resetClear(): void {
    clearArmed = false
    clear.textContent = options.t('popup.history.clear')
  }

  function render(): void {
    list.replaceChildren()
    const query = search.value.trim().toLocaleLowerCase(options.locale())
    const filtered = entries.filter((entry) => `${entry.original}\n${entry.translation}`.toLocaleLowerCase(options.locale()).includes(query))
    count.textContent = `${filtered.length} / ${entries.length}`
    clear.disabled = loading || entries.length === 0
    resetClear()
    if (loading || error || filtered.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'history-empty'
      empty.textContent = options.t(loading ? 'popup.history.loading' : error ? 'popup.history.failed' : query ? 'popup.history.noMatches' : 'popup.history.empty')
      list.append(empty)
      return
    }
    const formatter = new Intl.DateTimeFormat(options.locale(), { dateStyle: 'short', timeStyle: 'short' })
    for (const entry of filtered) {
      const card = document.createElement('article')
      card.className = 'history-entry'
      card.setAttribute('role', 'listitem')
      const header = document.createElement('div')
      header.className = 'history-entry-header'
      const languages = document.createElement('span')
      languages.textContent = `${langLabel(entry.sourceLang, options.locale())} → ${langLabel(entry.targetLang, options.locale())}`
      const time = document.createElement('time')
      time.dateTime = new Date(entry.createdAt).toISOString()
      time.textContent = formatter.format(entry.createdAt)
      header.append(languages, time)
      const source = document.createElement('p')
      source.className = 'history-original'
      source.textContent = entry.original
      const translation = document.createElement('p')
      translation.className = 'history-translation'
      translation.textContent = entry.translation
      const copy = document.createElement('button')
      copy.type = 'button'
      copy.className = 'text-action history-copy'
      copy.textContent = options.t('popup.copyTranslation')
      copy.addEventListener('click', () => {
        api.copy(entry.translation)
        copy.textContent = options.t('popup.history.copied')
        setTimeout(() => { copy.textContent = options.t('popup.copyTranslation') }, 1200)
      })
      card.append(header, source, translation, copy)
      list.append(card)
    }
  }

  async function refresh(): Promise<void> {
    const sequence = ++loadSequence
    loading = true
    error = false
    render()
    try {
      const history = await api.getTranslationHistory()
      if (sequence !== loadSequence) return
      entries = history
    } catch { if (sequence === loadSequence) error = true } finally {
      if (sequence === loadSequence) { loading = false; render() }
    }
  }

  function setOpen(open: boolean): void {
    opened = open
    popup.classList.toggle('history-open', open)
    view.hidden = !open
    toggle.setAttribute('aria-pressed', String(open))
    options.onToggle(open)
    if (open) { search.focus(); void refresh() }
    else { ++loadSequence; resetClear(); toggle.focus() }
  }

  toggle.addEventListener('click', () => setOpen(!opened))
  back.addEventListener('click', () => setOpen(false))
  search.addEventListener('input', render)
  document.getElementById('manual-mode')?.addEventListener('click', () => { if (opened) setOpen(false) }, true)
  document.addEventListener('keydown', (event) => {
    if (opened && event.key === 'Escape') {
      event.preventDefault()
      event.stopImmediatePropagation()
      setOpen(false)
    }
  }, true)
  clear.addEventListener('blur', resetClear)
  clear.addEventListener('click', () => {
    if (!clearArmed) { clearArmed = true; clear.textContent = options.t('popup.history.confirmClear'); return }
    clear.disabled = true
    void api.clearTranslationHistory().then(refresh).catch(() => { error = true; render() })
  })
  api.onTranslationHistoryChanged(() => { if (opened) void refresh() })
  document.addEventListener('locale:changed', () => { if (opened) render() })
}
