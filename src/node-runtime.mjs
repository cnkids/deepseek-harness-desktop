import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import {
  NODE_DIST_MIRRORS,
  getNodeArtifact,
  managedNodeInstallDirectory,
} from './node/node-artifacts.mjs'
import { findCompatibleSystemNode } from './node/node-discovery.mjs'
import {
  downloadArchive,
  resolveNodeDistMirror,
  sha256File,
} from './node/node-download.mjs'
import {
  assertManagedRuntime,
  extractArchive,
  findInstalledManagedNode,
} from './node/node-extract.mjs'

// 公共 API 门面：导出名与拆分前逐一对应，测试与其它模块继续从这里导入即可。
export {
  MANAGED_NODE_VERSION,
  NODE_DIST_BASE_URL,
  NODE_DIST_MIRRORS,
  NODE_DOWNLOAD_TIMEOUT_MS,
  REQUIRED_NODE_RANGE,
  getNodeArtifact,
  isCompatibleNodeVersion,
} from './node/node-artifacts.mjs'
export {
  findCompatibleSystemNode,
  inspectNodeInstallation,
} from './node/node-discovery.mjs'
export {
  downloadArchive,
  getNodeDistMirrors,
  resolveNodeDistMirror,
} from './node/node-download.mjs'
export {
  findInstalledManagedNode,
  validateTarEntry,
  validateZipEntry,
} from './node/node-extract.mjs'

export async function ensureManagedNode({
  runtimeRoot,
  platform = process.platform,
  arch = process.arch,
  fetchImpl = globalThis.fetch,
  onProgress,
  env = process.env,
}) {
  const artifact = getNodeArtifact(platform, arch)
  const installDir = managedNodeInstallDirectory(runtimeRoot, platform, arch)
  const installed = await findInstalledManagedNode({ runtimeRoot, platform, arch })
  if (installed) return installed

  await mkdir(runtimeRoot, { recursive: true })
  const stagingRoot = await mkdtemp(path.join(runtimeRoot, '.node-install-'))
  const archivePath = path.join(stagingRoot, artifact.file)
  const extractDir = path.join(stagingRoot, 'extracted')

  try {
    const baseUrl = await resolveNodeDistMirror({ fetchImpl, env })
    onProgress?.({
      phase: 'download-start',
      file: artifact.file,
      source: baseUrl === NODE_DIST_MIRRORS[0] ? 'official' : 'mirror',
    })
    await downloadArchive(`${baseUrl}/${artifact.file}`, archivePath, fetchImpl, onProgress)

    onProgress?.({ phase: 'verify' })
    const actualHash = await sha256File(archivePath)
    if (actualHash !== artifact.sha256) {
      throw new Error(`Node.js 安装包校验失败：期望 ${artifact.sha256}，实际 ${actualHash}`)
    }

    onProgress?.({ phase: 'extract' })
    const extractedRuntime = await extractArchive(artifact, archivePath, extractDir)
    await assertManagedRuntime(extractedRuntime, platform)
    await rename(extractedRuntime, installDir)
    return await assertManagedRuntime(installDir, platform)
  } finally {
    await rm(stagingRoot, { recursive: true, force: true })
  }
}

export async function resolveNodeEnvironment(options) {
  // 优先使用兼容的系统 Node.js（这也是 README「环境自适应」承诺的行为）：dsh
  // 会因此装进用户自己的全局 npm 环境，用户在自己的终端里就能直接执行 dsh。
  // 私有 runtime 只是没有兼容系统 Node 时的兜底；此前它被无条件优先复用，导致
  // 先装了 Node.js 的机器依然拿不到 dsh 命令。
  // 冷启动才会走到这里：有启动缓存时 launchHarness 直接复用上次结果。
  const system = await findCompatibleSystemNode(options)
  if (system) return system

  const managed = await findInstalledManagedNode(options)
  if (managed) return managed

  return ensureManagedNode(options)
}
