import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

// dsh 的可执行文件位于 npm 全局前缀目录（Windows 直接放在前缀目录，POSIX 在其
// bin 子目录）。应用会在系统 Node 上把 dsh 装进用户自己的全局 npm 环境，但如果
// 这个目录不在用户 PATH 上，用户在自己的终端里依然敲不到 dsh 命令。这里提供
// 判断、以及由用户显式触发的一次性修复。

const execFileAsync = promisify(execFile)

const RC_MARKER_START = '# >>> deepseek-harness-desktop >>>'
const RC_MARKER_END = '# <<< deepseek-harness-desktop <<<'

// 提示/修复状态：记住为哪个目录提示过、为哪个目录成功写入过 PATH。后者很关键：
// macOS 等平台把目录写进 shell rc 之后，GUI 应用自身的 process.env.PATH 并不会
// 因此改变（launchd 给的是系统默认 PATH），只看 PATH 就会每次启动都重复提示。
const PROMPT_STATE_VERSION = 1

const EMPTY_FIX_STATE = Object.freeze({ promptedFor: null, appliedFor: null })

function asText(value) {
  return typeof value === 'string' && value !== '' ? value : null
}

export async function readPathFixState(statePath) {
  try {
    const parsed = JSON.parse(await readFile(statePath, 'utf8'))
    if (parsed?.version !== PROMPT_STATE_VERSION) return { ...EMPTY_FIX_STATE }
    return { promptedFor: asText(parsed.promptedFor), appliedFor: asText(parsed.appliedFor) }
  } catch {
    return { ...EMPTY_FIX_STATE }
  }
}

