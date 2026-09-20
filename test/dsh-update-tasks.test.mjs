import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { readDshUpdateCache, writeDshUpdateCache } from '../src/dsh-runtime.mjs'
import { readDshUpdateNotice } from '../src/updates/dsh-update.mjs'
import { createInstallRunner, createVersionResolver } from '../src/updates/dsh-update-tasks.mjs'

async function createTempUserData() {
  return mkdtemp(path.join(os.tmpdir(), 'dsh-update-tasks-'))
}

test('reuses a fresh version cache without touching the network', async () => {
  const userDataPath = await createTempUserData()
  const cachePath = path.join(userDataPath, 'cache', 'dsh-update.json')
  try {
    await writeDshUpdateCache(cachePath, '1.2.3', Date.now(), true, 'https://registry.npmjs.org')
    let fetched = 0
    const statuses = []
    const resolver = createVersionResolver({
      fetchImpl: async () => {
        fetched += 1
        return Response.json({ version: '9.9.9' })
      },
      reportStatus: (status) => statuses.push(status),
      cachePath,
    })

    const result = await resolver.resolve({ installedVersion: '1.2.2' })

    assert.deepEqual(result, {
      version: '1.2.3',
      registry: 'https://registry.npmjs.org',
      stale: false,
    })
    assert.equal(fetched, 0)
    assert.match(statuses[0].detail, /复用最近检查结果 1\.2\.3/)
  } finally {
    await rm(userDataPath, { recursive: true, force: true })
  }
})

test('falls back to the last known version when every registry is unreachable', async () => {
  const userDataPath = await createTempUserData()
  const cachePath = path.join(userDataPath, 'cache', 'dsh-update.json')
  try {
    await writeDshUpdateCache(cachePath, '1.2.3', Date.now(), true, 'https://registry.npmjs.org')
    const statuses = []
    const resolver = createVersionResolver({
      fetchImpl: async () => {
        throw new Error('offline')
      },
      reportStatus: (status) => statuses.push(status),
      cachePath,
    })

    const result = await resolver.resolve({ installedVersion: '1.1.0', force: true })

    assert.deepEqual(result, {
      version: '1.2.3',
      registry: 'https://registry.npmjs.org',
      // stale=true：结果来自缓存而不是刚联网查到，调用方不能据此宣称"已是最新版本"。
      stale: true,
    })
    assert.equal(statuses.some((status) => /无法联网检查/.test(status.message)), true)
    // 失败结果按 5 分钟短期缓存写回，避免频繁重试。
    const cached = await readDshUpdateCache(cachePath)
    assert.equal(cached.successful, false)
  } finally {
    await rm(userDataPath, { recursive: true, force: true })
  }
})

test('keeps the installed version when the check fails and nothing is cached', async () => {
  const userDataPath = await createTempUserData()
  try {
    const resolver = createVersionResolver({
      fetchImpl: async () => {
        throw new Error('offline')
      },
      reportStatus: () => {},
      cachePath: path.join(userDataPath, 'cache', 'dsh-update.json'),
    })

    const result = await resolver.resolve({ installedVersion: '1.1.0', force: true })

    assert.deepEqual(result, { version: '1.1.0', registry: null, stale: true })
  } finally {
    await rm(userDataPath, { recursive: true, force: true })
  }
})

test('reports elapsed progress, the install result, and clears the notice', async () => {
  const userDataPath = await createTempUserData()
  const noticePath = path.join(userDataPath, 'cache', 'dsh-update-notice.json')
  try {
    await mkdir(path.dirname(noticePath), { recursive: true })
    await writeFile(noticePath, JSON.stringify({ notifiedVersion: '1.2.3', notifiedAt: 1 }))
    const statuses = []
    const changed = []
    const runner = createInstallRunner({
      installDsh: async ({ version }) => ({
        source: 'global',
        version,
        binDir: '/npm/bin',
        binPath: '/npm/bin/dsh.js',
      }),
      reportStatus: (status) => statuses.push(status),
      onInstallationChanged: (installation) => changed.push(installation.version),
      noticePath,
    })

    const installation = await runner.install({
      nodeEnvironment: { source: 'system' },
      env: {},
      version: '1.2.3',
      registry: null,
      isUpdate: true,
    })

    assert.equal(installation.version, '1.2.3')
    assert.deepEqual(changed, ['1.2.3'])
    assert.equal(statuses[0].message, '正在更新 DeepSeek Harness')
    assert.match(
      statuses[0].detail,
      /用户全局环境 · @deepseek-ai\/dsh@1\.2\.3 · 已用时 \d+ 秒/,
    )

    await runner.clearNotice()
    assert.equal(await readDshUpdateNotice(noticePath), null)
    runner.dispose()
  } finally {
    await rm(userDataPath, { recursive: true, force: true })
  }
})

test('labels private-runtime installs and rejects an empty npm result', async () => {
  const userDataPath = await createTempUserData()
  const statuses = []
  try {
    const runner = createInstallRunner({
      installDsh: async () => null,
      reportStatus: (status) => statuses.push(status),
      noticePath: path.join(userDataPath, 'cache', 'dsh-update-notice.json'),
    })

    await assert.rejects(
      runner.install({ nodeEnvironment: { source: 'managed' }, env: {}, version: '1.2.3' }),
      /未找到 dsh 全局安装/,
    )
    assert.equal(statuses[0].message, '正在安装 DeepSeek Harness')
    assert.match(statuses[0].detail, /应用私有环境/)
  } finally {
    await rm(userDataPath, { recursive: true, force: true })
  }
})

test('never fails the update because the notice file could not be removed', async () => {
  const userDataPath = await createTempUserData()
  const noticePath = path.join(userDataPath, 'cache', 'dsh-update-notice.json')
  try {
    // 让 noticePath 是个目录：rm(force) 会失败，但必须被吞掉（提示记录只是节流用）。
    await mkdir(noticePath, { recursive: true })
    const runner = createInstallRunner({
      installDsh: async () => ({}),
      reportStatus: () => {},
      noticePath,
    })

    await assert.doesNotReject(runner.clearNotice())
  } finally {
    await rm(userDataPath, { recursive: true, force: true })
  }
})
