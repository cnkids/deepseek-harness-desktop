import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  buildHarnessEnvironment,
  inspectDshPackage,
  isDshUpdateRequired,
  parseDshLaunchUrl,
  readDshUpdateCache,
  writeDshUpdateCache,
} from '../src/dsh-runtime.mjs'

test('uses the same DSH_HOME as the command-line environment', () => {
  const withoutDshHome = buildHarnessEnvironment(
    { nodePath: '/managed/node/bin/node' },
    ['/global/bin'],
    { PATH: '/usr/bin' },
  )
  assert.equal(Object.hasOwn(withoutDshHome, 'DSH_HOME'), false)
  assert.equal(
    withoutDshHome.PATH,
    ['/managed/node/bin', '/global/bin', '/usr/bin'].join(path.delimiter),
  )

  const withDshHome = buildHarnessEnvironment(
    { nodePath: '/managed/node/bin/node' },
    [],
    { PATH: '/usr/bin', DSH_HOME: '/shared/dsh-home' },
  )
  assert.equal(withDshHome.DSH_HOME, '/shared/dsh-home')
})

test('detects an installed dsh package and its executable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-package-'))
  try {
    await mkdir(path.join(root, 'lib'), { recursive: true })
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: '@deepseek-ai/dsh',
        version: '0.1.0-rc.6',
        bin: { dsh: 'lib/bin.js' },
      }),
    )
    await writeFile(path.join(root, 'lib', 'bin.js'), '#!/usr/bin/env node\n')

    const installation = await inspectDshPackage(root, 'global')
    assert.ok(installation)
    assert.equal(installation.source, 'global')
    assert.equal(installation.version, '0.1.0-rc.6')
    assert.equal(installation.binPath, path.join(root, 'lib', 'bin.js'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects damaged or unrelated global packages', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-package-invalid-'))
  try {
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'another-package', version: '1.0.0', bin: 'bin.js' }),
    )
    assert.equal(await inspectDshPackage(root), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('updates dsh only when the installed version is older', () => {
  assert.equal(isDshUpdateRequired('0.1.0-rc.5', '0.1.0-rc.6'), true)
  assert.equal(isDshUpdateRequired('0.1.0-rc.6', '0.1.0-rc.6'), false)
  assert.equal(isDshUpdateRequired('0.2.0', '0.1.0-rc.6'), false)
  assert.equal(isDshUpdateRequired('invalid', '0.1.0-rc.6'), false)
})

test('persists and validates the dsh update-check cache', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-update-cache-'))
  const cachePath = path.join(root, 'nested', 'dsh-update.json')
  try {
    await writeDshUpdateCache(cachePath, 'v0.1.0-rc.6', 123456)
    assert.deepEqual(await readDshUpdateCache(cachePath), {
      version: '0.1.0-rc.6',
      checkedAt: 123456,
      successful: true,
      registry: null,
    })

    await writeDshUpdateCache(cachePath, '0.1.0-rc.6', 123457, false)
    assert.deepEqual(await readDshUpdateCache(cachePath), {
      version: '0.1.0-rc.6',
      checkedAt: 123457,
      successful: false,
      registry: null,
    })

    // 命中的软件源要一起记住，缓存期内更新 dsh 才能继续走同一个源。
    await writeDshUpdateCache(cachePath, '0.1.0-rc.6', 123458, true, 'https://registry.npmmirror.com')
    assert.deepEqual(await readDshUpdateCache(cachePath), {
      version: '0.1.0-rc.6',
      checkedAt: 123458,
      successful: true,
      registry: 'https://registry.npmmirror.com',
    })

    await writeFile(cachePath, '{"version":"invalid","checkedAt":123456}')
    assert.equal(await readDshUpdateCache(cachePath), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('captures the authenticated dsh web launch URL from stdout', () => {
  const url = parseDshLaunchUrl(
    'dsh web: http://127.0.0.1:54077/?token=AbC123_- (LAN: http://10.0.0.5:54077/?token=AbC123_-)',
    { port: 54077 },
  )
  assert.equal(url, 'http://127.0.0.1:54077/?token=AbC123_-')
  assert.equal(parseDshLaunchUrl(`dsh web: ${url}`, { port: 54077 }), url)
})

test('rejects launch lines that do not match the running instance', () => {
  const token = 'XyZ9_ab'
  const options = { port: 54077 }
  assert.equal(parseDshLaunchUrl(`dsh web: http://127.0.0.1:54077/?token=${token}`, options), `http://127.0.0.1:54077/?token=${token}`)
  assert.equal(parseDshLaunchUrl(`dsh web: http://127.0.0.1:54078/?token=${token}`, options), null)
  assert.equal(parseDshLaunchUrl(`dsh web: http://localhost:54077/?token=${token}`, options), null)
  assert.equal(parseDshLaunchUrl(`dsh web: http://192.168.1.5:54077/?token=${token}`, options), null)
  assert.equal(parseDshLaunchUrl(`dsh web: https://127.0.0.1:54077/?token=${token}`, options), null)
  assert.equal(parseDshLaunchUrl(`dsh web: http://127.0.0.1:54077/`, options), null)
  assert.equal(parseDshLaunchUrl(`dsh web: http://127.0.0.1:54077/?token=bad%20token`, options), null)
  assert.equal(parseDshLaunchUrl(`dsh web: http://127.0.0.1:54077/?token=bad!token`, options), null)
  assert.equal(parseDshLaunchUrl(`dsh web: http://127.0.0.1:54077/?token=${token}`, { port: 54078 }), null)
  assert.equal(parseDshLaunchUrl('some unrelated log line', options), null)
  assert.equal(parseDshLaunchUrl('', options), null)
})
