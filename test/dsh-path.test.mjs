import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  appendPathEntry,
  applyUserPathFix,
  createWindowsPathFixCommand,
  hasPathEntry,
  isPathFixApplied,
  readPathFixState,
  resolveShellRcPath,
  upsertShellRcBlock,
  WINDOWS_PATH_FIX_SCRIPT,
  writePathFixState,
} from '../src/dsh-path.mjs'

test('detects PATH entries per platform semantics', () => {
  const win = { platform: 'win32' }
  const posix = { platform: 'linux' }

  assert.equal(hasPathEntry('C:\\Windows;C:\\Users\\me\\AppData\\Roaming\\npm', 'c:\\users\\me\\appdata\\roaming\\npm', win), true)
  assert.equal(hasPathEntry('C:\\Windows\\', 'C:\\Windows', win), true)
  assert.equal(hasPathEntry('C:\\Windows', 'C:\\npm', win), false)

  assert.equal(hasPathEntry('/usr/bin:/bin', '/usr/bin', posix), true)
  assert.equal(hasPathEntry('/usr/bin/', '/usr/bin', posix), true)
  assert.equal(hasPathEntry('/usr/bin:/bin', '/USR/BIN', posix), false)
  assert.equal(hasPathEntry('', '/usr/bin', posix), false)
  assert.equal(hasPathEntry('/usr/bin', '', posix), false)
  assert.equal(hasPathEntry(undefined, '/usr/bin', posix), false)
})

test('appends a PATH entry idempotently', () => {
  assert.equal(appendPathEntry('C:\\Windows', 'C:\\npm', 'win32'), 'C:\\Windows;C:\\npm')
  assert.equal(appendPathEntry('C:\\Windows;C:\\npm', 'c:\\NPM', 'win32'), 'C:\\Windows;C:\\npm')
  assert.equal(appendPathEntry(';C:\\Windows;;', 'C:\\npm', 'win32'), 'C:\\Windows;C:\\npm')

  assert.equal(appendPathEntry(':/usr/bin::', '/opt/dsh/bin', 'linux'), '/usr/bin:/opt/dsh/bin')
  assert.equal(appendPathEntry('/usr/bin', '/opt/dsh/bin', 'linux'), '/usr/bin:/opt/dsh/bin')
  assert.equal(appendPathEntry('/opt/dsh/bin:/usr/bin', '/opt/dsh/bin', 'linux'), '/opt/dsh/bin:/usr/bin')
})

