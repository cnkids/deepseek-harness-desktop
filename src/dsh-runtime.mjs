import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import semver from 'semver'
import { windowsSystemBinary } from './system-binaries.mjs'

const execFileAsync = promisify(execFile)

export const DSH_PACKAGE_NAME = '@deepseek-ai/dsh'

const DSH_LAUNCH_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/

// dsh web prints its authenticated launch URL on stdout once the local
// browser-session gateway is ready, for example:
//   dsh web: http://127.0.0.1:54077/?token=AbC... (LAN: http://...)
// The token is generated per process and never persisted, so desktop launchers
// must capture it from that line before loading the UI.
export function parseDshLaunchUrl(line, { port, hostname = '127.0.0.1' } = {}) {
  const marker = 'dsh web: '
  const markerIndex = line.indexOf(marker)
  if (markerIndex === -1) return null
  const candidate = line.slice(markerIndex + marker.length).trim().split(/\s+/)[0]
  let parsed
  try {
    parsed = new URL(candidate)
  } catch {
    return null
  }
  if (
    parsed.protocol !== 'http:' ||
    parsed.hostname !== hostname ||
    parsed.port !== String(port) ||
    parsed.pathname !== '/'
  ) {
    return null
  }
  const token = parsed.searchParams.get('token')
  if (!token || !DSH_LAUNCH_TOKEN_PATTERN.test(token)) return null
  return parsed.href
}

export async function readDshUpdateCache(cachePath) {
  try {
    const cached = JSON.parse(await readFile(cachePath, 'utf8'))
    const version = semver.clean(cached?.version)
    const checkedAt = Number(cached?.checkedAt)
    if (!version || !Number.isFinite(checkedAt) || checkedAt <= 0) return null
    return {
      version,
      checkedAt,
      successful: cached?.successful !== false,
      // 记录命中的软件源，缓存期内更新 dsh 时才能继续走同一个源。
      registry: typeof cached?.registry === 'string' ? cached.registry : null,
    }
  } catch {
    return null
  }
}

export async function writeDshUpdateCache(
  cachePath,
  version,
  checkedAt = Date.now(),
  successful = true,
  registry = null,
) {
  const cleanedVersion = semver.clean(version)
  if (!cleanedVersion || !Number.isFinite(checkedAt) || checkedAt <= 0) {
    throw new Error('无法缓存无效的 Harness 版本信息。')
  }
  const payload = { version: cleanedVersion, checkedAt, successful }
  if (registry) payload.registry = registry
  await mkdir(path.dirname(cachePath), { recursive: true })
  await writeFile(cachePath, `${JSON.stringify(payload)}\n`, 'utf8')
}

export function buildHarnessEnvironment(
  nodeEnvironment,
  additionalBinDirs = [],
  env = process.env,
) {
  const nodeDir = path.dirname(nodeEnvironment.nodePath)
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
  const inheritedPath = env[pathKey] ?? ''
  return {
    ...env,
    [pathKey]: [nodeDir, ...additionalBinDirs, inheritedPath]
      .filter(Boolean)
      .join(path.delimiter),
    npm_config_progress: 'false',
  }
}

function npmCliPath(nodeEnvironment) {
  return path.join(path.dirname(nodeEnvironment.npxCliPath), 'npm-cli.js')
}

async function commandOutput(command, args, options = {}) {
  try {
    const { stdout } = await execFileAsync(command, args, {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      ...options,
    })
    return stdout.trim()
  } catch {
    return ''
  }
}

async function fileExists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

export async function inspectDshPackage(packageRoot, source = 'unknown') {
  try {
    const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
    if (manifest.name !== DSH_PACKAGE_NAME) return null
    const version = semver.clean(manifest.version)
    const binEntry =
      typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh
    if (!version || typeof binEntry !== 'string') return null
    const binPath = path.resolve(packageRoot, binEntry)
    if (!(await fileExists(binPath))) return null
    return {
      source,
      version,
      packageRoot: path.resolve(packageRoot),
      binPath,
    }
  } catch {
    return null
  }
}

async function packageFromBin(binPath, source) {
  let candidate
  try {
    candidate = await realpath(binPath)
  } catch {
    candidate = path.resolve(binPath)
  }

  let directory = path.dirname(candidate)
  for (let depth = 0; depth < 6; depth += 1) {
    const installation = await inspectDshPackage(directory, source)
    if (installation) return installation
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }

  return inspectDshPackage(
    path.join(path.dirname(binPath), 'node_modules', '@deepseek-ai', 'dsh'),
    source,
  )
}

