import assert from 'node:assert/strict'
import test from 'node:test'
import type { Api } from '../src/shared/types'
import type { LocalSpeechChunk, LocalSpeechResult } from '../src/shared/localSpeech'
import type { EdgeAudioContextLike, EdgeBufferSourceLike } from '../src/renderer/src/edgeSpeechPlayback'
import { createLocalSpeechPlayback } from '../src/renderer/src/localSpeechPlayback'

function fixture(suspendResume = false) {
  let listener: (chunk: LocalSpeechChunk) => void = () => {}
  let id = '', resolveRequest: (value: LocalSpeechResult) => void = () => {}
  const sources: EdgeBufferSourceLike[] = [], cancelled: string[] = []
  let decoding: (() => void) | null = null
  const context: EdgeAudioContextLike = {
    currentTime: 0, destination: {}, resume: () => suspendResume ? new Promise<void>(() => {}) : Promise.resolve(), async close() {},
    decodeAudioData: () => new Promise(resolve => { decoding = () => resolve({ duration: 0.5 }) }),
    createBufferSource() {
      const source: EdgeBufferSourceLike = { buffer: null, onended: null, connect() {}, start() {}, stop() {} }
      sources.push(source); return source
    }
  }
  const api = {
    onLocalSpeechChunk(cb: typeof listener) { listener = cb; return () => {} },
    startLocalSpeech(_text: string, _language: string, requestId: string) { id = requestId; return new Promise<LocalSpeechResult>(resolve => { resolveRequest = resolve }) },
    cancelLocalSpeech(requestId: string) { cancelled.push(requestId); resolveRequest({ ok: false, error: 'cancelled' }) }
  } as Pick<Api, 'onLocalSpeechChunk' | 'startLocalSpeech' | 'cancelLocalSpeech'>
  const player = createLocalSpeechPlayback(api, { t: key => key, createAudioContext: () => context })
  return { player, sources, cancelled, emit() { listener({ requestId: id, audio: new Uint8Array([1, 2]) }) },
    decode() { decoding?.() }, done() { resolveRequest({ ok: true }) }, tick: () => new Promise<void>(resolve => setImmediate(resolve)) }
}

test('local playback waits for the final queued audio before completing', async () => {
  const f = fixture(), result = f.player.start('hello', 'EN')
  await f.tick(); f.emit(); await f.tick(); f.decode(); await f.tick(); f.done(); await f.tick()
  assert.equal(f.player.isSpeaking(), true)
  f.sources[0].onended?.(new Event('ended'))
  assert.equal((await result).ok, true); assert.equal(f.player.isSpeaking(), false)
})

test('stopping local playback prevents a late decode from starting audio', async () => {
  const f = fixture(), result = f.player.start('hello', 'EN')
  await f.tick(); f.emit(); await f.tick(); f.player.stop(); f.decode()
  assert.equal((await result).ok, false)
  assert.equal(f.sources.length, 0); assert.equal(f.cancelled.length, 1)
})

test('local playback can be cancelled while browser audio activation is pending', async () => {
  const f = fixture(true), result = f.player.start('hello', 'EN')
  await f.tick(); f.player.stop()
  assert.equal((await result).ok, false)
  assert.equal(f.player.isSpeaking(), false)
})
