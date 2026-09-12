import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchLatestDshVersion, resolveDshRegistries, stripTrailingSlashes } from '../src/dsh-registry.mjs'

test('strips trailing slashes without relying on a regexp', () => {
  assert.equal(stripTrailingSlashes('https://a.example'), 'https://a.example')
  assert.equal(stripTrailingSlashes('https://a.example/'), 'https://a.example')
  assert.equal(stripTrailingSlashes('https://a.example///'), 'https://a.example')
  assert.equal(stripTrailingSlashes(''), '')
  assert.equal(stripTrailingSlashes('/'), '')
})

test('prefers the official registry and keeps the mirror as fallback', () => {
  const registries = resolveDshRegistries({})

  assert.equal(registries[0].base, 'https://registry.npmjs.org')
  assert.equal(registries[1].base, 'https://registry.npmmirror.com')
  assert.match(registries[0].metadata, /@deepseek-ai%2fdsh\/latest$/)
})

test('honours a custom registry override', () => {
  const registries = resolveDshRegistries({ DSH_DESKTOP_NPM_REGISTRY: 'https://npm.example.com/' })

  assert.equal(registries[0].name, 'custom')
  assert.equal(registries[0].base, 'https://npm.example.com')
  assert.equal(registries[0].metadata, 'https://npm.example.com/@deepseek-ai%2fdsh/latest')
  assert.equal(registries[1].base, 'https://registry.npmjs.org')
})

test('falls back to the mirror when the official registry is unreachable', async () => {
  const visited = []
  const fetchImpl = async (url) => {
    visited.push(url)
    if (url.startsWith('https://registry.npmjs.org')) throw new Error('network unreachable')
    return Response.json({ version: '9.9.9' })
  }

  const result = await fetchLatestDshVersion({
    fetchImpl,
    registries: resolveDshRegistries({}),
  })

  assert.deepEqual(result, { version: '9.9.9', registry: 'https://registry.npmmirror.com' })
  assert.equal(visited.length, 2)
})

test('reports the HTTP failure when a registry answers with an error status', async () => {
  const fetchImpl = async () => new Response('nope', { status: 503 })

  await assert.rejects(
    fetchLatestDshVersion({
      fetchImpl,
      registries: resolveDshRegistries({}),
    }),
    /HTTP 503/,
  )
})

test('rejects invalid metadata payloads', async () => {
  const fetchImpl = async () => Response.json({ name: '@deepseek-ai/dsh' })

  await assert.rejects(
    fetchLatestDshVersion({ fetchImpl, registries: resolveDshRegistries({}) }),
    /版本信息无效/,
  )
})

test('rejects an empty registry list', async () => {
  await assert.rejects(fetchLatestDshVersion({ fetchImpl: async () => {}, registries: [] }), /没有配置/)
})
