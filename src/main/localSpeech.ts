import { EventEmitter } from 'node:events'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { get } from 'node:https'
import { isLocalSpeechVoice, type LocalSpeechResult, type LocalSpeechStatus } from '../shared/localSpeech'

interface Job {
  finish(result: LocalSpeechResult): void
  chunk(bytes: Uint8Array): void
  timer: ReturnType<typeof setTimeout>
  cacheKey: string
  chunks: Uint8Array[]
  bytes: number
}
interface Options {
  root: string; helpers: string; platform?: string; arch?: string; uvPath?: string
  spawnWorker?: (python: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcessWithoutNullStreams
}
const VERSION = 1

/** Private local worker, shared warm model, bounded cache, and caller-scoped cancellation. */
export class LocalSpeechEngine extends EventEmitter {
  private worker: ChildProcessWithoutNullStreams | null = null
  private setupProcess: ChildProcessWithoutNullStreams | null = null
  private loading: Promise<void> | null = null
  private installing: Promise<LocalSpeechStatus> | null = null
  private idle: ReturnType<typeof setTimeout> | null = null
  private jobs = new Map<string, Job>()
  private cache = new Map<string, Uint8Array[]>()
  private cacheBytes = 0
  private setupAbort = false
  private setupController: AbortController | null = null
  private disposed = false
  private expectedExits = new WeakSet<ChildProcessWithoutNullStreams>()
  private supported: boolean
  private state: LocalSpeechStatus

  constructor(private readonly options: Options) {
    super()
    this.supported = (options.platform ?? process.platform) === 'darwin' && (options.arch ?? process.arch) === 'arm64'
    const installed = this.isInstalled()
    this.state = { phase: this.supported ? installed ? 'installed' : 'not-installed' : 'unsupported', installed }
  }
  private get python(): string { return join(this.options.root, 'runtime/bin/python') }
  private get model(): string { return join(this.options.root, 'model') }
  private isInstalled(): boolean {
    try {
      const info = JSON.parse(readFileSync(join(this.options.root, 'installed.json'), 'utf8'))
      return info.version === VERSION && existsSync(this.python) && existsSync(join(this.model, 'model.safetensors')) && existsSync(join(this.model, 'speech_tokenizer/model.safetensors'))
    } catch { return false }
  }
  status(): LocalSpeechStatus { return { ...this.state } }
  private update(state: LocalSpeechStatus): void { this.state = state; this.emit('status', this.status()) }

