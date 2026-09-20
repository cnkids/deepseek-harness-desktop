import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { writeStartupCache } from '../src/startup-cache.mjs'
import {
  allocatePort,
  createNodeProgressReporter,
  readUsableStartupCache,
  resolveWorkspacePath,
  startupCachePath,
} from '../src/harness-environment.mjs'

test('allocates a free local port for each harness launch', async () => {
  const port = await allocatePort()

  assert.equal(Number.isInteger(port), true)
  assert.equal(port > 0 && port < 65_536, true)
})

test('maps private Node.js install progress onto startup status messages', () => {
  const statuses = []
  const report = createNodeProgressReporter((status) => statuses.push(status))

  report({ phase: 'download-start', source: 'mirror', file: 'node.tar.gz' })
  report({ phase: 'download', received: 5 * 1024 * 1024, total: 10 * 1024 * 1024 })
  report({ phase: 'verify' })
  report({ phase: 'extract' })
  report({ phase: 'unknown-phase' })

  assert.equal(statuses.length, 4)
  assert.match(statuses[0].detail, /通过国内镜像下载 node\.tar\.gz/)
  assert.equal(statuses[1].progress, 50)
  assert.match(statuses[1].detail, /5\.0 MB \/ 10\.0 MB/)
  assert.match(statuses[2].detail, /SHA-256/)
  assert.equal(statuses[3].progress, null)
})

test('places the startup cache under the userData cache directory', () => {
  assert.equal(
    startupCachePath(path.join('tmp', 'userData')),
    path.join('tmp', 'userData', 'cache', 'startup.json'),
  )
})

test('reuses a cached environment without probing the machine again', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harness-environment-'))
  const cachePath = startupCachePath(root)
  const nodePath = path.join(root, 'runtime', 'bin', 'node')
  const npxCliPath = path.join(root, 'runtime', 'npm', 'npx-cli.js')
  const packageRoot = path.join(root, 'runtime', 'lib', 'node_modules', '@deepseek-ai', 'dsh')
  const binDir = path.join(root, 'runtime', 'bin')
  try {
    await mkdir(path.dirname(nodePath), { recursive: true })
    await mkdir(path.dirname(npxCliPath), { recursive: true })
    await mkdir(path.join(packageRoot, 'lib'), { recursive: true })
    await Promise.all([
      writeFile(nodePath, ''),
      writeFile(npxCliPath, ''),
      writeFile(
        path.join(packageRoot, 'package.json'),
        JSON.stringify({
          name: '@deepseek-ai/dsh',
          version: '1.2.3',
          bin: { dsh: 'lib/bin.js' },
        }),
      ),
      writeFile(path.join(packageRoot, 'lib', 'bin.js'), ''),
    ])
    await writeStartupCache(
      cachePath,
      { source: 'system', version: '24.0.0', nodePath, npxCliPath },
      { source: 'global', packageRoot, binDir },
    )

    const cached = await readUsableStartupCache(cachePath, true)

    assert.equal(cached.nodeEnvironment.version, '24.0.0')
    assert.equal(cached.dshInstallation.version, '1.2.3')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ignores the startup cache when the environment is overridden', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harness-environment-skip-'))
  try {
    assert.equal(await readUsableStartupCache(startupCachePath(root), false), null)
    // 缓存文件不存在时也不能因此抛错。
    assert.equal(await readUsableStartupCache(startupCachePath(root), true), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('runs the harness in the current directory during development', async () => {
  const workspace = await resolveWorkspacePath({
    isPackaged: false,
    getPath: () => {
      throw new Error('开发模式不查询系统目录')
    },
  })

  assert.equal(workspace, process.cwd())
})

test('prefers the documents directory and skips unusable candidates', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harness-workspace-'))
  try {
    const preferred = await resolveWorkspacePath({
      isPackaged: true,
      getPath: (name) => (name === 'documents' ? root : path.join(root, name)),
    })
    assert.equal(preferred, root)

    const fallback = await resolveWorkspacePath({
      isPackaged: true,
      getPath: (name) => (name === 'home' ? root : path.join(root, `missing-${name}`)),
    })
    assert.equal(fallback, root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
