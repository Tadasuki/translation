export const LOCAL_SPEECH_VOICES = ['serena', 'vivian', 'uncle_fu', 'ryan', 'aiden', 'ono_anna', 'sohee', 'eric', 'dylan'] as const
export type LocalSpeechVoice = typeof LOCAL_SPEECH_VOICES[number]
export function isLocalSpeechVoice(value: unknown): value is LocalSpeechVoice {
  return typeof value === 'string' && (LOCAL_SPEECH_VOICES as readonly string[]).includes(value)
}
export interface LocalSpeechStatus {
  phase: 'unsupported' | 'not-installed' | 'installing' | 'downloading' | 'installed' | 'loading' | 'ready' | 'error'
  installed: boolean
  progress?: number
  error?: 'setup_failed' | 'startup_failed' | 'cancelled'
}
export interface LocalSpeechChunk { requestId: string; audio: Uint8Array }
export interface LocalSpeechResult { ok: boolean; error?: 'not-installed' | 'unsupported' | 'cancelled' | 'unavailable' | 'invalid-request' | 'busy' }
