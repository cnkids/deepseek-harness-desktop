import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import {
  consoleScriptPath,
  createHarnessConsoleLaunch,
  findLinuxTerminal,
  LINUX_TERMINALS,
  quotePosixShellArg,
  renderPosixConsoleScript,
} from '../src/harness-console.mjs'

const execFileAsync = promisify(execFile)

const nodeEnvironment = {
  source: 'managed',
  version: '24.12.0',
  nodePath: path.join(path.sep, 'app', 'runtime', 'bin', 'node'),
  npxCliPath: path.join(path.sep, 'app', 'runtime', 'lib', 'npx-cli.js'),
}
const dshInstallation = {
  packageRoot: path.join(path.sep, 'app', 'runtime', 'lib', 'node_modules', '@deepseek-ai', 'dsh'),
  binDir: path.join(path.sep, 'app', 'runtime', 'bin'),
}

test('quotes POSIX shell arguments so they survive as a single word', async (t) => {
  assert.equal(quotePosixShellArg('plain'), "'plain'")
  assert.equal(quotePosixShellArg("it's"), "'it'\\''s'")

  if (process.platform === 'win32') {
    t.skip('POSIX shell is not available on Windows')
    return
  }
  for (const value of ["it's", 'a b; rm -rf /', '$(whoami)', '`id`', 'quote"and\\slash']) {
    const { stdout } = await execFileAsync('/bin/sh', ['-c', `printf %s ${quotePosixShellArg(value)}`])
    assert.equal(stdout, value)
  }
})

test('renders a POSIX console script that prepends the private runtime and dsh', () => {
  const script = renderPosixConsoleScript({
    nodeDir: '/app/runtime/bin',
    dshBinDir: '/app/runtime/bin',
    workspacePath: '/Users/me/Documents',
    shellPath: '/bin/zsh',
  })

  const lines = script.split('\n')
  assert.equal(lines[0], '#!/bin/sh')
  assert.equal(lines[2], "export PATH='/app/runtime/bin:/app/runtime/bin':\"$PATH\"")
  assert.equal(lines[3], "cd '/Users/me/Documents' 2>/dev/null || true")
  // 交互式但非登录 shell：登录 shell 会用 path_helper / /etc/profile 重置
  // PATH，把注入的目录丢掉。
  assert.equal(lines.at(-2), "exec '/bin/zsh' -i")
  assert.ok(script.includes('dsh plugin --profile web add'))
})

test('keeps a hostile workspace path inside a single quoted word', () => {
  const hostile = "/tmp/it's a dir; rm -rf / #"
  const script = renderPosixConsoleScript({
    nodeDir: '/app/bin',
    dshBinDir: '/app/bin',
    workspacePath: hostile,
    shellPath: '/bin/sh',
  })
  const cdLine = script.split('\n').find((line) => line.startsWith('cd '))
  assert.equal(cdLine, `cd ${quotePosixShellArg(hostile)} 2>/dev/null || true`)
  // 攻击载荷不能逃出引号变成独立命令。
  assert.ok(!cdLine.includes('; rm -rf / # '))
})

test('falls back to /bin/sh when no shell is known', () => {
  const script = renderPosixConsoleScript({ nodeDir: '/app/bin', dshBinDir: '/app/bin' })
  assert.ok(script.includes("exec '/bin/sh' -i"))
  assert.ok(!script.includes('cd '))
})

