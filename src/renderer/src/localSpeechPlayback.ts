import type { Api } from '../../shared/types'
import type { EdgeAudioContextLike, EdgeBufferSourceLike } from './edgeSpeechPlayback'
import type { SpeechStartResult } from './speech'

type SpeechApi = Pick<Api, 'onLocalSpeechChunk' | 'startLocalSpeech' | 'cancelLocalSpeech'>
interface Session {
  id: string
  context: EdgeAudioContextLike
  sources: Set<EdgeBufferSourceLike>
  queue: Promise<void>
  nextTime: number
  failed: boolean
  inputDone: boolean
  cancelled: Promise<void>
  cancel(): void
  finish?: () => void
}

/** Plays streamed local WAV chunks in order; stopping also invalidates late decodes. */
export function createLocalSpeechPlayback(api: SpeechApi, options: {
  t(key: string): string
  createAudioContext?(): EdgeAudioContextLike
  onSpeakingChange?(): void
}) {
  let active: Session | null = null
  const cancelled = (): SpeechStartResult => ({ ok: false, error: options.t('localSpeech.error.cancelled') })
  const stop = (): void => {
    const session = active
    if (!session) return
    active = null
    session.cancel()
    api.cancelLocalSpeech(session.id)
    for (const source of session.sources) { source.onended = null; try { source.stop() } catch { /* already stopped */ } }
    session.sources.clear(); session.finish?.()
    void session.context.close().catch(() => {})
    options.onSpeakingChange?.()
  }
  const unsubscribe = api.onLocalSpeechChunk(chunk => {
    const session = active
    if (!session || session.id !== chunk.requestId) return
    session.queue = session.queue.then(async () => {
      if (active !== session) return
      const audio = new Uint8Array(chunk.audio)
      const buffer = await session.context.decodeAudioData(audio.buffer)
      if (active !== session) return
      const source = session.context.createBufferSource()
      source.buffer = buffer; source.connect(session.context.destination)
      source.onended = () => {
        session.sources.delete(source)
        if (session.inputDone && session.sources.size === 0) session.finish?.()
      }
      session.sources.add(source)
      const when = Math.max(session.context.currentTime + 0.02, session.nextTime)
      session.nextTime = when + buffer.duration
      source.start(when)
    }).catch(() => { session.failed = true; api.cancelLocalSpeech(session.id) })
  })
  return {
    stop,
    dispose(): void { stop(); unsubscribe() },
    isSpeaking(): boolean { return active !== null },
    async start(text: string, language: string): Promise<SpeechStartResult> {
      stop()
      if (!text.trim()) return { ok: false, error: options.t('speech.error.emptyText') }
      let context: EdgeAudioContextLike
      try { context = options.createAudioContext?.() ?? new AudioContext() } catch { return { ok: false, error: options.t('localSpeech.error.unavailable') } }
      let cancel = (): void => {}
      const cancellation = new Promise<void>(resolve => { cancel = resolve })
      const session: Session = { id: `local-${Date.now()}-${Math.random().toString(16).slice(2)}`, context, sources: new Set(), queue: Promise.resolve(), nextTime: 0, failed: false, inputDone: false, cancelled: cancellation, cancel }
      active = session; options.onSpeakingChange?.()
      try {
        await Promise.race([context.resume(), session.cancelled])
        if (active !== session) return cancelled()
        const result = await Promise.race([api.startLocalSpeech(text, language, session.id), session.cancelled.then(() => ({ ok: false, error: 'cancelled' as const }))])
        await Promise.race([session.queue, session.cancelled])
        if (active !== session) return cancelled()
        if (session.failed || !result.ok) return { ok: false, error: options.t(`localSpeech.error.${session.failed ? 'unavailable' : result.error ?? 'unavailable'}`) }
        session.inputDone = true
        if (session.sources.size) await new Promise<void>(resolve => { session.finish = resolve })
        return active === session ? { ok: true } : cancelled()
      } catch { return { ok: false, error: options.t('localSpeech.error.unavailable') } }
      finally { if (active === session) stop() }
    }
  }
}
