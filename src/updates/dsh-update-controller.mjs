import path from 'node:path'
import { isDshUpdateRequired } from '../dsh-runtime.mjs'
// describeError 统一来自 redaction.mjs：出错信息里可能带出含凭据的软件源 URL。
import { describeError } from '../redaction.mjs'
import {
  DSH_UPDATE_CHECK_INTERVAL_MS,
  dshUpdateMenuLabel,
  dshUpdateNoticePath,
  isDshUpdateCoolingDown,
  isDshUpdateNotified,
  readDshUpdateNotice,
  writeDshUpdateNotice,
} from './dsh-update.mjs'
import { createLaunchPreparer } from './dsh-update-launch.mjs'
import { createInstallRunner, createVersionResolver } from './dsh-update-tasks.mjs'

// Harness（@deepseek-ai/dsh）更新控制器：负责"查版本 → 决定是否提示 → 执行 npm
// 安装 → 重启 Harness"这条链路。所有更新动作都由主进程驱动（启动流程、托盘菜单、
// 主进程定时器），不向渲染进程（Harness Web UI 属于第三方页面代码）暴露任何入口。
//
// 分工：版本查询与 npm 安装 → dsh-update-tasks.mjs；启动前决策 →
// dsh-update-launch.mjs；纯逻辑（版本比对/文案/节流）→ dsh-update.mjs。

// 手动检查后"无需更新"的提示文案：离线时不能说"已是最新版本"，那会让人误以为
// 网络检查通过了。独立成模块级纯函数，既减少分支嵌套，也避免嵌套模板字符串（S4624）。
function upToDateDialog({ stale, latestVersion, installedVersion }) {
  if (!stale) {
    return {
      type: 'info',
      title: 'Harness 更新',
      message: `当前已是最新版本 v${installedVersion}。`,
    }
  }
  const suffix = latestVersion ? `（v${latestVersion}）` : ''
  return {
    type: 'info',
    title: 'Harness 更新',
    message: '无法联网检查 Harness 更新。',
    detail: `已使用最近一次检查结果${suffix}，如已安装将继续使用当前版本。`,
  }
}

