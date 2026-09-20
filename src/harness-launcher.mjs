import path from 'node:path'
import { buildHarnessEnvironment, findUserDshInstallation, parseDshLaunchUrl } from './dsh-runtime.mjs'
import { resolveNodeEnvironment } from './node-runtime.mjs'
import { summarizeHarnessFailure } from './harness-diagnostics.mjs'
import { describeError, stripLaunchToken } from './redaction.mjs'
import { writeStartupCache } from './startup-cache.mjs'
import {
  allocatePort,
  createNodeProgressReporter,
  readUsableStartupCache,
  resolveWorkspacePath,
  startupCachePath,
} from './harness-environment.mjs'
import { spawnHarness, stopHarnessProcess } from './harness-process.mjs'

const STARTUP_TIMEOUT_MS = 10 * 60_000
// 启动失败时用于回溯原因的 dsh 输出行数上限。
const HARNESS_OUTPUT_LIMIT = 200

// 显式指定了 Node.js 或 dsh 时说明用户在排查/开发，缓存会掩盖真实环境，跳过。
function shouldUseStartupCache() {
  return !process.env.DSH_DESKTOP_NODE && !process.env.DSH_DESKTOP_DSH
}

// Harness 启动编排：环境解析 → 启动缓存 → 版本准备（交给 dsh 更新控制器）→
// 拉起 dsh web → 等待本地服务就绪 → 加载 Web UI。子进程的机械操作在
// harness-process.mjs，环境探测在 harness-environment.mjs。
export function createHarnessLauncher({
  app,
  userDataPath,
  fetchImpl,
  reportStatus,
  loadLoadingPage,
  loadUrl,
  isQuitting,
  dshCommand,
  dshUpdate,
}) {
  const runtimeRoot = path.join(userDataPath, 'runtime')
  const cachePath = startupCachePath(userDataPath)
  let child = null
  let startupPromise = null
  let harnessReady = false
  let harnessOrigin = null
  let harnessLaunchUrl = null
  let nodeEnvironment = null
  let installed = null

  function stop() {
    const current = child
    child = null
    harnessReady = false
    stopHarnessProcess(current)
  }

  async function resolveEnvironment() {
    const startupCache = await readUsableStartupCache(cachePath, shouldUseStartupCache())
    if (startupCache) {
      nodeEnvironment = startupCache.nodeEnvironment
      installed = startupCache.dshInstallation
      reportStatus({
        message: '正在复用上次运行环境',
        detail: `${nodeEnvironment.source === 'system' ? '用户' : '应用私有'} Node.js ${nodeEnvironment.version} · Harness ${installed.version}`,
      })
      return
    }

    reportStatus({ message: '正在检查运行环境', detail: '查找兼容的 Node.js 与 npx' })
    nodeEnvironment = await resolveNodeEnvironment({
      runtimeRoot,
      platform: process.platform,
      arch: process.arch,
      fetchImpl,
      onProgress: createNodeProgressReporter(reportStatus),
    })
    const baseEnvironment = buildHarnessEnvironment(nodeEnvironment)
    installed = await findUserDshInstallation({
      nodeEnvironment,
      platform: process.platform,
      env: baseEnvironment,
      includePath: nodeEnvironment.source === 'system',
    })
  }

  // 更新控制器在装完新版本后调用：把新的 dsh 安装写回启动缓存，否则下次启动
  // 仍会从缓存里读到旧版本号，于是又提示一次刚装好的版本。
  async function rememberInstallation(installation) {
    if (!shouldUseStartupCache() || !nodeEnvironment || !installation) return
    try {
      await writeStartupCache(cachePath, nodeEnvironment, installation)
    } catch (error) {
      console.warn('[startup] unable to persist environment cache', error)
    }
  }

  async function waitForHarness(url, process, getLaunchUrl, timeoutMs = STARTUP_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs
    let exited = false
    let exitCode = null
    let spawnFailure = null
    let firstUnauthorizedAt = 0
    process.once('exit', (code) => {
      exited = true
      exitCode = code
    })
    process.once('error', (error) => {
      // A failed spawn emits 'error' without ever emitting 'exit', so treat it
      // as a terminal failure instead of polling for the whole timeout window.
      spawnFailure = error
    })

    while (Date.now() < deadline) {
      if (spawnFailure) {
        throw new Error(`Harness 启动进程失败：${spawnFailure.message}`)
      }
      if (exited) throw new Error(`Harness 启动进程已退出（代码 ${exitCode ?? '未知'}）。`)
      const launchUrl = getLaunchUrl?.() ?? null
      if (firstUnauthorizedAt && !launchUrl && Date.now() - firstUnauthorizedAt >= 30_000) {
        throw new Error('Harness 需要浏览器认证，但未能从启动输出中读取访问链接。')
      }
      try {
        const response = await fetchImpl(launchUrl ?? url, {
          signal: AbortSignal.timeout(2_000),
        })
        if (response.ok) return launchUrl ?? url
        if (response.status === 401 && firstUnauthorizedAt === 0) {
          firstUnauthorizedAt = Date.now()
        }
      } catch {
        // The local server is still starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    throw new Error(`Harness 在 ${Math.round(timeoutMs / 1000)} 秒内未能启动。`)
  }

  function handleUnexpectedExit(process, output, code, signal) {
    if (!harnessReady || child !== process || isQuitting()) return
    child = null
    harnessOrigin = null
    harnessLaunchUrl = null
    const exitReason = signal ?? `代码 ${code ?? '未知'}`
    loadLoadingPage()
      .then(() => {
        const summary = stripLaunchToken(summarizeHarnessFailure(output))
        reportStatus({
          message: 'Harness 已停止',
          detail: summary
            ? `后台进程意外退出（${exitReason}）。\n${summary}`
            : `后台进程意外退出（${exitReason}）。`,
          error: true,
        })
      })
      .catch((error) => {
        console.warn('[dsh] unable to restore the loading page', error)
      })
  }

  function startHarnessProcess(port, workspacePath, harnessEnvironment) {
    // 保留最近的子进程输出：启动失败时要把 dsh 真正报的错带到启动页，
    // 否则用户只能看到“进程意外退出（代码 1）”。
    const output = []
    let authenticatedUrl = null
    const record = (line) => {
      output.push(line)
      if (output.length > HARNESS_OUTPUT_LIMIT) output.shift()
    }
    const process = spawnHarness({
      nodePath: nodeEnvironment.nodePath,
      binPath: installed.binPath,
      port,
      cwd: workspacePath,
      env: harnessEnvironment,
      onStdoutLine: (line) => {
        record(line)
        // dsh web protects its UI with a per-process launch token printed on
        // stdout ("dsh web: http://127.0.0.1:PORT/?token=..."); the first request
        // carrying the token exchanges it for a signed session cookie.
        if (!authenticatedUrl) {
          const launchUrl = parseDshLaunchUrl(line, { port })
          if (launchUrl) {
            authenticatedUrl = launchUrl
            harnessLaunchUrl = launchUrl
          }
        }
      },
      onStderrLine: record,
      onError: (error) => {
        console.error('[dsh] process error', error)
      },
      onExit: (code, signal) => handleUnexpectedExit(process, output, code, signal),
    })
    return { process, output, getLaunchUrl: () => authenticatedUrl }
  }

  async function launch() {
    await resolveEnvironment()

    const runtimeLabel = nodeEnvironment.source === 'system' ? '用户 Node.js' : '应用私有 Node.js'
    reportStatus({
      message: '运行环境已就绪',
      detail: `使用${runtimeLabel} ${nodeEnvironment.version}（${process.platform}/${process.arch}）`,
    })

    const baseEnvironment = buildHarnessEnvironment(nodeEnvironment)
    const prepared = await dshUpdate.prepareForLaunch({
      nodeEnvironment,
      installed,
      env: baseEnvironment,
    })
    installed = prepared.installation
    await rememberInstallation(installed)

    const port = await allocatePort()
    const url = `http://127.0.0.1:${port}`
    const workspacePath = await resolveWorkspacePath(app)
    const harnessEnvironment = buildHarnessEnvironment(nodeEnvironment, [installed.binDir])
    await dshCommand.loadState()
    await dshCommand.refresh(nodeEnvironment, installed)

    const session = startHarnessProcess(port, workspacePath, harnessEnvironment)
    child = session.process

    reportStatus({
      message: '正在等待 Harness 界面',
      detail: [`启动版本 ${installed.version}`, url, prepared.notice].filter(Boolean).join(' · '),
    })
    let readyUrl
    try {
      readyUrl = await waitForHarness(url, child, session.getLaunchUrl)
    } catch (error) {
      // 附上 dsh 自己报的错，插件缺失、端口占用这类问题才可自助排查。
      const summary = stripLaunchToken(summarizeHarnessFailure(session.output))
      throw summary ? new Error(`${error.message}\n${summary}`) : error
    }
    harnessReady = true
    harnessOrigin = new URL(url).origin
    reportStatus({ message: 'Harness 已启动', detail: url, progress: 100 })
    await loadUrl(readyUrl)
    await dshCommand.promptOnce()
  }

  async function start() {
    if (startupPromise) return startupPromise
    startupPromise = (async () => {
      stop()
      harnessOrigin = null
      harnessLaunchUrl = null
      await loadLoadingPage()
      try {
        await launch()
      } catch (error) {
        stop()
        console.error(error)
        reportStatus({
          message: '启动失败',
          detail: describeError(error),
          error: true,
        })
      } finally {
        startupPromise = null
      }
    })()
    return startupPromise
  }

  return {
    start,
    stop,
    rememberInstallation,
    get installed() {
      return installed
    },
    get nodeEnvironment() {
      return nodeEnvironment
    },
    // 运行中的更新需要"当前 Node.js 环境 + 当前安装"，用于执行 npm 全局安装。
    get runtime() {
      if (!nodeEnvironment || !installed) return null
      return {
        nodeEnvironment,
        env: buildHarnessEnvironment(nodeEnvironment),
        installed,
      }
    },
    get origin() {
      return harnessOrigin
    },
    get launchUrl() {
      return harnessLaunchUrl
    },
  }
}
