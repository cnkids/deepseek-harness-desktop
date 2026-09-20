import { realpath } from 'node:fs/promises'
import path from 'node:path'
import semver from 'semver'
import {
  commandOutput,
  fileExists,
  isCompatibleNodeVersion,
} from './node-artifacts.mjs'
import { windowsSystemBinary } from '../system-binaries.mjs'

async function windowsNodeCandidates() {
  const candidates = []
  const whereOutput = await commandOutput(windowsSystemBinary('where'), ['node.exe'])
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
