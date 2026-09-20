import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { findUserDshInstallation, inspectDshPackage, updateGlobalDsh } from '../src/dsh-runtime.mjs'

// 这些用例通过一个假的 node 可执行文件驱动 npm 全局查询路径，因此在
// Windows 上跳过（假 node 是 POSIX shell 脚本）。
const skipOnWindows = { skip: process.platform === 'win32' }

async function createFakeRuntime({ withGlobalInstall = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-runtime-'))
  const npmRoot = path.join(root, 'npm-root')
  const npmPrefix = path.join(root, 'npm-prefix')

  // npm 全局安装位置：@deepseek-ai/dsh
  if (withGlobalInstall) {
    const packageRoot = path.join(npmRoot, '@deepseek-ai', 'dsh')
    await mkdir(path.join(packageRoot, 'bin'), { recursive: true })
    await writeFile(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.2.3', bin: { dsh: 'bin/dsh.js' } }),
    )
    await writeFile(path.join(packageRoot, 'bin', 'dsh.js'), '#!/usr/bin/env node\n')
  } else {
    await mkdir(npmRoot, { recursive: true })
  }

  // 假的 node：按参数回答 --version / npm root / npm prefix，其余静默成功，
  // 并把收到的参数写入日志以便断言 npm install 的开关。
  const fakeNode = path.join(root, 'fake-node')
  const logPath = path.join(root, 'fake-node.log')
  await writeFile(
    fakeNode,
    [
      '#!/bin/sh',
      'echo "$* registry=$npm_config_registry" >> "$FAKE_LOG"',
      'case "$*" in',
      '  *--version*) echo "v24.0.0" ;;',
      '  *"root --global"*) echo "$FAKE_NPM_ROOT" ;;',
      '  *"prefix --global"*) echo "$FAKE_NPM_PREFIX" ;;',
      '  *) exit 0 ;;',
      'esac',
      '',
    ].join('\n'),
  )
  // 只给当前用户可执行权限：测试用的假 node 不需要其他用户可读或可执行。
  await chmod(fakeNode, 0o700)

  // npm 自带入口：dsh-runtime 会从 npx-cli.js 的位置推导 npm-cli.js。
  const npmBin = path.join(npmPrefix, 'lib', 'node_modules', 'npm', 'bin')
  await mkdir(npmBin, { recursive: true })
  const npxCliPath = path.join(npmBin, 'npx-cli.js')
  await writeFile(npxCliPath, '// fake npx\n')
  await writeFile(path.join(npmBin, 'npm-cli.js'), '// fake npm\n')

  return {
    fakeNode,
    npxCliPath,
    npmRoot,
    npmPrefix,
    logPath,
    packageRoot: path.join(npmRoot, '@deepseek-ai', 'dsh'),
    nodeEnvironment: { source: 'system', version: '24.0.0', nodePath: fakeNode, npxCliPath },
    env: {
      ...process.env,
      FAKE_NPM_ROOT: npmRoot,
      FAKE_NPM_PREFIX: npmPrefix,
      FAKE_LOG: logPath,
    },
  }
}

test('finds the dsh package in the npm global root', skipOnWindows, async () => {
  const runtime = await createFakeRuntime()

  const installation = await findUserDshInstallation({
    nodeEnvironment: runtime.nodeEnvironment,
    platform: 'linux',
    env: runtime.env,
  })

  assert.equal(installation.source, 'global')
  assert.equal(installation.version, '1.2.3')
  assert.equal(installation.packageRoot, runtime.packageRoot)
  assert.equal(installation.binPath, path.join(runtime.packageRoot, 'bin', 'dsh.js'))
  assert.equal(installation.binDir, path.join(runtime.npmPrefix, 'bin'))
})

test('returns null when the global root has no dsh package', skipOnWindows, async () => {
  const runtime = await createFakeRuntime({ withGlobalInstall: false })

  const installation = await findUserDshInstallation({
    nodeEnvironment: runtime.nodeEnvironment,
    platform: 'linux',
    env: runtime.env,
    includePath: false,
  })

  assert.equal(installation, null)
})

test('updates the global dsh and re-inspects the installation', skipOnWindows, async () => {
  const runtime = await createFakeRuntime()

  const installation = await updateGlobalDsh({
    nodeEnvironment: runtime.nodeEnvironment,
    version: '1.2.3',
    platform: 'linux',
    env: runtime.env,
  })

  assert.equal(installation.version, '1.2.3')
  assert.equal(installation.binDir, path.join(runtime.npmPrefix, 'bin'))
})

test('passes the resolved registry to npm through the environment', skipOnWindows, async () => {
  const runtime = await createFakeRuntime()

  await updateGlobalDsh({
    nodeEnvironment: runtime.nodeEnvironment,
    version: '1.2.3',
    platform: 'linux',
    env: runtime.env,
    registry: 'https://registry.npmmirror.com',
  })

  const log = await readFile(runtime.logPath, 'utf8')
  assert.match(log, /registry=https:\/\/registry\.npmmirror\.com/)
})

// 安全守卫：版本号来自软件源，必须在拼进 npm 安装参数之前再次校验，非法值直接拒绝。
test('rejects a version that is not valid semver before calling npm', skipOnWindows, async () => {
  const runtime = await createFakeRuntime()

  await assert.rejects(
    updateGlobalDsh({
      nodeEnvironment: runtime.nodeEnvironment,
      version: '1.2.3 || rm -rf /',
      platform: 'linux',
      env: runtime.env,
    }),
    /无效的 Harness 版本号/,
  )

  const log = await readFile(runtime.logPath, 'utf8').catch(() => '')
  assert.equal(log.includes('install'), false, 'npm 不该被调用')
})

test('rejects packages that are not dsh or have no usable bin entry', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-package-'))

  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'other', version: '1.0.0' }))
  assert.equal(await inspectDshPackage(root), null)

  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.0.0', bin: { dsh: 'bin/missing.js' } }),
  )
  assert.equal(await inspectDshPackage(root), null)

  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version: 'not-a-version', bin: 'bin/dsh.js' }),
  )
  assert.equal(await inspectDshPackage(root), null)
})
