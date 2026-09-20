import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  MANAGED_NODE_VERSION,
  ensureManagedNode,
  getNodeArtifact,
  inspectNodeInstallation,
} from '../src/node-runtime.mjs'

// 私有 Node.js runtime 的安装路径：命中已有 runtime 时不该联网；下载回来的归档
// 必须通过官方 SHA-256 校验，否则一律丢弃（供应链校验）。
const skipOnWindows = { skip: process.platform === 'win32' }

async function createManagedRuntimeFixture() {
  const current = await inspectNodeInstallation(process.execPath, process.platform)
  const root = await mkdtemp(path.join(os.tmpdir(), 'managed-node-install-'))
  const runtimeDir = path.join(root, `node-v${MANAGED_NODE_VERSION}-${process.platform}-${process.arch}`)
  await mkdir(path.join(runtimeDir, 'bin'), { recursive: true })
  await mkdir(path.join(runtimeDir, 'lib', 'node_modules', 'npm', 'bin'), { recursive: true })
  await symlink(process.execPath, path.join(runtimeDir, 'bin', 'node'))
  await symlink(current.npxCliPath, path.join(runtimeDir, 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'))
  return { root, runtimeDir, cleanup: () => rm(root, { recursive: true, force: true }) }
}

test('reuses an installed managed runtime without downloading anything', skipOnWindows, async () => {
  const fixture = await createManagedRuntimeFixture()
  try {
    const installation = await ensureManagedNode({
      runtimeRoot: fixture.root,
      platform: process.platform,
      arch: process.arch,
      fetchImpl: async () => {
        throw new Error('命中已有 runtime 时不该发起网络请求')
      },
    })

    assert.equal(installation.source, 'managed')
    assert.equal(installation.nodePath, path.join(fixture.runtimeDir, 'bin', 'node'))
  } finally {
    await fixture.cleanup()
  }
})

test('refuses a private-runtime archive that fails SHA-256 verification', async () => {
  const artifact = getNodeArtifact(process.platform, process.arch)
  const served = []
  const server = createServer((request, response) => {
    served.push(`${request.method} ${request.url}`)
    if (request.url === `/${artifact.file}`) {
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end('tampered archive contents')
      return
    }
    response.writeHead(200)
    response.end('0'.repeat(64))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const root = await mkdtemp(path.join(os.tmpdir(), 'managed-node-tampered-'))
  const progress = []
  try {
    await assert.rejects(
      ensureManagedNode({
        runtimeRoot: root,
        platform: process.platform,
        arch: process.arch,
        fetchImpl: (url, options) => fetch(url, options),
        env: { DSH_DESKTOP_NODE_MIRROR: `http://127.0.0.1:${port}` },
        onProgress: (event) => progress.push(event),
      }),
      /Node\.js 安装包校验失败/,
    )

    // 探测用 HEAD，下载用 GET；镜像源要如实标注（本机 http 私有源是允许的）。
    assert.equal(served.includes('HEAD /SHASUMS256.txt'), true)
    assert.equal(served.includes(`GET /${artifact.file}`), true)
    assert.deepEqual(progress.map((event) => event.phase), ['download-start', 'download', 'verify'])
    assert.equal(progress[0].source, 'mirror')

    // 失败的安装不能留下任何残留目录。
    assert.deepEqual(await readdir(root), [])
  } finally {
    server.close()
    await rm(root, { recursive: true, force: true })
  }
})