test('writes a marked block into a shell rc file without duplicating it', () => {
  const first = upsertShellRcBlock('', '/home/me/.npm-global/bin')
  assert.match(first, /# >>> deepseek-harness-desktop >>>/)
  assert.match(first, /export PATH='\/home\/me\/\.npm-global\/bin':"\$PATH"/)
  assert.match(first, /# <<< deepseek-harness-desktop <<<\n$/)

  const appended = upsertShellRcBlock('export FOO=1\n', '/home/me/.npm-global/bin')
  assert.match(appended, /^export FOO=1\n\n# >>> deepseek-harness-desktop >>>/)

  // 再执行一次必须原地替换，而不是越写越多。
  const twice = upsertShellRcBlock(appended, '/home/me/.npm-global/bin')
  assert.equal(twice, appended)

  const moved = upsertShellRcBlock(appended, '/new/location/bin')
  assert.equal(moved.match(/# >>> deepseek-harness-desktop >>>/g).length, 1)
  assert.match(moved, /export PATH='\/new\/location\/bin':"\$PATH"/)

  // 目录里的单引号与空格不能把引号提前闭合。
  const hostile = upsertShellRcBlock('', "/tmp/it's a dir")
  assert.match(hostile, /export PATH='\/tmp\/it'\\''s a dir':"\$PATH"/)
})

test('picks the rc file of the login shell, preferring existing ones', () => {
  const existing = (paths) => (candidate) => paths.includes(candidate)

  assert.equal(
    resolveShellRcPath({ home: '/home/me', shellPath: '/bin/zsh', exists: existing(['/home/me/.zshrc']) }),
    '/home/me/.zshrc',
  )
  assert.equal(
    resolveShellRcPath({ home: '/home/me', shellPath: '/bin/bash', exists: existing(['/home/me/.bashrc']) }),
    '/home/me/.bashrc',
  )
  // 未知 shell：优先已存在的文件。
  assert.equal(
    resolveShellRcPath({ home: '/home/me', shellPath: '/bin/fish', exists: existing(['/home/me/.profile']) }),
    '/home/me/.profile',
  )
  // 一个都不存在时落到登录 shell 对应的文件。
  assert.equal(
    resolveShellRcPath({ home: '/home/me', shellPath: '/bin/zsh', exists: () => false }),
    '/home/me/.zshrc',
  )
  assert.equal(
    resolveShellRcPath({ home: '/home/me', shellPath: '', exists: () => false }),
    '/home/me/.profile',
  )
})

test('builds an absolute PowerShell command that never interpolates the target path', () => {
  const defaulted = createWindowsPathFixCommand({ env: {} })
  assert.equal(
    defaulted.command,
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  )

  const custom = createWindowsPathFixCommand({ env: { SystemRoot: 'D:\\Windows' } })
  assert.equal(
    custom.command,
    'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  )
  assert.deepEqual(custom.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command'])
  assert.equal(custom.args[3], WINDOWS_PATH_FIX_SCRIPT)
  // 绝对路径调用，不依赖 PATH 解析。
  assert.equal(/^[A-Za-z]:\\/.test(custom.command), true)

  // 目录来自环境变量，脚本本身是常量。
  assert.match(WINDOWS_PATH_FIX_SCRIPT, /\$env:DSH_DESKTOP_PATH_DIR/)
  assert.match(WINDOWS_PATH_FIX_SCRIPT, /SetEnvironmentVariable\('Path'/)
  assert.match(WINDOWS_PATH_FIX_SCRIPT, /'User'/)
  assert.equal(/[A-Za-z]:\\/.test(WINDOWS_PATH_FIX_SCRIPT), false)
})

test('applyUserPathFix writes the marked block on POSIX', async () => {
  const written = new Map()
  const result = await applyUserPathFix({
    binDir: '/home/me/.npm-global/bin',
    platform: 'linux',
    env: { SHELL: '/bin/bash' },
    home: '/home/me',
    exists: (candidate) => candidate === '/home/me/.bashrc',
    fileSystem: {
      readFile: async () => 'export FOO=1\n',
      writeFile: async (file, content) => written.set(file, content),
    },
  })

  assert.equal(result.kind, 'shell-rc')
  assert.equal(result.detail, '/home/me/.bashrc')
  const content = written.get('/home/me/.bashrc')
  assert.match(content, /^export FOO=1\n\n# >>> deepseek-harness-desktop >>>/)
  assert.match(content, /export PATH='\/home\/me\/\.npm-global\/bin':"\$PATH"/)
})

test('applyUserPathFix rejects a missing bin directory', async () => {
  await assert.rejects(applyUserPathFix({ binDir: '' }), /缺少 dsh 安装目录/)
})

// PATH 提示每个目录只应出现一次；已成功修复过的目录也要记住——shell rc 的改动
// 不会反映到应用自身的 process.env.PATH，不记下来就会每次启动重复提示。
test('remembers which directory was prompted and which was fixed', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-path-state-'))
  const statePath = path.join(directory, 'cache', 'dsh-path.json')
  try {
    assert.deepEqual(await readPathFixState(statePath), {
      promptedFor: null,
      appliedFor: null,
    })

    await writePathFixState(statePath, { promptedFor: 'C:\\Users\\me\\AppData\\Roaming\\npm' })
    assert.deepEqual(await readPathFixState(statePath), {
      promptedFor: 'C:\\Users\\me\\AppData\\Roaming\\npm',
      appliedFor: null,
    })

    await writePathFixState(statePath, {
      promptedFor: 'C:\\Users\\me\\AppData\\Roaming\\npm',
      appliedFor: 'C:\\Users\\me\\AppData\\Roaming\\npm',
    })
    assert.deepEqual(await readPathFixState(statePath), {
      promptedFor: 'C:\\Users\\me\\AppData\\Roaming\\npm',
      appliedFor: 'C:\\Users\\me\\AppData\\Roaming\\npm',
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

// POSIX 下可以直接看 shell rc 里有没有含该目录的标记块，比只信状态文件更可靠。
test('detects an existing shell rc block as already applied', async () => {
  const content = upsertShellRcBlock('export FOO=1\n', '/opt/dsh/bin')
  const fileSystem = { readFile: async () => content }
  const base = {
    platform: 'linux',
    home: '/home/me',
    shellPath: '/bin/zsh',
    exists: () => true,
    fileSystem,
  }

  assert.equal(await isPathFixApplied({ ...base, binDir: '/opt/dsh/bin' }), true)
  // 目录换了（block 里不是这个目录）→ 视为未应用，需要重新修复。
  assert.equal(await isPathFixApplied({ ...base, binDir: '/other/bin' }), false)
  // 没有任何标记块。
  assert.equal(
    await isPathFixApplied({ ...base, binDir: '/opt/dsh/bin', fileSystem: { readFile: async () => 'export FOO=1\n' } }),
    false,
  )
  // Windows 一律走状态文件，不读 rc。
  assert.equal(await isPathFixApplied({ binDir: 'C:\\npm', platform: 'win32', fileSystem }), false)
})

test('ignores malformed or foreign path fix state', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-path-bad-'))
  const statePath = path.join(directory, 'dsh-path.json')
  const empty = { promptedFor: null, appliedFor: null }
  try {
    await writeFile(statePath, 'not json')
    assert.deepEqual(await readPathFixState(statePath), empty)

    await writeFile(statePath, JSON.stringify({ version: 99, promptedFor: '/x', appliedFor: '/x' }))
    assert.deepEqual(await readPathFixState(statePath), empty)

    await writeFile(statePath, JSON.stringify({ version: 1, promptedFor: 42, appliedFor: '' }))
    assert.deepEqual(await readPathFixState(statePath), empty)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