export async function writePathFixState(
  statePath,
  { promptedFor = null, appliedFor = null } = {},
) {
  await mkdir(path.dirname(statePath), { recursive: true })
  const payload = { version: PROMPT_STATE_VERSION, promptedFor, appliedFor }
  await writeFile(statePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}

// 单引号转义：内部单引号写成 '\''，保证整段始终是一个词。
const ESCAPED_POSIX_QUOTE = String.raw`'\''`

export function quotePosixShellArg(value) {
  return `'${String(value).replaceAll("'", ESCAPED_POSIX_QUOTE)}'`
}

export function pathDelimiterFor(platform = process.platform) {
  return platform === 'win32' ? ';' : ':'
}

// 去掉末尾的分隔符。用显式循环而不是 /[\\/]+$/ ：锚定在结尾的量词会带来
// 回溯开销，SonarQube 会记为 ReDoS 安全热点（S5852）。
function stripTrailingSeparators(value) {
  let end = value.length
  while (end > 0 && (value[end - 1] === '/' || value[end - 1] === '\\')) end -= 1
  return value.slice(0, end)
}

function normalizeEntry(value, platform) {
  const trimmed = stripTrailingSeparators(String(value ?? '').trim())
  return platform === 'win32' ? trimmed.toLowerCase() : trimmed
}

export function hasPathEntry(pathValue, target, { platform = process.platform } = {}) {
  if (!target) return false
  const wanted = normalizeEntry(target, platform)
  return String(pathValue ?? '')
    .split(pathDelimiterFor(platform))
    .some((entry) => entry !== '' && normalizeEntry(entry, platform) === wanted)
}

export function appendPathEntry(pathValue, target, platform = process.platform) {
  const delimiter = pathDelimiterFor(platform)
  const entries = String(pathValue ?? '')
    .split(delimiter)
    .filter((entry) => entry.trim() !== '')
  if (hasPathEntry(pathValue, target, { platform })) return entries.join(delimiter)
  entries.push(target)
  return entries.join(delimiter)
}

// 目标目录通过环境变量传给 PowerShell，不拼进脚本文本：既避免引号转义问题，
// 也避免把外部字符串当作脚本执行。用 .NET API 而不是 setx —— setx 会把超过
// 1024 字符的 PATH 截断。
export const WINDOWS_PATH_FIX_SCRIPT = [
  '$dir = $env:DSH_DESKTOP_PATH_DIR',
  "$current = [Environment]::GetEnvironmentVariable('Path','User')",
  "if ($null -eq $current) { $current = '' }",
  "$entries = @($current -split ';' | Where-Object { $_ -ne '' })",
  "if ($entries -contains $dir) { Write-Output 'present' } else {",
  "  [Environment]::SetEnvironmentVariable('Path', (($entries + $dir) -join ';'), 'User')",
  "  Write-Output 'added'",
  '}',
  '',
].join('\n')

// 用绝对路径调用 PowerShell，而不是靠 PATH 解析命令名：既避免 PATH 劫持，
// 也不会触发 SonarQube 的 PATH 相关安全热点（S4036）。
const DEFAULT_WINDOWS_ROOT = String.raw`C:\Windows`

export function resolveWindowsPowerShell({ env = process.env } = {}) {
  const root = env.SystemRoot || env.windir || DEFAULT_WINDOWS_ROOT
  return path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

export function createWindowsPathFixCommand({ env = process.env } = {}) {
  return {
    command: resolveWindowsPowerShell({ env }),
    args: ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PATH_FIX_SCRIPT],
  }
}

export function renderShellRcBlock(binDir) {
  return [
    RC_MARKER_START,
    `export PATH=${quotePosixShellArg(binDir)}:"$PATH"`,
    RC_MARKER_END,
  ].join('\n')
}

function stripTrailingNewlines(value) {
  let end = value.length
  while (end > 0 && value[end - 1] === '\n') end -= 1
  return value.slice(0, end)
}

export function hasShellRcBlock(content) {
  return String(content ?? '').includes(RC_MARKER_START)
}

// 某个目录是否已经写过 PATH。Windows 无从查证（注册表），靠状态文件里的
// appliedFor；POSIX 可以直接看 shell rc 里有没有含该目录的标记块——这比只信
// 状态文件更可靠，用户手工删掉块也能被察觉。
export async function isPathFixApplied({
  binDir,
  platform = process.platform,
  home = os.homedir(),
  shellPath = process.env.SHELL,
  exists,
  fileSystem = { readFile },
}) {
  if (platform === 'win32' || !binDir) return false
  const rcPath = resolveShellRcPath({ home, shellPath, exists })
  const content = await fileSystem.readFile(rcPath, 'utf8').catch(() => '')
  return hasShellRcBlock(content) && String(content).includes(binDir)
}

// 用 indexOf 定位标记块而不是正则：跨行匹配需要 .+? 这类量词，同样会触发
// S5852 ReDoS 热点，也更容易出错。
export function upsertShellRcBlock(content, binDir) {
  const base = String(content ?? '')
  const block = renderShellRcBlock(binDir)
  const start = base.indexOf(RC_MARKER_START)
  const end = start === -1 ? -1 : base.indexOf(RC_MARKER_END, start)
  if (start !== -1 && end !== -1) {
    return `${base.slice(0, start)}${block}${base.slice(end + RC_MARKER_END.length)}`
  }
  if (base.trim() === '') return `${block}\n`
  return `${stripTrailingNewlines(base)}\n\n${block}\n`
}

const SHELL_RC_FILES = { zsh: '.zshrc', bash: '.bashrc' }

export function resolveShellRcPath({ home, shellPath, exists = () => false }) {
  const shellName = path.basename(String(shellPath ?? ''))
  const preferred = SHELL_RC_FILES[shellName] ?? null
  for (const candidate of [preferred, '.zshrc', '.bashrc', '.profile'].filter(Boolean)) {
    // 这里只处理 POSIX 路径（Windows 走注册表分支），用 path.posix 保证结果
    // 与宿主平台无关：在 Windows 上开发/测试时也不会拼出反斜杠路径。
    const full = path.posix.join(home, candidate)
    if (exists(full)) return full
  }
  // 一个都不存在时落到用户 shell 对应的文件，而不是随便造一个别的 shell 不读的。
  return path.posix.join(home, preferred ?? '.profile')
}

export async function applyUserPathFix({
  binDir,
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  shellPath = env.SHELL,
  exists,
  fileSystem = { readFile, writeFile },
}) {
  if (!binDir) throw new Error('缺少 dsh 安装目录，无法修复 PATH。')

  if (platform === 'win32') {
    const { command, args } = createWindowsPathFixCommand({ env })
    const { stdout } = await execFileAsync(command, args, {
      env: { ...env, DSH_DESKTOP_PATH_DIR: binDir },
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
    })
    return { kind: 'windows-user-path', detail: String(stdout ?? '').trim() }
  }

  const rcPath = resolveShellRcPath({ home, shellPath, exists })
  const content = await fileSystem.readFile(rcPath, 'utf8').catch(() => '')
  await fileSystem.writeFile(rcPath, upsertShellRcBlock(content, binDir), 'utf8')
  return { kind: 'shell-rc', detail: rcPath }
}