export function createDshUpdateController({
  fetchImpl,
  reportStatus,
  showMessageBox,
  userDataPath,
  getRuntime,
  stopHarness,
  restartHarness,
  onInstallationChanged,
  installDsh,
}) {
  const noticePath = dshUpdateNoticePath(userDataPath)
  const resolver = createVersionResolver({
    fetchImpl,
    reportStatus,
    cachePath: path.join(userDataPath, 'cache', 'dsh-update.json'),
  })
  const runner = createInstallRunner({
    installDsh,
    reportStatus,
    onInstallationChanged,
    noticePath,
  })
  let state = { status: 'idle', installedVersion: null, latestVersion: null, error: null }
  let checkTask = null
  let updateTask = null
  let failedAt = 0
  let updateInterval = null

  function setState(values) {
    state = { ...state, ...values }
  }

  function markFailed(error, failureKind = 'update') {
    failedAt = Date.now()
    setState({ status: 'failed', error: describeError(error), failureKind })
  }

  const launchPreparer = createLaunchPreparer({
    resolver,
    runner,
    reportStatus,
    showMessageBox,
    noticePath,
    store: { setState, markFailed, getState: () => state },
  })

  // 启动前的版本决策，见 dsh-update-launch.mjs。
  function prepareForLaunch({ nodeEnvironment, installed, env }) {
    return launchPreparer.prepare({ nodeEnvironment, installed, env })
  }

  // 运行中执行更新：先停 Harness（Windows 下覆盖正在运行的 dsh 文件会失败），
  // 安装完成后无论成功失败都重启，失败时用回原版本。
  function applyUpdate() {
    if (updateTask) return updateTask
    const runtime = getRuntime()
    const target = state.latestVersion
    if (!runtime?.installed || !target) return Promise.resolve()

    updateTask = (async () => {
      setState({ status: 'updating', error: null })
      reportStatus({
        message: '正在更新 DeepSeek Harness',
        detail: `准备更新到 v${target} · 正在停止当前 Harness`,
      })
      stopHarness()
      let installation = null
      try {
        installation = await runner.install({
          nodeEnvironment: runtime.nodeEnvironment,
          env: runtime.env,
          version: target,
          registry: state.registry,
          isUpdate: true,
        })
        await runner.clearNotice()
        setState({ status: 'current', installedVersion: installation.version, error: null })
        reportStatus({
          message: 'Harness 已更新',
          detail: `正在用 v${installation.version} 重启 Harness`,
          progress: 100,
        })
      } catch (error) {
        console.error('[dsh] runtime update failed', describeError(error))
        markFailed(error)
        reportStatus({
          message: 'Harness 更新失败',
          detail: `继续使用已安装版本 ${runtime.installed.version}`,
          error: true,
        })
        await showMessageBox({
          type: 'error',
          title: 'Harness 更新失败',
          message: '无法更新 DeepSeek Harness，已继续使用当前版本。',
          detail: `${describeError(error)}\n\n可稍后从系统托盘菜单重试。`,
        })
      } finally {
        // 重启 Harness 期间不放行第二次更新：否则连点托盘会并发跑两遍 npm install。
        try {
          await restartHarness({ installation: installation ?? runtime.installed })
        } finally {
          updateTask = null
        }
      }
    })()
    return updateTask
  }

  // 启动流程还没跑完时的提示：只有手动操作才值得弹窗打扰。
  async function promptStartupPending(manual) {
    if (!manual) return
    await showMessageBox({
      type: 'info',
      title: 'Harness 更新',
      message: '启动流程尚未完成，请稍后再检查更新。',
    })
  }

  // 运行中发现新版本：同一版本只提示一次（落盘记忆），用户同意就立刻更新。
  async function promptNewVersion({ latestVersion, installedVersion }) {
    const notice = await readDshUpdateNotice(noticePath)
    if (isDshUpdateNotified(notice, latestVersion)) return false
    await writeDshUpdateNotice(noticePath, latestVersion)

    const { response } = await showMessageBox({
      type: 'info',
      title: '发现 Harness 新版本',
      message: `DeepSeek Harness v${latestVersion} 已发布，当前运行的是 v${installedVersion}。`,
      detail: '更新会重启 Harness，当前页面会重新加载。也可以稍后从系统托盘菜单更新。',
      buttons: ['立即更新', '稍后'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    return response === 0
  }

  // 运行中复查：发现未提示过的新版本时提示一次（落盘记忆），已提示过的只让
  // 托盘标签变化，不重复打断用户。
  function checkForUpdate({ manual = false } = {}) {
    if (checkTask || updateTask) return checkTask ?? Promise.resolve()
    if (!manual && isDshUpdateCoolingDown({ failedAt })) return Promise.resolve()

    checkTask = (async () => {
      try {
        const runtime = getRuntime()
        if (!runtime?.installed) {
          await promptStartupPending(manual)
          return null
        }
        const installedVersion = runtime.installed.version
        setState({ installedVersion })
        const resolved = await resolver.resolve({ installedVersion, force: manual })
        setState({
          latestVersion: resolved.version ?? null,
          registry: resolved.registry,
          stale: resolved.stale,
        })

        if (!isDshUpdateRequired(installedVersion, resolved.version)) {
          setState({ status: 'current', error: null })
          if (manual) {
            await showMessageBox(
              upToDateDialog({
                stale: resolved.stale,
                latestVersion: resolved.version,
                installedVersion,
              }),
            )
          }
          return null
        }

        setState({ status: 'available', error: null })
        const confirmed = await promptNewVersion({
          latestVersion: resolved.version,
          installedVersion,
        })
        if (confirmed) return await applyUpdate()
        return resolved.version
      } catch (error) {
        console.warn('[dsh] update check failed', describeError(error))
        markFailed(error, 'check')
        if (manual) {
          await showMessageBox({
            type: 'error',
            title: 'Harness 更新检查失败',
            message: '暂时无法检查 Harness 更新。',
            detail: describeError(error),
          })
        }
        return null
      } finally {
        checkTask = null
      }
    })()
    return checkTask
  }

  // 托盘常驻入口：有新版本时是"更新 Harness 到 vX"，否则是手动"检查更新"。
  async function handleMenuClick() {
    if (updateTask) return null
    const runtime = getRuntime()
    if (!runtime?.installed) {
      await promptStartupPending(true)
      return null
    }
    if (!isDshUpdateRequired(runtime.installed.version, state.latestVersion)) {
      return checkForUpdate({ manual: true })
    }
    const { response } = await showMessageBox({
      type: 'info',
      title: '更新 DeepSeek Harness',
      message: `将更新到 v${state.latestVersion}（当前 v${runtime.installed.version}）。`,
      detail: '更新会先停止当前 Harness，完成后自动重启，当前页面会重新加载。',
      buttons: ['立即更新', '取消'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    if (response === 0) return applyUpdate()
    return null
  }

  function menuItem() {
    return {
      label: dshUpdateMenuLabel(state),
      enabled: state.status !== 'updating',
      // 返回 promise 便于单元测试等待；Electron 的菜单点击会忽略返回值。
      click: () => handleMenuClick(),
    }
  }

  function schedule() {
    updateInterval = setInterval(() => {
      // checkForUpdate 内部已经处理了所有异常，这里不需要再挂 catch。
      checkForUpdate()
    }, DSH_UPDATE_CHECK_INTERVAL_MS)
    updateInterval.unref?.()
  }

  function dispose() {
    if (updateInterval) clearInterval(updateInterval)
    runner.dispose()
  }

  return {
    prepareForLaunch,
    checkForUpdate,
    menuItem,
    schedule,
    dispose,
    get state() {
      return state
    },
  }
}
