import { createTimeoutSignal } from './abortCompatibility'

export const PROJECT_REPOSITORY_URL = 'https://github.com/Tadasuki/translation'
export const MAINTAINER_PROFILE_URL = 'https://github.com/Tadasuki'
export const ORIGINAL_REPOSITORY_URL = 'https://github.com/zhq734/translation'
const REPOSITORY_API_URL = 'https://api.github.com/repos/Tadasuki/translation'

/** 按需读取公开 Star 数；合并并发请求，离线时保留最近一次有效值。 */
export function createRepositoryStarsReader(
  fetch: (url: string, init?: RequestInit) => Promise<Response>,
  now: () => number = Date.now
): () => Promise<number | null> {
  let cached: number | null = null
  let expiresAt = 0
  let pending: Promise<number | null> | null = null
  return () => {
    if (now() < expiresAt) return Promise.resolve(cached)
    if (pending) return pending
    pending = (async () => {
      const timeout = createTimeoutSignal(8000)
      try {
        const response = await fetch(REPOSITORY_API_URL, {
          headers: { accept: 'application/vnd.github+json' },
          signal: timeout.signal
        })
        if (!response.ok) throw new Error('Repository metadata unavailable')
        const data: unknown = await response.json()
        const stars = data && typeof data === 'object'
          ? (data as Record<string, unknown>).stargazers_count
          : undefined
        if (typeof stars !== 'number' || !Number.isSafeInteger(stars) || stars < 0) {
          throw new Error('Invalid repository star count')
        }
        cached = stars
        expiresAt = now() + 5 * 60_000
      } catch {
        expiresAt = now() + 30_000
      } finally {
        timeout.dispose()
      }
      return cached
    })().finally(() => { pending = null })
    return pending
  }
}
