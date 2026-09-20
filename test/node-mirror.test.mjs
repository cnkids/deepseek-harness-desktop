import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getNodeDistMirrors,
  NODE_DIST_MIRRORS,
  resolveNodeDistMirror,
} from '../src/node-runtime.mjs'

test('lists the official source first and the domestic mirror second', () => {
  const mirrors = getNodeDistMirrors({})

  assert.match(mirrors[0], /^https:\/\/nodejs\.org\/dist\/v/)
  assert.match(mirrors[1], /^https:\/\/cdn\.npmmirror\.com\/binaries\/node\/v/)
  assert.deepEqual(mirrors, [...NODE_DIST_MIRRORS])
})

test('honours a custom mirror override', () => {
  const mirrors = getNodeDistMirrors({ DSH_DESKTOP_NODE_MIRROR: 'https://mirror.example.com/node/' })

  assert.equal(mirrors[0], 'https://mirror.example.com/node')
  assert.equal(mirrors[1], NODE_DIST_MIRRORS[0])
})

// 安全守卫：镜像决定下载哪个 Node.js 运行时，明文 http / file: 一律忽略。
test('ignores an insecure custom mirror override', () => {
  for (const unsafe of ['http://mirror.example.com', 'file:///tmp/node', 'nonsense']) {
    const mirrors = getNodeDistMirrors({ DSH_DESKTOP_NODE_MIRROR: unsafe })
    assert.deepEqual(mirrors, [...NODE_DIST_MIRRORS], `应忽略 ${unsafe}`)
  }

  const local = getNodeDistMirrors({ DSH_DESKTOP_NODE_MIRROR: 'http://localhost:8080/node' })
  assert.equal(local[0], 'http://localhost:8080/node')
})

test('probes SHASUMS256.txt with HEAD before downloading', async () => {
  const visited = []
  const fetchImpl = async (url, options) => {
    visited.push({ url, method: options?.method })
    return new Response(null, { status: 200 })
  }

  const baseUrl = await resolveNodeDistMirror({ fetchImpl, env: {} })

  assert.equal(baseUrl, NODE_DIST_MIRRORS[0])
  assert.deepEqual(visited, [
    { url: `${NODE_DIST_MIRRORS[0]}/SHASUMS256.txt`, method: 'HEAD' },
  ])
})

test('falls back to the domestic mirror when the official source throws', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('nodejs.org')) throw new Error('ENOTFOUND')
    return new Response(null, { status: 200 })
  }

  assert.equal(await resolveNodeDistMirror({ fetchImpl, env: {} }), NODE_DIST_MIRRORS[1])
})

test('falls back when the official source answers with an error status', async () => {
  const fetchImpl = async (url) =>
    new Response(null, { status: url.includes('nodejs.org') ? 503 : 200 })

  assert.equal(await resolveNodeDistMirror({ fetchImpl, env: {} }), NODE_DIST_MIRRORS[1])
})

test('tries a custom mirror before the built-in ones', async () => {
  const visited = []
  const fetchImpl = async (url) => {
    visited.push(url)
    if (url.startsWith('https://mirror.example.com')) return new Response(null, { status: 200 })
    throw new Error('unreachable')
  }

  const baseUrl = await resolveNodeDistMirror({
    fetchImpl,
    env: { DSH_DESKTOP_NODE_MIRROR: 'https://mirror.example.com' },
  })

  assert.equal(baseUrl, 'https://mirror.example.com')
  assert.equal(visited.length, 1)
})

test('keeps the preferred source when every mirror fails', async () => {
  const fetchImpl = async () => {
    throw new Error('offline')
  }

  assert.equal(await resolveNodeDistMirror({ fetchImpl, env: {} }), NODE_DIST_MIRRORS[0])
})