test('builds a Windows launch that inherits the injected PATH', () => {
  const userDataPath = path.join(path.sep, 'Users', 'me', 'AppData', 'dsh')
  const launch = createHarnessConsoleLaunch({
    platform: 'win32',
    nodeEnvironment,
    dshInstallation,
    workspacePath: path.join(path.sep, 'Users', 'me', 'Documents'),
    userDataPath,
    env: { PATH: 'C:\\Windows', ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
  })

  assert.equal(launch.script, null)
  assert.equal(launch.command, 'C:\\Windows\\system32\\cmd.exe')
  assert.deepEqual(launch.args, ['/k'])
  assert.equal(launch.options.detached, true)
  assert.equal(launch.options.windowsHide, false)
  assert.equal(launch.options.cwd, path.join(path.sep, 'Users', 'me', 'Documents'))
  const expected = [
    path.dirname(nodeEnvironment.nodePath),
    dshInstallation.binDir,
    'C:\\Windows',
  ].join(path.delimiter)
  assert.equal(launch.options.env.PATH, expected)
})

test('builds a macOS launch that opens the generated script in Terminal', () => {
  const userDataPath = path.join(path.sep, 'Users', 'me', 'Library', 'dsh')
  const launch = createHarnessConsoleLaunch({
    platform: 'darwin',
    nodeEnvironment,
    dshInstallation,
    workspacePath: path.join(path.sep, 'Users', 'me', 'Documents'),
    userDataPath,
    env: { PATH: '/usr/bin', SHELL: '/bin/zsh' },
  })

  assert.equal(launch.command, 'open')
  assert.deepEqual(launch.args, ['-a', 'Terminal', launch.script.path])
  assert.equal(launch.script.path, consoleScriptPath(userDataPath, 'darwin'))
  assert.equal(launch.script.mode, 0o755)
  assert.equal(launch.script.content.split('\n').at(-2), "exec '/bin/zsh' -i")
  assert.ok(launch.script.content.startsWith('#!/bin/sh\n'))
})

test('builds a Linux launch with the detected terminal and degrades without one', () => {
  const options = {
    platform: 'linux',
    nodeEnvironment,
    dshInstallation,
    workspacePath: '/home/me/Documents',
    userDataPath: '/home/me/.config/dsh',
    env: { PATH: '/usr/bin', SHELL: '/bin/bash' },
  }

  const detected = createHarnessConsoleLaunch({
    ...options,
    linuxTerminal: LINUX_TERMINALS[1],
  })
  assert.equal(detected.command, 'gnome-terminal')
  assert.deepEqual(detected.args, ['--', detected.script.path])

  const missing = createHarnessConsoleLaunch(options)
  assert.equal(missing.command, null)
  assert.deepEqual(missing.args, [])
  assert.ok(missing.script)
})

test('rejects launches without a resolved Node.js or dsh installation', () => {
  const base = {
    platform: 'darwin',
    workspacePath: '/tmp',
    userDataPath: '/tmp',
  }
  assert.throws(
    () => createHarnessConsoleLaunch({ ...base, dshInstallation }),
    /缺少 Node.js 或 dsh 安装信息/,
  )
  assert.throws(
    () => createHarnessConsoleLaunch({ ...base, nodeEnvironment }),
    /缺少 Node.js 或 dsh 安装信息/,
  )
})

test('picks the first available Linux terminal', async () => {
  const calls = []
  const isAvailable = async (command) => {
    calls.push(command)
    return command === 'konsole'
  }
  const terminal = await findLinuxTerminal({ isAvailable })
  assert.equal(terminal.command, 'konsole')
  assert.deepEqual(calls, ['x-terminal-emulator', 'gnome-terminal', 'konsole'])
  assert.equal(await findLinuxTerminal({ isAvailable: async () => false }), null)
})

test('writes the rendered POSIX script to disk as an executable file', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX permissions are not meaningful on Windows')
    return
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-console-'))
  try {
    const launch = createHarnessConsoleLaunch({
      platform: 'linux',
      nodeEnvironment,
      dshInstallation,
      workspacePath: directory,
      userDataPath: directory,
      env: { PATH: '/usr/bin', SHELL: '/bin/sh' },
      linuxTerminal: LINUX_TERMINALS[0],
    })
    await mkdir(path.dirname(launch.script.path), { recursive: true })
    await writeFile(launch.script.path, launch.script.content, { mode: launch.script.mode })
    // 脚本必须能被 shell 解析（这里只做语法检查，不真正执行交互式 shell）。
    await execFileAsync('/bin/sh', ['-n', launch.script.path])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
