import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { LocalSpeechEngine } from '../src/main/localSpeech'
import { normalizeSettings } from '../src/shared/settingsDefaults'

async function fixture(ready = true) {
  const root = await mkdtemp(join(tmpdir(), 'local-speech-'))
  for (const directory of ['runtime/bin', 'model/speech_tokenizer']) await mkdir(join(root, directory), { recursive: true })
  for (const file of ['runtime/bin/python', 'model/model.safetensors', 'model/speech_tokenizer/model.safetensors']) await writeFile(join(root, file), '')
  await writeFile(join(root, 'installed.json'), '{"version":1}')
  const commands: { type: string; id: string }[] = []
  const child = new EventEmitter() as ChildProcessWithoutNullStreams
  child.stdout = new PassThrough(); child.stderr = new PassThrough()
  child.stdin = new Writable({ write(data, _encoding, done) { commands.push(JSON.parse(String(data))); done() } })
  child.kill = () => { queueMicrotask(() => child.emit('exit', 0)); return true }
  const emit = (value: unknown) => (child.stdout as PassThrough).write(`${JSON.stringify(value)}\n`)
  let launches = 0
  const engine = new LocalSpeechEngine({ root, helpers: root, platform: 'darwin', arch: 'arm64', spawnWorker: () => {
    launches++; if (ready) queueMicrotask(() => emit({ type: 'ready' })); return child
  } })
  const tick = () => new Promise<void>(resolve => setImmediate(resolve))
  return { root, engine, child, commands, emit, tick, launches: () => launches,
    async cleanup() { engine.dispose(); await tick(); await rm(root, { recursive: true, force: true }) } }
}

test('local speech streams in order, caches repeats and isolates request IDs', async () => {
  const f = await fixture()
  try {
    const chunks: number[] = []
    const result = f.engine.synthesize('1:first', 'hello', 'ryan', bytes => chunks.push(bytes[0]))
    await f.tick()
    f.emit({ type: 'chunk', id: '2:other', audio: Buffer.from([99]).toString('base64') })
    for (const value of [1, 2]) f.emit({ type: 'chunk', id: '1:first', audio: Buffer.from([value]).toString('base64') })
    f.emit({ type: 'done', id: '1:first' })
    assert.equal((await result).ok, true); assert.deepEqual(chunks, [1, 2])
    const replay: number[] = []
    assert.equal((await f.engine.synthesize('1:second', 'hello', 'ryan', bytes => replay.push(bytes[0]))).ok, true)
    assert.deepEqual(replay, [1, 2]); assert.equal(f.launches(), 1)
    assert.equal(f.commands.filter(command => command.type === 'synthesize').length, 1)
  } finally { await f.cleanup() }
})

test('cancelling while the model loads suppresses synthesis and late audio', async () => {
  const f = await fixture(false)
  try {
    let chunks = 0
    const result = f.engine.synthesize('1:cancel', 'hello', 'ryan', () => chunks++)
    f.engine.cancel('1:cancel')
    assert.equal((await result).error, 'cancelled')
    f.emit({ type: 'ready' }); await f.tick()
    f.emit({ type: 'chunk', id: '1:cancel', audio: Buffer.from([4]).toString('base64') })
    assert.equal(chunks, 0)
    assert.equal(f.commands.filter(command => command.type === 'synthesize').length, 0)
  } finally { await f.cleanup() }
})

test('worker failures release callers and invalid input never reaches the worker', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.engine.synthesize('bad', 'hello', 'arbitrary-voice', () => {})).error, 'invalid-request')
    assert.equal((await f.engine.synthesize('empty', '', 'ryan', () => {})).error, 'invalid-request')
    const result = f.engine.synthesize('1:crash', 'hello', 'ryan', () => {})
    await f.tick(); f.child.emit('exit', 1)
    assert.equal((await result).error, 'unavailable')
    assert.equal(f.engine.status().phase, 'error')
  } finally { await f.cleanup() }
})

test('local speech settings safely migrate without changing existing voice preference', () => {
  const settings = normalizeSettings({ speechProvider: 'edge' })
  assert.equal(settings.speechProvider, 'edge')
  assert.equal(settings.localSpeechVoice, 'serena'); assert.equal(settings.localSpeechEnglishVoice, 'ryan')
  const local = normalizeSettings({ ...settings, speechProvider: 'local', localSpeechVoice: 'vivian' })
  assert.equal(local.speechProvider, 'local'); assert.equal(local.localSpeechVoice, 'vivian')
})
