import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  MANAGED_NODE_VERSION,
  REQUIRED_NODE_RANGE,
  downloadArchive,
  findInstalledManagedNode,
  getNodeArtifact,
  inspectNodeInstallation,
  isCompatibleNodeVersion,
  resolveNodeEnvironment,
  validateTarEntry,
  validateZipEntry,
} from '../src/node-runtime.mjs'

test('accepts the Node versions supported by DeepSeek Harness', () => {
  assert.equal(isCompatibleNodeVersion('v22.19.0'), true)
  assert.equal(isCompatibleNodeVersion('22.22.1'), true)
  assert.equal(isCompatibleNodeVersion('v24.0.0'), true)
  assert.equal(isCompatibleNodeVersion('v26.1.0'), true)
})

test('rejects incompatible or malformed Node versions', () => {
  assert.equal(isCompatibleNodeVersion('v22.18.0'), false)
  assert.equal(isCompatibleNodeVersion('v20.19.0'), false)
  assert.equal(isCompatibleNodeVersion('not-a-version'), false)
})

test('maps every supported desktop platform and architecture to a verified artifact', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    for (const arch of ['x64', 'arm64']) {
      const artifact = getNodeArtifact(platform, arch)
      assert.match(artifact.file, new RegExp(`node-v${MANAGED_NODE_VERSION}`))
      assert.match(artifact.sha256, /^[a-f0-9]{64}$/)
      assert.ok(['tar.gz', 'zip'].includes(artifact.archive))
    }
  }
})

test('rejects unsupported private-runtime targets with an actionable error', () => {
  assert.throws(
    () => getNodeArtifact('linux', 'riscv64'),
    new RegExp(`请安装满足 ${REQUIRED_NODE_RANGE.replaceAll('+', '\\+')}`),
  )
})

test('rejects ZIP traversal, absolute paths, drive paths, and symlinks by path', () => {
  const root = '/tmp/safe-node-runtime'
  assert.throws(() => validateZipEntry('../escape', root), /不安全路径/)
  assert.throws(() => validateZipEntry('/absolute/path', root), /不安全路径/)
  assert.throws(() => validateZipEntry('C:\\escape\\node.exe', root), /不安全路径/)
  assert.equal(
    validateZipEntry('node-v24/bin/node', root).destination,
    path.resolve(root, 'node-v24/bin/node'),
  )
})

test('detects the current development Node installation when npm is available', async () => {
  const installation = await inspectNodeInstallation(process.execPath, process.platform)
  assert.ok(installation)
  assert.equal(installation.source, 'system')
  assert.equal(installation.nodePath, process.execPath)
  assert.match(installation.npxCliPath, /npx-cli\.js$/)
})

