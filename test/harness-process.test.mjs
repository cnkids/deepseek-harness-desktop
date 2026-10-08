import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import {
  appendProcessOutput,
  buildHarnessLaunchArgs,
  spawnHarness,
  stopHarnessProcess,
  DEFAULT_HARNESS_PROFILE,
  isValidHarnessProfile,
} from '../src/harness-process.mjs'

// appendProcessOutput 会把每行转发给回调，同时也写进控制台日志；测试里静音日志，
// 避免把 dsh 的原始输出混进测试报告。
async function withoutConsoleLog(run) {
  const original = console.log
  console.log = () => {}
  try {
    await run()
  } finally {
    console.log = original
  }
}

function collectLines() {
  const stream = new Readable({ read() {} })
  const lines = []
  appendProcessOutput(stream, 'log', (line) => lines.push(line))
  return { stream, lines }
}

test('forwards complete output lines and drops blank ones', async () => {
  await withoutConsoleLog(async () => {
    const { stream, lines } = collectLines()

    stream.push('dsh web: http://127.0.0.1:1234/?token=abc\n')
    stream.push('partial')
    stream.push(' line\n\n   \n')
    await new Promise((resolve) => setImmediate(resolve))

    assert.deepEqual(lines, [
      'dsh web: http://127.0.0.1:1234/?token=abc',
      'partial line',
    ])
  })
})

test('tolerates a missing stream', () => {
  assert.doesNotThrow(() => appendProcessOutput(null, 'log', () => {}))
})

test('builds the dsh launch command with an explicit CLI-managed profile', () => {
  // 桌面端显式传 `--profile web`，绕开官方端保留的 desktop 名字，并且不依赖
  // CLI 侧按位置缩写 profile 的行为；参数顺序固定为 profile 紧跟其后。
  assert.deepEqual(
    buildHarnessLaunchArgs('/path/to/dsh', { port: 54077 }),
    ['/path/to/dsh', '--profile', 'web', '--no-open', '--port', '54077'],
  )
})

test('builds the launch command with a custom profile and numeric port', () => {
  assert.deepEqual(
    buildHarnessLaunchArgs('/path/to/dsh', { port: 1234, profile: 'web-fresh' }),
    ['/path/to/dsh', '--profile', 'web-fresh', '--no-open', '--port', '1234'],
  )
})

test('falls back to the web profile for an invalid or missing profile', () => {
  const port = 80
  assert.deepEqual(buildHarnessLaunchArgs('dsh', { port, profile: 'two words' }), [
    'dsh',
    '--profile',
    DEFAULT_HARNESS_PROFILE,
    '--no-open',
    '--port',
    '80',
  ])
  assert.deepEqual(buildHarnessLaunchArgs('dsh', { port }), [
    'dsh',
    '--profile',
    DEFAULT_HARNESS_PROFILE,
    '--no-open',
    '--port',
    '80',
  ])
})

test('accepts only plain-identifier profile names', () => {
  assert.equal(isValidHarnessProfile('web'), true)
  assert.equal(isValidHarnessProfile('web-fresh'), true)
  assert.equal(isValidHarnessProfile('my_work.1'), true)
  assert.equal(isValidHarnessProfile('desktop'), true)
  for (const invalid of ['', ' ', 'two words', 'a;b', 'a=b', 42, null, undefined]) {
    assert.equal(isValidHarnessProfile(invalid), false)
  }
})

test('stops a running harness process', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harness-process-'))
  const script = path.join(root, 'fake-dsh.mjs')
  try {
    await writeFile(
      script,
      [
        'console.log("dsh web: http://127.0.0.1:1234/?token=abc")',
        'setInterval(() => {}, 1000)',
        '',
      ].join('\n'),
    )

    const lines = []
    const child = spawnHarness({
      nodePath: process.execPath,
      binPath: script,
      port: 1234,
      cwd: root,
      env: process.env,
      onStdoutLine: (line) => lines.push(line),
      onStderrLine: () => {},
      onError: () => {},
      onExit: () => {},
    })

    await withoutConsoleLog(async () => {
      const deadline = Date.now() + 10_000
      while (lines.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    })
    assert.match(lines[0], /dsh web: http:\/\/127\.0\.0\.1:1234\/\?token=abc/)

    const exited = new Promise((resolve) => child.once('exit', resolve))
    stopHarnessProcess(child)
    await exited

    // SIGTERM 结束时 exitCode 为 null，但 signalCode 会记录信号。
    assert.equal(child.exitCode !== null || child.signalCode !== null, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ignores an already finished process', () => {
  assert.doesNotThrow(() => stopHarnessProcess(null))
})
