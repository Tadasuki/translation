import type { Api } from '../../shared/types'
import type { VocabularyInput } from '../../shared/vocabulary'

export function startVocabularyFavorite(api: Api, options: {
  current(): VocabularyInput | null
  t(key: string): string
  message(text: string): void
}): { render(): void } {
  const button = document.getElementById('pronunciation-favorite') as HTMLButtonElement
  let saved = new Set<string>(), ready = false, busy = false
  const render = (): void => {
    const word = options.current()?.word
    const selected = Boolean(word && saved.has(word.toLowerCase()))
    button.setAttribute('aria-pressed', String(selected))
    button.disabled = !ready || !word || busy
    button.title = options.t(selected ? 'vocabulary.remove' : 'vocabulary.add')
    button.setAttribute('aria-label', button.title)
  }
  let version = 0
  const refresh = async (): Promise<void> => {
    const request = ++version
    try {
      const entries = await api.getVocabulary()
      if (request !== version) return
      saved = new Set(entries.map(entry => entry.id)); ready = true
    } catch { if (request === version) ready = false }
    render()
  }
  button.addEventListener('click', () => {
    const input = options.current()
    if (!input || busy || !ready) return
    busy = true; render()
    const selected = saved.has(input.word.toLowerCase())
    void (selected ? api.removeVocabulary(input.word.toLowerCase()) : api.addVocabulary(input))
      .then(async () => {
        await refresh()
        options.message(options.t(selected ? 'vocabulary.removed' : 'vocabulary.added'))
      }).catch(() => options.message(options.t('vocabulary.error')))
      .finally(() => { busy = false; render() })
  })
  api.onVocabularyChanged(() => { void refresh() })
  document.addEventListener('locale:changed', render)
  void refresh()
  return { render }
}