  private command(command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { env: { ...process.env, UV_PYTHON_INSTALL_DIR: join(this.options.root, 'python') }, stdio: 'pipe' })
      this.setupProcess = child
      let errorTail = ''
      child.stdout.on('data', () => {})
      child.stderr.on('data', data => { errorTail = (errorTail + String(data)).slice(-3000) })
      child.once('error', reject)
      child.once('exit', code => {
        if (this.setupProcess === child) this.setupProcess = null
        if (code === 0 && !this.setupAbort) resolve()
        else { console.warn('[local-speech] Runtime setup failed:', errorTail.slice(-800)); reject(new Error('setup_failed')) }
      })
    })
  }
  private async locateUv(): Promise<string> {
    for (const path of [this.options.uvPath, join(this.options.root, 'uv/uv'), '/opt/homebrew/bin/uv', '/usr/local/bin/uv', join(process.env.HOME ?? '', '.local/bin/uv'), '/opt/miniconda3/bin/uv']) {
      if (path && existsSync(path)) return path
    }
    // Official standalone uv, installed only inside this app's data directory.
    const response = await download('https://github.com/astral-sh/uv/releases/download/0.11.7/uv-aarch64-apple-darwin.tar.gz', 0, this.setupController?.signal)
    if (this.setupAbort) throw new Error('cancelled')
    const archive = join(this.options.root, 'uv.tar.gz')
    await writeFile(archive, response)
    const target = join(this.options.root, 'uv')
    await mkdir(target, { recursive: true })
    await this.command('/usr/bin/tar', ['-xzf', archive, '-C', target, '--strip-components=1'])
    return join(target, 'uv')
  }
  install(): Promise<LocalSpeechStatus> {
    if (!this.supported) return Promise.resolve(this.status())
    if (this.installing) return this.installing
    this.setupAbort = false
    this.setupController = new AbortController()
    this.installing = (async () => {
      try {
        if (!this.isInstalled()) {
          this.update({ phase: 'installing', installed: false })
          await mkdir(this.options.root, { recursive: true, mode: 0o700 })
          const uv = await this.locateUv()
          if (this.setupAbort) throw new Error('cancelled')
          if (!existsSync(this.python)) await this.command(uv, ['venv', '--python', '3.12', join(this.options.root, 'runtime')])
          if (this.setupAbort) throw new Error('cancelled')
          await this.command(uv, ['pip', 'install', '--python', this.python, '-r', join(this.options.helpers, 'requirements.txt')])
        }
        if (this.setupAbort) throw new Error('cancelled')
        await this.startWorker(!this.isInstalled())
        await writeFile(join(this.options.root, 'installed.json.tmp'), JSON.stringify({ version: VERSION }), { mode: 0o600 })
        await rename(join(this.options.root, 'installed.json.tmp'), join(this.options.root, 'installed.json'))
        this.update({ phase: 'ready', installed: true })
        this.scheduleIdle()
      } catch {
        this.update({ phase: this.setupAbort ? this.isInstalled() ? 'installed' : 'not-installed' : 'error', installed: this.isInstalled(), error: this.setupAbort ? 'cancelled' : 'setup_failed' })
      } finally { this.installing = null; this.setupController = null }
      return this.status()
    })()
    return this.installing
  }
  cancelInstall(): void {
    this.setupAbort = true
    this.setupController?.abort()
    this.setupProcess?.kill('SIGTERM')
    this.shutdownWorker()
  }

  private startWorker(prepare = false): Promise<void> {
    if (this.loading) return this.loading
    if (this.worker && this.state.phase === 'ready') return Promise.resolve()
    this.update({ phase: prepare ? 'downloading' : 'loading', installed: this.isInstalled() })
    this.loading = new Promise<void>((resolve, reject) => {
      const args = ['-u', join(this.options.helpers, 'worker.py'), '--model-dir', this.model]
      if (prepare) args.push('--prepare')
      const env = { ...process.env, HF_HUB_DISABLE_TELEMETRY: '1', HF_HUB_OFFLINE: prepare ? '0' : '1' }
      const child = this.options.spawnWorker?.(this.python, args, env) ?? spawn(this.python, args, { env, stdio: 'pipe' })
      this.worker = child
      let ready = false
      let tail = ''
      const timeout = setTimeout(() => { child.kill(); reject(new Error('startup_failed')) }, prepare ? 30 * 60000 : 120000)
      child.stderr.on('data', data => { tail = (tail + String(data)).slice(-1600) })
      const lines = createInterface({ input: child.stdout })
      lines.on('line', line => {
        if (line.length > 2 * 1024 * 1024) { child.kill(); return }
        try {
          const value = JSON.parse(line)
          if (value.type === 'ready') {
            ready = true; clearTimeout(timeout); this.update({ phase: 'ready', installed: this.isInstalled() }); resolve()
          } else if (value.type === 'progress' && ['downloading', 'loading'].includes(value.phase)) {
            this.update({ phase: value.phase, installed: this.isInstalled(), progress: typeof value.progress === 'number' ? Math.max(0, Math.min(100, value.progress)) : undefined })
          } else this.receive(value)
        } catch { /* Non-protocol library output cannot become a speech event. */ }
      })
      const fail = (): void => {
        clearTimeout(timeout); lines.close()
        if (this.worker !== child) return
        this.worker = null; this.loading = null
        if (!ready) { console.warn('[local-speech] Model startup failed:', tail); reject(new Error('startup_failed')) }
        for (const id of this.jobs.keys()) this.finish(id, { ok: false, error: 'unavailable' })
        if (!this.setupAbort && !this.expectedExits.has(child)) this.update({ phase: 'error', installed: this.isInstalled(), error: 'startup_failed' })
      }
      child.once('error', fail); child.once('exit', fail)
    }).finally(() => { this.loading = null })
    return this.loading
  }

  async warmup(): Promise<void> {
    if (!this.supported || !this.isInstalled()) return
    try { await this.startWorker(); this.scheduleIdle() } catch { /* Status already reports the failed startup. */ }
  }

  private receive(value: { type: string; id?: string; audio?: string; code?: string }): void {
    if (!value.id) return
    const job = this.jobs.get(value.id)
    if (!job) return
    if (value.type === 'chunk' && typeof value.audio === 'string') {
      const bytes = new Uint8Array(Buffer.from(value.audio, 'base64'))
      if (!bytes.length || bytes.length > 1024 * 1024) return
      job.bytes += bytes.length
      if (job.bytes > 24 * 1024 * 1024) { this.cancel(value.id); return }
      job.chunks.push(bytes); job.chunk(bytes)
    } else if (value.type === 'done') {
      if (job.bytes && job.bytes < 8 * 1024 * 1024) {
        while (this.cacheBytes + job.bytes > 16 * 1024 * 1024 || this.cache.size >= 20) {
          const oldest = this.cache.keys().next().value as string | undefined
          if (!oldest) break
          this.cacheBytes -= this.cache.get(oldest)!.reduce((sum, chunk) => sum + chunk.length, 0); this.cache.delete(oldest)
        }
        this.cache.set(job.cacheKey, job.chunks); this.cacheBytes += job.bytes
      }
      this.finish(value.id, { ok: job.bytes > 0, error: job.bytes ? undefined : 'unavailable' })
    } else if (value.type === 'failed') this.finish(value.id, { ok: false, error: value.code === 'cancelled' ? 'cancelled' : 'unavailable' })
  }
  synthesize(id: string, text: string, voice: unknown, chunk: (audio: Uint8Array) => void): Promise<LocalSpeechResult> {
    if (!this.supported) return Promise.resolve({ ok: false, error: 'unsupported' })
    if (!text.trim() || text.length > 5000 || !isLocalSpeechVoice(voice) || !id || id.length > 100) return Promise.resolve({ ok: false, error: 'invalid-request' })
    if (!this.isInstalled()) return Promise.resolve({ ok: false, error: 'not-installed' })
    if (this.jobs.has(id) || this.jobs.size >= 4) return Promise.resolve({ ok: false, error: 'busy' })
    if (this.idle) clearTimeout(this.idle)
    const cacheKey = `${voice}:${text}`
    const cached = this.cache.get(cacheKey)
    if (cached) { this.cache.delete(cacheKey); this.cache.set(cacheKey, cached); for (const bytes of cached) chunk(bytes); this.scheduleIdle(); return Promise.resolve({ ok: true }) }
    return new Promise(resolve => {
      this.jobs.set(id, { finish: resolve, chunk, cacheKey, chunks: [], bytes: 0, timer: setTimeout(() => this.cancel(id), 5 * 60000) })
      void this.startWorker().then(() => {
        if (this.jobs.has(id)) this.worker?.stdin.write(`${JSON.stringify({ type: 'synthesize', id, text, voice })}\n`)
      }).catch(() => this.finish(id, { ok: false, error: 'unavailable' }))
    })
  }
  cancel(id: string): void {
    if (!this.jobs.has(id)) return
    this.worker?.stdin.write(`${JSON.stringify({ type: 'cancel', id })}\n`)
    this.finish(id, { ok: false, error: 'cancelled' })
  }
  private finish(id: string, result: LocalSpeechResult): void {
    const job = this.jobs.get(id)
    if (!job) return
    clearTimeout(job.timer); this.jobs.delete(id); job.finish(result); this.scheduleIdle()
  }
  private scheduleIdle(): void {
    if (this.jobs.size || this.disposed) return
    if (this.idle) clearTimeout(this.idle)
    this.idle = setTimeout(() => { this.shutdownWorker(); this.update({ phase: 'installed', installed: true }) }, 3 * 60000)
    this.idle.unref()
  }
  private shutdownWorker(): void {
    const child = this.worker
    if (child) { this.expectedExits.add(child); child.stdin.end(); child.kill('SIGTERM') }
  }
  dispose(): void {
    this.disposed = true
    this.setupAbort = true
    this.setupController?.abort()
    if (this.idle) clearTimeout(this.idle)
    for (const id of this.jobs.keys()) this.cancel(id)
    this.setupProcess?.kill('SIGTERM'); this.shutdownWorker()
  }
}

function download(url: string, redirects = 0, signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (redirects > 5) { reject(new Error('download_failed')); return }
    if (signal?.aborted) { reject(new Error('cancelled')); return }
    const request = get(url, response => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume(); download(new URL(response.headers.location, url).href, redirects + 1, signal).then(resolve, reject); return
      }
      if (response.statusCode !== 200) { response.resume(); reject(new Error('download_failed')); return }
      const chunks: Buffer[] = []; let length = 0
      response.on('data', (data: Buffer) => { length += data.length; if (length > 30 * 1024 * 1024) response.destroy(new Error('download_too_large')); else chunks.push(data) })
      response.on('end', () => resolve(Buffer.concat(chunks))); response.on('error', reject)
    })
    request.setTimeout(60000, () => request.destroy(new Error('download_timeout'))); request.on('error', reject)
    const abort = (): void => { request.destroy(new Error('cancelled')) }
    signal?.addEventListener('abort', abort, { once: true })
    request.once('close', () => signal?.removeEventListener('abort', abort))
  })
}
