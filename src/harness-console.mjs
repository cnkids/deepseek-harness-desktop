import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { buildHarnessEnvironment } from './dsh-runtime.mjs'

// 用户自己的终端不会继承应用为 Harness 子进程准备的 PATH：在没有系统
// Node.js 的机器上，Node.js 与 dsh 只存在于应用私有 runtime 里，用户因此
// 无法执行 `dsh plugin --profile web add ...` 这类全局命令。这里生成一个
// "已把私有 runtime 与全局 dsh 目录前置进 PATH" 的终端启动描述，由主进程
// 拉起终端窗口，不触碰系统 PATH。

const execFileAsync = promisify(execFile)

export const CONSOLE_TITLE = 'DeepSeek Harness CLI'

export const CONSOLE_HINT = 'dsh plugin --profile web add github:cnkids/dsh-office-toolkit'

// Linux 没有统一的终端接口，按常见发行版顺序探测；每个终端传脚本的方式
// 也不一致，因此把参数拼装一并写在这里。
export const LINUX_TERMINALS = [
  { command: 'x-terminal-emulator', args: (script) => ['-e', script] },
  { command: 'gnome-terminal', args: (script) => ['--', script] },
  { command: 'konsole', args: (script) => ['-e', script] },
  { command: 'xfce4-terminal', args: (script) => ['-e', script] },
  { command: 'alacritty', args: (script) => ['-e', script] },
  { command: 'kitty', args: (script) => [script] },
  { command: 'xterm', args: (script) => ['-e', script] },
]

// POSIX shell 单引号转义：内部的单引号写成 '\''，保证整段始终是一个词，
// 路径里的空格、引号或分号都不会被解释成命令。
const ESCAPED_POSIX_QUOTE = String.raw`'\''`

export function quotePosixShellArg(value) {
  return `'${String(value).replaceAll("'", ESCAPED_POSIX_QUOTE)}'`
}

export function renderPosixConsoleScript({
  nodeDir,
  dshBinDir,
  workspacePath,
  shellPath,
  hint = CONSOLE_HINT,
}) {
  const searchPath = [nodeDir, dshBinDir].filter(Boolean).join(':')
  const hintLine = `示例：${hint}`
  const lines = [
    '#!/bin/sh',
    '# 由 DeepSeek Harness Desktop 生成：把应用私有 Node.js 与全局 dsh 前置进 PATH。',
    `export PATH=${quotePosixShellArg(searchPath)}:"$PATH"`,
  ]
  if (workspacePath) {
    lines.push(`cd ${quotePosixShellArg(workspacePath)} 2>/dev/null || true`)
  }
  lines.push(
    `echo ${quotePosixShellArg('Harness 命令行已就绪，可直接执行 dsh 全局命令。')}`,
    `echo ${quotePosixShellArg(hintLine)}`,
    `echo ${quotePosixShellArg('安装插件后请从托盘菜单重启本应用使其生效。')}`,
    `exec ${quotePosixShellArg(shellPath || '/bin/sh')} -i`,
    '',
  )
  return lines.join('\n')
}

export function consoleScriptPath(userDataPath, platform = process.platform) {
  const name = platform === 'win32' ? 'harness-console.cmd' : 'harness-console.command'
  return path.join(userDataPath, 'console', name)
}

function spawnOptions(environment, workspacePath) {
  return {
    cwd: workspacePath,
    env: environment,
    detached: true,
    stdio: 'ignore',
  }
}

export function createHarnessConsoleLaunch({
  platform = process.platform,
  nodeEnvironment,
  dshInstallation,
  workspacePath,
  userDataPath,
  env = process.env,
  shellPath = env.SHELL,
  comspec = env.ComSpec,
  linuxTerminal = null,
}) {
  if (!nodeEnvironment?.nodePath || !dshInstallation?.binDir) {
    throw new Error('缺少 Node.js 或 dsh 安装信息，无法准备 Harness 命令行。')
  }

  const environment = buildHarnessEnvironment(nodeEnvironment, [dshInstallation.binDir], env)
  const options = spawnOptions(environment, workspacePath)

  if (platform === 'win32') {
    // 应用是 GUI 进程，detached 的子进程会拿到自己的控制台窗口；cmd 继承
    // 注入后的 PATH，因此用户可以直接执行 dsh 全局命令。
    return {
      script: null,
      command: comspec || 'cmd.exe',
      args: ['/k'],
      options: { ...options, windowsHide: false },
    }
  }

  const script = {
    path: consoleScriptPath(userDataPath, platform),
    content: renderPosixConsoleScript({
      nodeDir: path.dirname(nodeEnvironment.nodePath),
      dshBinDir: dshInstallation.binDir,
      workspacePath,
      shellPath,
    }),
    mode: 0o755,
  }

  if (platform === 'darwin') {
    return {
      script,
      command: 'open',
      args: ['-a', 'Terminal', script.path],
      options,
    }
  }

  if (!linuxTerminal) {
    // 没探测到终端时不静默失败，交给调用方提示用户脚本位置。
    return { script, command: null, args: [], options }
  }
  return {
    script,
    command: linuxTerminal.command,
    args: linuxTerminal.args(script.path),
    options,
  }
}

export async function isCommandAvailable(command, env = process.env) {
  const locator = process.platform === 'win32' ? 'where' : 'which'
  try {
    await execFileAsync(locator, [command], { env, timeout: 5_000, windowsHide: true })
    return true
  } catch {
    return false
  }
}

export async function findLinuxTerminal({ isAvailable = isCommandAvailable } = {}) {
  for (const candidate of LINUX_TERMINALS) {
    if (await isAvailable(candidate.command)) return candidate
  }
  return null
}
