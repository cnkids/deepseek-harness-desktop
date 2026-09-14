import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
} from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import semver from 'semver'
import * as tar from 'tar'
import yauzl from 'yauzl'
import { stripTrailingSlashes } from './dsh-registry.mjs'

const execFileAsync = promisify(execFile)

export const REQUIRED_NODE_RANGE = '^22.19.0 || >=24.0.0'
export const MANAGED_NODE_VERSION = '24.12.0'
// 官方源优先，国内镜像兜底：访问不了 nodejs.org 的机器会在探测阶段就切到镜像，
// 镜像内容与官方一致（SHA-256 相同），因此校验逻辑不受影响。
export const NODE_DIST_MIRRORS = Object.freeze([
  `https://nodejs.org/dist/v${MANAGED_NODE_VERSION}`,
  `https://cdn.npmmirror.com/binaries/node/v${MANAGED_NODE_VERSION}`,
])
export const NODE_DIST_BASE_URL = NODE_DIST_MIRRORS[0]
export const NODE_DOWNLOAD_TIMEOUT_MS = 10 * 60_000
const NODE_MIRROR_PROBE_TIMEOUT_MS = 5_000

const UNSAFE_TAR_ENTRY_TYPES = new Set([
  'SymbolicLink',
  'Link',
  'CharacterDevice',
  'BlockDevice',
  'FIFO',
])

const NODE_ARTIFACTS = Object.freeze({
  'darwin-arm64': {
    file: `node-v${MANAGED_NODE_VERSION}-darwin-arm64.tar.gz`,
    sha256: '319f221adc5e44ff0ed57e8a441b2284f02b8dc6fc87b8eb92a6a93643fd8080',
    archive: 'tar.gz',
  },
  'darwin-x64': {
    file: `node-v${MANAGED_NODE_VERSION}-darwin-x64.tar.gz`,
    sha256: 'b82ea4c62fd08e250cab59d625e75d77cc5b0a3d60c6698ebee4545c88a169c5',
    archive: 'tar.gz',
  },
  'linux-arm64': {
    file: `node-v${MANAGED_NODE_VERSION}-linux-arm64.tar.gz`,
    sha256: '9b2a2eeb98a8eb37361224e2a1d060300ad2dd143af58dfdb16de785df0f1228',
    archive: 'tar.gz',
  },
  'linux-x64': {
    file: `node-v${MANAGED_NODE_VERSION}-linux-x64.tar.gz`,
    sha256: '6159227e0af7d7c3c6bb2fa900452b04a6cb8841a702a79acc613209d70b04d0',
    archive: 'tar.gz',
  },
  'win32-arm64': {
    file: `node-v${MANAGED_NODE_VERSION}-win-arm64.zip`,
    sha256: 'b05e7e066f813d35ad3cd9c24eedaee074c012ac7e00071297608fdd2e948ae3',
    archive: 'zip',
  },
  'win32-x64': {
    file: `node-v${MANAGED_NODE_VERSION}-win-x64.zip`,
    sha256: '9c125f61ae947b52e779095830f9cac267846a043ef7192183c84016aaad2812',
    archive: 'zip',
  },
})

export function getNodeArtifact(platform = process.platform, arch = process.arch) {
  const artifact = NODE_ARTIFACTS[`${platform}-${arch}`]
  if (!artifact) {
    throw new Error(
      `暂不支持为 ${platform}/${arch} 自动安装私有 Node.js；请安装满足 ${REQUIRED_NODE_RANGE} 的系统 Node.js。`,
    )
  }
  return artifact
}

export function isCompatibleNodeVersion(rawVersion) {
  const cleaned = semver.clean(String(rawVersion).trim())
  return Boolean(cleaned && semver.satisfies(cleaned, REQUIRED_NODE_RANGE))
}

function managedNpxCliRelativePath(platform = process.platform) {
  return platform === 'win32'
    ? path.join('node_modules', 'npm', 'bin', 'npx-cli.js')
    : path.join('lib', 'node_modules', 'npm', 'bin', 'npx-cli.js')
}

function managedNodeInstallDirectory(
  runtimeRoot,
  platform = process.platform,
  arch = process.arch,
) {
  return path.join(
    runtimeRoot,
    `node-v${MANAGED_NODE_VERSION}-${platform}-${arch}`,
  )
}

async function fileExists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function commandOutput(command, args, options = {}) {
  try {
    const { stdout } = await execFileAsync(command, args, {
      encoding: 'utf8',
      timeout: 6_000,
      windowsHide: true,
      ...options,
    })
    return stdout.trim()
  } catch {
    return ''
  }
}

async function windowsNodeCandidates() {
  const candidates = []
  const whereOutput = await commandOutput('where.exe', ['node.exe'])
  if (whereOutput) candidates.push(...whereOutput.split(/\r?\n/))
  if (process.env.ProgramFiles) {
    candidates.push(path.join(process.env.ProgramFiles, 'nodejs', 'node.exe'))
  }
  return candidates
}

