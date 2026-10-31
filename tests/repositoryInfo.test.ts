import assert from 'node:assert/strict'
import test from 'node:test'
import { createRepositoryStarsReader, PROJECT_REPOSITORY_URL, ORIGINAL_REPOSITORY_URL } from '../src/main/repositoryInfo'

const response = (stars: unknown) => new Response(JSON.stringify({ stargazers_count: stars }))

test('仓库 Star 数必须使用本项目的公开接口，并支持 0 和有效缓存', async () => {
  let calls = 0
  let now = 0
  const getStars = createRepositoryStarsReader(async (url, init) => {
    assert.equal(url, 'https://api.github.com/repos/Tadasuki/translation')
    assert.ok(init?.signal)
    calls++
    return response(0)
  }, () => now)
  assert.equal(await getStars(), 0)
  assert.equal(await getStars(), 0)
  assert.equal(calls, 1)
  now = 300_001
  assert.equal(await getStars(), 0)
  assert.equal(calls, 2)
  assert.equal(PROJECT_REPOSITORY_URL, 'https://github.com/Tadasuki/translation')
  assert.equal(ORIGINAL_REPOSITORY_URL, 'https://github.com/zhq734/translation')
})

test('同时打开关于页的请求应合并为一次网络读取', async () => {
  let calls = 0
  let finish!: (response: Response) => void
  const getStars = createRepositoryStarsReader(() => {
    calls++
    return new Promise<Response>((resolve) => { finish = resolve })
  })
  const first = getStars()
  const second = getStars()
  assert.equal(first, second)
  finish(response(42))
  assert.deepEqual(await Promise.all([first, second]), [42, 42])
  assert.equal(calls, 1)
})

test('离线和限流时不伪造 0，并保留最近一次有效 Star 数', async () => {
  let now = 0
  let calls = 0
  const getStars = createRepositoryStarsReader(async () => {
    calls++
    if (calls === 1) throw new Error('offline')
    if (calls === 2) return response(17)
    return new Response('', { status: 403 })
  }, () => now)
  assert.equal(await getStars(), null)
  assert.equal(await getStars(), null)
  assert.equal(calls, 1)
  now = 30_001
  assert.equal(await getStars(), 17)
  now = 330_002
  assert.equal(await getStars(), 17)
})

test('Star 数字段应拒绝缺失、负数、小数、字符串和无效响应', async () => {
  for (const invalid of [undefined, -1, 1.5, '12', null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(await createRepositoryStarsReader(async () => response(invalid))(), null)
  }
  assert.equal(await createRepositoryStarsReader(async () => new Response('not-json'))(), null)
})
