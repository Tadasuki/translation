import type { Api, Settings } from '../../shared/types'
import { isLocalSpeechVoice, type LocalSpeechStatus } from '../../shared/localSpeech'
import { createLocalSpeechPlayback } from './localSpeechPlayback'

export function startLocalSpeechSettings(api: Api, t: (key: string, params?: Record<string, string | number>) => string): void {
  const root = document.getElementById('local-speech-controls')!
  const status = document.getElementById('local-speech-status')!
  const progress = document.getElementById('local-speech-progress') as HTMLProgressElement
  const install = document.getElementById('local-speech-install') as HTMLButtonElement
  const cancel = document.getElementById('local-speech-install-cancel') as HTMLButtonElement
  const chinese = document.getElementById('local-speech-voice') as HTMLSelectElement
  const english = document.getElementById('local-speech-english-voice') as HTMLSelectElement
  const previewChinese = document.getElementById('local-speech-preview-zh') as HTMLButtonElement
  const previewEnglish = document.getElementById('local-speech-preview-en') as HTMLButtonElement
  const provider = document.getElementById('speech-provider') as HTMLSelectElement
  let current: LocalSpeechStatus = { phase: 'not-installed', installed: false }
  let busy = false, message = ''
  let selectedProvider = 'system'
  const player = createLocalSpeechPlayback(api, { t: key => t(key), onSpeakingChange: () => render() })
  const render = (): void => {
    root.hidden = selectedProvider !== 'local'
    const installing = ['installing', 'downloading', 'loading'].includes(current.phase)
    status.textContent = message || t(`localSpeech.status.${current.phase}`, { percent: current.progress ?? 0 })
    install.textContent = t(current.installed ? 'localSpeech.enable' : 'localSpeech.install')
    install.disabled = installing || busy || current.phase === 'unsupported'
    cancel.hidden = !busy || !installing
    progress.hidden = current.phase !== 'downloading'
    progress.value = current.progress ?? 0
    chinese.disabled = english.disabled = installing || busy
    previewChinese.disabled = previewEnglish.disabled = !current.installed || busy || (installing && !player.isSpeaking())
    previewChinese.textContent = t(player.isSpeaking() ? 'localSpeech.stop' : 'localSpeech.previewZh')
    previewEnglish.textContent = t(player.isSpeaking() ? 'localSpeech.stop' : 'localSpeech.previewEn')
  }
  const sync = (settings: Settings): void => { selectedProvider = settings.speechProvider; chinese.value = settings.localSpeechVoice; english.value = settings.localSpeechEnglishVoice; render() }
  const saveVoice = async (field: 'localSpeechVoice' | 'localSpeechEnglishVoice', value: string): Promise<void> => {
    if (!isLocalSpeechVoice(value)) return
    player.stop(); busy = true; message = ''; render()
    try { sync(await api.setSettings({ [field]: value })) } catch { message = t('localSpeech.saveFailed') }
    finally { busy = false; render() }
  }
  chinese.addEventListener('change', () => { void saveVoice('localSpeechVoice', chinese.value) })
  english.addEventListener('change', () => { void saveVoice('localSpeechEnglishVoice', english.value) })
  install.addEventListener('click', () => {
    busy = true; message = ''; render()
    void api.installLocalSpeech().then(value => { current = value }).catch(() => { message = t('localSpeech.saveFailed') }).finally(() => { busy = false; render() })
  })
  cancel.addEventListener('click', () => api.cancelLocalSpeechInstall())
  const preview = async (language: 'ZH' | 'EN'): Promise<void> => {
    if (player.isSpeaking()) { player.stop(); return }
    message = t('localSpeech.previewLoading'); render()
    const result = await player.start(t(language === 'ZH' ? 'localSpeech.previewTextZh' : 'localSpeech.previewTextEn'), language)
    message = result.ok ? '' : result.error ?? ''; render()
  }
  previewChinese.addEventListener('click', () => { void preview('ZH') })
  previewEnglish.addEventListener('click', () => { void preview('EN') })
  provider.addEventListener('change', () => { selectedProvider = provider.value; player.stop(); render() })
  api.onLocalSpeechStatus(value => { current = value; message = ''; render() })
  api.onSettingsChanged(sync)
  document.addEventListener('locale:changed', render)
  window.addEventListener('pagehide', () => player.dispose())
  document.addEventListener('visibilitychange', () => { if (document.hidden) player.stop() })
  void api.getSettings().then(sync)
  void api.getLocalSpeechStatus().then(value => { current = value; render() }).catch(() => { message = t('localSpeech.saveFailed'); render() })
  render()
}