// 登录 shell 里的 node 只有交互式配置（nvm/fnm）才会出现在 PATH 上，因此这条
// 探测要拉起 `$SHELL -lic`，代价最大，只在冷启动时启用。
async function loginShellNodePath() {
  const shell = process.env.SHELL
  if (!shell || !path.isAbsolute(shell)) return ''
  const output = await commandOutput(shell, ['-lic', 'command -v node'])
  return output ? output.split(/\r?\n/).at(-1) : ''
}

async function posixNodeCandidates({ loginShell }) {
  const candidates = []
  const pathNode = await commandOutput('/usr/bin/env', ['sh', '-c', 'command -v node'])
  if (pathNode) candidates.push(pathNode)
  if (loginShell) candidates.push(await loginShellNodePath())
  candidates.push('/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node')
  return candidates
}

// loginShell=false 时跳过登录 shell 探测，用于「缓存里是私有 runtime，但用户
// 可能后来装了系统 Node.js」这种需要便宜复核的场景。
async function findNodeCandidates(platform = process.platform, { loginShell = true } = {}) {
  const candidates = []
  if (process.env.DSH_DESKTOP_NODE) candidates.push(process.env.DSH_DESKTOP_NODE)

  const platformCandidates =
    platform === 'win32'
      ? await windowsNodeCandidates()
      : await posixNodeCandidates({ loginShell })
  candidates.push(...platformCandidates)

  return [...new Set(candidates.filter(Boolean).map((item) => item.trim()))]
}

async function resolveNpxCli(nodePath, platform = process.platform) {
  const nodeDir = path.dirname(nodePath)
  const candidates =
    platform === 'win32'
      ? [path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js')]
      : [
          path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
          path.join(nodeDir, '..', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
          path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js'),
        ]

  if (platform !== 'win32') {
    const npxLink = path.join(nodeDir, 'npx')
    try {
      candidates.unshift(await realpath(npxLink))
    } catch {
      // Some installations provide npm without a sibling npx symlink.
    }
  }

  for (const candidate of candidates) {
    if (await fileExists(candidate)) return path.resolve(candidate)
  }
  return null
}

export async function inspectNodeInstallation(nodePath, platform = process.platform) {
  if (!nodePath || !(await fileExists(nodePath))) return null
  const version = await commandOutput(nodePath, ['--version'])
  if (!isCompatibleNodeVersion(version)) return null
  const npxCliPath = await resolveNpxCli(nodePath, platform)
  if (!npxCliPath) return null
  return {
    source: 'system',
    version: semver.clean(version),
    nodePath: path.resolve(nodePath),
    npxCliPath,
  }
}

export async function findCompatibleSystemNode({
  platform = process.platform,
  loginShell = true,
} = {}) {
  for (const candidate of await findNodeCandidates(platform, { loginShell })) {
    const installation = await inspectNodeInstallation(candidate, platform)
    if (installation) return installation
  }
  return null
}

async function sha256File(filePath) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(filePath), hash)
  return hash.digest('hex')
}

export async function downloadArchive(
  url,
  destination,
  fetchImpl,
  onProgress,
  timeoutMs = NODE_DOWNLOAD_TIMEOUT_MS,
) {
  const signal = AbortSignal.timeout(timeoutMs)
  let response
  try {
    response = await fetchImpl(url, { redirect: 'follow', signal })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError'
    throw new Error(
      timedOut
        ? `下载 Node.js 超时(超过 ${Math.round(timeoutMs / 60_000)} 分钟),请检查网络后重试。`
        : `下载 Node.js 失败：${reason}`,
    )
  }
  if (!response.ok || !response.body) {
    throw new Error(`下载 Node.js 失败：HTTP ${response.status}`)
  }
  const total = Number(response.headers.get('content-length')) || 0
  let received = 0
  const source = Readable.fromWeb(response.body)
  source.on('data', (chunk) => {
    received += chunk.length
    onProgress?.({ phase: 'download', received, total })
  })
  try {
    await pipeline(source, createWriteStream(destination, { flags: 'wx' }), { signal })
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw new Error(`下载 Node.js 超时(超过 ${Math.round(timeoutMs / 60_000)} 分钟),请检查网络后重试。`)
    }
    throw error
  }
}

export function validateTarEntry(entryName, entry) {
  const normalized = entryName.replaceAll('\\', '/')
  if (
    normalized.startsWith('/') ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.split('/').includes('..')
  ) {
    throw new Error(`Node.js 归档包含不安全路径：${entryName}`)
  }
  if (UNSAFE_TAR_ENTRY_TYPES.has(entry?.type)) {
    throw new Error(`Node.js 归档包含不允许的条目类型(${entry.type})：${entryName}`)
  }
  return true
}

async function extractArchive(artifact, archivePath, extractDir) {
  await mkdir(extractDir, { recursive: true })
  if (artifact.archive === 'tar.gz') {
    let rejected = 0
    await tar.x({
      file: archivePath,
      cwd: extractDir,
      strip: 1,
      filter: (entryPath, entry) => {
        try {
          validateTarEntry(entryPath, entry)
          return true
        } catch {
          rejected += 1
          return false
        }
      },
    })
    if (rejected > 0) {
      throw new Error(`Node.js 归档包含 ${rejected} 个不安全条目,已中止安装。`)
    }
    return extractDir
  }

  await extractZipSafely(archivePath, extractDir)
  const rootName = artifact.file.replace(/\.zip$/, '')
  return path.join(extractDir, rootName)
}