test('reuses an already installed managed runtime without system discovery', async () => {
  if (process.platform === 'win32') return

  const current = await inspectNodeInstallation(process.execPath, process.platform)
  assert.ok(current)
  const root = await mkdtemp(path.join(os.tmpdir(), 'managed-node-cache-'))
  const runtimeDir = path.join(
    root,
    `node-v${MANAGED_NODE_VERSION}-${process.platform}-${process.arch}`,
  )
  try {
    await mkdir(path.join(runtimeDir, 'bin'), { recursive: true })
    await mkdir(path.join(runtimeDir, 'lib', 'node_modules', 'npm', 'bin'), {
      recursive: true,
    })
    await symlink(process.execPath, path.join(runtimeDir, 'bin', 'node'))
    await symlink(
      current.npxCliPath,
      path.join(runtimeDir, 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    )

    const installation = await findInstalledManagedNode({
      runtimeRoot: root,
      platform: process.platform,
      arch: process.arch,
    })
    assert.ok(installation)
    assert.equal(installation.source, 'managed')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('prefers a compatible system Node over an installed managed runtime', async () => {
  if (process.platform === 'win32') return

  const current = await inspectNodeInstallation(process.execPath, process.platform)
  assert.ok(current)
  const root = await mkdtemp(path.join(os.tmpdir(), 'managed-node-order-'))
  const runtimeDir = path.join(
    root,
    `node-v${MANAGED_NODE_VERSION}-${process.platform}-${process.arch}`,
  )
  try {
    await mkdir(path.join(runtimeDir, 'bin'), { recursive: true })
    await mkdir(path.join(runtimeDir, 'lib', 'node_modules', 'npm', 'bin'), {
      recursive: true,
    })
    await symlink(process.execPath, path.join(runtimeDir, 'bin', 'node'))
    await symlink(
      current.npxCliPath,
      path.join(runtimeDir, 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    )

    const installation = await resolveNodeEnvironment({
      runtimeRoot: root,
      platform: process.platform,
      arch: process.arch,
    })
    // 即便私有 runtime 可用，有兼容的系统 Node.js 时也要用它：dsh 才会装进
    // 用户自己的全局 npm 环境，用户才能在自己的终端里执行 dsh 命令。
    assert.ok(installation)
    assert.equal(installation.source, 'system')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('keeps an explicit Node override ahead of a cached managed runtime', async () => {
  if (process.platform === 'win32') return

  const current = await inspectNodeInstallation(process.execPath, process.platform)
  assert.ok(current)
  const root = await mkdtemp(path.join(os.tmpdir(), 'managed-node-override-'))
  const runtimeDir = path.join(
    root,
    `node-v${MANAGED_NODE_VERSION}-${process.platform}-${process.arch}`,
  )
  const previousOverride = process.env.DSH_DESKTOP_NODE
  try {
    await mkdir(path.join(runtimeDir, 'bin'), { recursive: true })
    await mkdir(path.join(runtimeDir, 'lib', 'node_modules', 'npm', 'bin'), {
      recursive: true,
    })
    await symlink(process.execPath, path.join(runtimeDir, 'bin', 'node'))
    await symlink(
      current.npxCliPath,
      path.join(runtimeDir, 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    )

    process.env.DSH_DESKTOP_NODE = process.execPath
    const installation = await resolveNodeEnvironment({
      runtimeRoot: root,
      platform: process.platform,
      arch: process.arch,
    })
    assert.ok(installation)
    assert.equal(installation.source, 'system')
    assert.equal(installation.nodePath, process.execPath)
  } finally {
    if (previousOverride === undefined) delete process.env.DSH_DESKTOP_NODE
    else process.env.DSH_DESKTOP_NODE = previousOverride
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects tar path traversal, absolute paths, links, and device entries', () => {
  const fileEntry = { type: 'File' }
  assert.equal(validateTarEntry('node-v24/bin/node', fileEntry), true)
  assert.equal(validateTarEntry('node-v24/lib/node_modules/npm/bin/npx-cli.js', fileEntry), true)
  assert.throws(() => validateTarEntry('../escape', fileEntry), /不安全路径/)
  assert.throws(() => validateTarEntry('/absolute/path', fileEntry), /不安全路径/)
  assert.throws(() => validateTarEntry('C:\\escape\\node.exe', fileEntry), /不安全路径/)
  for (const type of ['SymbolicLink', 'Link', 'CharacterDevice', 'BlockDevice', 'FIFO']) {
    assert.throws(
      () => validateTarEntry('node-v24/bin/node', { type }),
      /不允许的条目类型/,
      type,
    )
  }
})

test('downloadArchive fails fast when the remote never answers', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'node-archive-timeout-'))
  const destination = path.join(directory, 'node.tar.gz')
  try {
    const fetchImpl = (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'TimeoutError'))
        })
      })
    await assert.rejects(
      downloadArchive(
        'https://nodejs.example/node.tar.gz',
        destination,
        fetchImpl,
        undefined,
        80,
      ),
      /超时/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('downloadArchive aborts a stalled response body', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'node-archive-body-timeout-'))
  const destination = path.join(directory, 'node.tar.gz')
  try {
    const fetchImpl = async () =>
      new Response(new ReadableStream({ start() { /* never emits data */ } }))
    await assert.rejects(
      downloadArchive(
        'https://nodejs.example/node.tar.gz',
        destination,
        fetchImpl,
        undefined,
        80,
      ),
      /超时/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
