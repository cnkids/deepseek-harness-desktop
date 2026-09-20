import { access } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import semver from 'semver'

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

export function managedNpxCliRelativePath(platform = process.platform) {
  return platform === 'win32'
    ? path.join('node_modules', 'npm', 'bin', 'npx-cli.js')
    : path.join('lib', 'node_modules', 'npm', 'bin', 'npx-cli.js')
}

export function managedNodeInstallDirectory(
  runtimeRoot,
  platform = process.platform,
  arch = process.arch,
) {
  return path.join(
    runtimeRoot,
    `node-v${MANAGED_NODE_VERSION}-${platform}-${arch}`,
  )
}

// 下面两个是本模块导出的共享底层工具：探测与解压都需要「文件是否存在」和
// 「执行命令取输出」，放在无依赖的产物层可以避免子模块之间互相引用。
export async function fileExists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

export async function commandOutput(command, args, options = {}) {
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