export function validateZipEntry(entryName, destinationRoot) {
  const normalized = entryName.replaceAll('\\', '/')
  const segments = normalized.split('/').filter(Boolean)
  if (
    normalized.startsWith('/') ||
    /^[a-zA-Z]:/.test(normalized) ||
    segments.includes('..')
  ) {
    throw new Error(`Node.js ZIP 包含不安全路径：${entryName}`)
  }
  const destination = path.resolve(destinationRoot, ...segments)
  const root = path.resolve(destinationRoot)
  if (destination !== root && !destination.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Node.js ZIP 路径越界：${entryName}`)
  }
  return { destination, normalized }
}

function openZip(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, decodeStrings: true }, (error, zipFile) => {
      if (error) reject(error)
      else resolve(zipFile)
    })
  })
}

function openZipEntryStream(zipFile, entry) {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) reject(error)
      else resolve(stream)
    })
  })
}

async function extractZipSafely(zipPath, destinationRoot) {
  const zipFile = await openZip(zipPath)
  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      zipFile.close()
      reject(error)
    }

    zipFile.once('error', fail)
    zipFile.once('end', () => {
      if (!settled) {
        settled = true
        resolve()
      }
    })
    zipFile.on('entry', (entry) => {
      void (async () => {
        const { destination, normalized } = validateZipEntry(entry.fileName, destinationRoot)
        const unixType = (entry.externalFileAttributes >>> 16) & 0xf000
        if (unixType === 0xa000) {
          throw new Error(`Node.js ZIP 包含不允许的符号链接：${entry.fileName}`)
        }

        if (normalized.endsWith('/')) {
          await mkdir(destination, { recursive: true })
        } else {
          await mkdir(path.dirname(destination), { recursive: true })
          const input = await openZipEntryStream(zipFile, entry)
          await pipeline(input, createWriteStream(destination, { flags: 'wx' }))
        }
        zipFile.readEntry()
      })().catch(fail)
    })
    zipFile.readEntry()
  })
}

async function assertManagedRuntime(runtimeDir, platform = process.platform) {
  const nodePath =
    platform === 'win32'
      ? path.join(runtimeDir, 'node.exe')
      : path.join(runtimeDir, 'bin', 'node')
  const npxCliPath = path.join(runtimeDir, managedNpxCliRelativePath(platform))
  if (!(await fileExists(nodePath)) || !(await fileExists(npxCliPath))) {
    throw new Error('下载的 Node.js 运行时不完整。')
  }
  if (platform !== 'win32') {
    // fs.chmod does not follow symbolic links on macOS and throws EPERM, so
    // only adjust permissions on regular files. A symlinked runtime keeps the
    // permissions of its target and must not be treated as damaged.
    const metadata = await lstat(nodePath)
    if (!metadata.isSymbolicLink()) await chmod(nodePath, 0o755)
  }
  const version = await commandOutput(nodePath, ['--version'])
  if (!isCompatibleNodeVersion(version)) {
    throw new Error(`下载的 Node.js 版本不兼容：${version || '未知版本'}`)
  }
  return {
    source: 'managed',
    version: semver.clean(version),
    nodePath,
    npxCliPath,
  }
}

export async function findInstalledManagedNode({
  runtimeRoot,
  platform = process.platform,
  arch = process.arch,
}) {
  const installDir = managedNodeInstallDirectory(runtimeRoot, platform, arch)
  if (!(await fileExists(installDir))) return null

  try {
    return await assertManagedRuntime(installDir, platform)
  } catch {
    await rm(installDir, { recursive: true, force: true })
    return null
  }
}

export function getNodeDistMirrors(env = process.env) {
  const override = env.DSH_DESKTOP_NODE_MIRROR?.trim()
  const mirrors = [...NODE_DIST_MIRRORS]
  if (!override) return mirrors
  return [stripTrailingSlashes(override), ...mirrors]
}

// 用体积很小的 SHASUMS256.txt 做探测，避免在不可达的源上白等十分钟下载超时。
export async function resolveNodeDistMirror({
  fetchImpl = globalThis.fetch,
  env = process.env,
  probeTimeoutMs = NODE_MIRROR_PROBE_TIMEOUT_MS,
} = {}) {
  const mirrors = getNodeDistMirrors(env)
  for (const baseUrl of mirrors) {
    try {
      const response = await fetchImpl(`${baseUrl}/SHASUMS256.txt`, {
        method: 'HEAD',
        signal: AbortSignal.timeout(probeTimeoutMs),
      })
      if (response.ok) return baseUrl
    } catch {
      // 该镜像不可达，继续探测下一个。
    }
  }
  // 全部不可达时仍返回首选源，让下载阶段给出更具体的报错。
  return mirrors[0]
}

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
