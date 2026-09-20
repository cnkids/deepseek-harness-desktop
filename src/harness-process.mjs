import { spawn } from 'node:child_process'
import { stripLaunchToken } from './redaction.mjs'
import { windowsSystemBinary } from './system-binaries.mjs'

// Harness 子进程的机械操作：输出逐行采集、启动、停止。
// 启动编排与状态机在 harness-launcher.mjs，本模块只管"怎么把进程拉起来、停干净"。

export function appendProcessOutput(stream, channel, onLine) {
  if (!stream) return
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    buffer += chunk
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed) {
        // 日志脱敏：dsh 的启动行里带着本机访问令牌，只有回调方需要原文。
        console[channel](`[dsh] ${stripLaunchToken(trimmed)}`)
        onLine?.(trimmed)
      }
    }
  })
}

// dsh web 的启动命令固定为 `dsh web --no-open --port <port>`：桌面端自己加载
// Web UI，所以不让 dsh 打开系统浏览器。
export function spawnHarness({
  nodePath,
  binPath,
  port,
  cwd,
  env,
  onStdoutLine,
  onStderrLine,
  onError,
  onExit,
}) {
  const child = spawn(
    nodePath,
    [binPath, 'web', '--no-open', '--port', String(port)],
    {
      cwd,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )
  appendProcessOutput(child.stdout, 'log', onStdoutLine)
  appendProcessOutput(child.stderr, 'error', onStderrLine)
  child.once('error', onError)
  child.once('exit', onExit)
  return child
}

export function stopHarnessProcess(child) {
  if (!child || child.killed) return

  // Windows 没有面向子进程的进程组信号：child.kill('SIGTERM') 只会结束直接
  // 子进程，而 dsh web 还会派生自己的子进程，它们会在应用退出后变成孤儿进程
  // 继续占用端口。taskkill /T 会连同整棵进程树一起结束。
  if (process.platform === 'win32' && typeof child.pid === 'number') {
    const killer = spawn(windowsSystemBinary('taskkill'), ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    killer.on('error', (error) => {
      console.warn('[dsh] unable to terminate the harness process tree', error)
      child.kill('SIGKILL')
    })
    return
  }

  child.kill('SIGTERM')
  const timer = setTimeout(() => {
    if (child.exitCode === null) child.kill('SIGKILL')
  }, 5_000)
  timer.unref()
}