async function findPathCandidates(platform, env) {
  const candidates = []
  if (env.DSH_DESKTOP_DSH) candidates.push(env.DSH_DESKTOP_DSH)

  if (platform === 'win32') {
    // 用 SystemRoot 下的绝对路径调用 where：按名字解析会把"查找命令"这件事交给
    // PATH 上任意一个同名程序。
    const output = await commandOutput(windowsSystemBinary('where', env), ['dsh.cmd'], { env })
    if (output) candidates.push(...output.split(/\r?\n/))
    return candidates
  }

  const direct = await commandOutput('/usr/bin/env', ['sh', '-c', 'command -v dsh'], { env })
  if (direct) candidates.push(direct)
  const shell = env.SHELL
  if (shell && path.isAbsolute(shell)) {
    const login = await commandOutput(shell, ['-lic', 'command -v dsh'], { env })
    if (login) candidates.push(login.split(/\r?\n/).at(-1))
  }
  return candidates
}

async function findPathInstallation(platform, env) {
  const candidates = new Set(
    (await findPathCandidates(platform, env)).map((item) => item.trim()).filter(Boolean),
  )

  for (const candidate of candidates) {
    const installation = await packageFromBin(candidate, 'path')
    if (installation) return { ...installation, binDir: path.dirname(candidate) }
  }
  return null
}

async function resolveGlobalNpmPaths(nodeEnvironment, platform, env) {
  const [root, prefix] = await Promise.all([
    commandOutput(
      nodeEnvironment.nodePath,
      [npmCliPath(nodeEnvironment), 'root', '--global'],
      { env },
    ),
    commandOutput(
      nodeEnvironment.nodePath,
      [npmCliPath(nodeEnvironment), 'prefix', '--global'],
      { env },
    ),
  ])
  if (!root || !prefix) return null
  return {
    root: path.resolve(root),
    prefix: path.resolve(prefix),
    binDir: platform === 'win32' ? path.resolve(prefix) : path.resolve(prefix, 'bin'),
  }
}

async function findGlobalInstallation(nodeEnvironment, platform, env) {
  const npmPaths = await resolveGlobalNpmPaths(nodeEnvironment, platform, env)
  if (!npmPaths) return null
  const installation = await inspectDshPackage(
    path.join(npmPaths.root, '@deepseek-ai', 'dsh'),
    'global',
  )
  return installation ? { ...installation, ...npmPaths } : null
}

export async function findUserDshInstallation({
  nodeEnvironment,
  platform = process.platform,
  env = process.env,
  includePath = true,
}) {
  const globalInstallation = await findGlobalInstallation(nodeEnvironment, platform, env)
  if (globalInstallation) return globalInstallation

  if (!includePath) return null
  return findPathInstallation(platform, env)
}

export function isDshUpdateRequired(installedVersion, latestVersion) {
  const installed = semver.clean(installedVersion)
  const latest = semver.clean(latestVersion)
  return Boolean(installed && latest && semver.lt(installed, latest))
}

export async function updateGlobalDsh({
  nodeEnvironment,
  version,
  platform = process.platform,
  env = process.env,
  registry = null,
}) {
  // 版本号来自软件源，是唯一会进入 npm 安装参数的外部数据：这里再做一次
  // 纵深防御，只放行合法 semver（或字面量 latest）。
  const target = version === 'latest' ? 'latest' : semver.valid(semver.clean(String(version ?? '')))
  if (!target) throw new Error('拒绝安装无效的 Harness 版本号。')

  const args = [
    npmCliPath(nodeEnvironment),
    'install',
    '--global',
    `${DSH_PACKAGE_NAME}@${target}`,
  ]
  // 通过 npm_config_registry 环境变量指定软件源：既避免把外部数据拼进命令行
  // 参数，也与 buildHarnessEnvironment 注入 npm 配置的方式保持一致。
  const installEnvironment = registry ? { ...env, npm_config_registry: registry } : env

  await execFileAsync(nodeEnvironment.nodePath, args, {
    env: installEnvironment,
    encoding: 'utf8',
    timeout: 5 * 60_000,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  })
  return findGlobalInstallation(nodeEnvironment, platform, installEnvironment)
}
