import assert from 'node:assert/strict'
import test from 'node:test'
import { DSH_REGISTRIES, fetchLatestDshVersion, registryDisplayName, resolveDshRegistries, stripTrailingSlashes } from '../src/dsh-registry.mjs'

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

// 安全守卫：版本号是唯一会进入 npm 安装参数的外部数据，被投毒的软件源不能借它
// 构造任意的 npm spec；非法版本必须被跳过并继续尝试下一个源。
test('skips a registry that returns a version that is not valid semver', async () => {
  const visited = []
  const fetchImpl = async (url) => {
    visited.push(url)
    if (url.startsWith('https://registry.npmjs.org')) {
      return Response.json({ version: '1.2.3 || rm -rf /' })
    }
    return Response.json({ version: '1.2.3' })
  }

  const result = await fetchLatestDshVersion({
    fetchImpl,
    registries: resolveDshRegistries({}),
  })

  assert.equal(visited.length, 2)
  assert.deepEqual(result, { version: '1.2.3', registry: 'https://registry.npmmirror.com' })
})

// 安全守卫：自定义源会决定装哪个包，明文 http 与 file: 都不允许（本机 http 例外）。
test('ignores an insecure custom registry override', () => {
  for (const unsafe of [
    'http://npm.example.com',
    'file:///tmp/fake-registry',
    'ftp://npm.example.com',
    'not a url',
  ]) {
    const registries = resolveDshRegistries({ DSH_DESKTOP_NPM_REGISTRY: unsafe })
    assert.equal(registries[0].base, 'https://registry.npmjs.org', `应忽略 ${unsafe}`)
    assert.equal(registries.length, DSH_REGISTRIES.length)
  }

  const local = resolveDshRegistries({ DSH_DESKTOP_NPM_REGISTRY: 'http://127.0.0.1:4873' })
  assert.equal(local[0].base, 'http://127.0.0.1:4873')
})

// 安全守卫：私有源 URL 可能带 basic auth 凭据，展示时必须脱敏。
test('never shows registry credentials in status text', () => {
  assert.equal(registryDisplayName('https://user:secret@npm.example.com/path'), 'npm.example.com')
  assert.equal(registryDisplayName('not a url'), '未知软件源')
})
