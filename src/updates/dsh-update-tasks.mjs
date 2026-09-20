import { rm } from 'node:fs/promises'
import {
  DSH_PACKAGE_NAME,
  readDshUpdateCache,
  updateGlobalDsh,
  writeDshUpdateCache,
} from '../dsh-runtime.mjs'
import {
  fetchLatestDshVersion,
  registryDisplayName,
  resolveDshRegistries,
} from '../dsh-registry.mjs'
import { isDshUpdateCacheFresh } from './dsh-update.mjs'
import { describeError } from '../redaction.mjs'

// 版本查询：优先复用缓存（成功 6 小时 / 失败 5 分钟），否则依次查询 npm 官方源与
// 国内镜像；查询失败时退回上次已知版本，让应用仍能用已安装版本启动。
export function createVersionResolver({ fetchImpl, reportStatus, cachePath }) {
  async function resolve({ installedVersion = null, force = false } = {}) {
    const cached = await readDshUpdateCache(cachePath)
    const fresh = isDshUpdateCacheFresh({
      checkedAt: cached?.checkedAt,
      successful: cached?.successful,
    })
    if (!force && fresh) {
      reportStatus({
        message: 'Harness 版本检查完成',
        detail: `复用最近检查结果 ${cached.version}`,
      })
      return { version: cached.version, registry: cached.registry ?? null, stale: false }
    }

    reportStatus({ message: '正在检查 Harness 更新', detail: '依次查询 npm 官方源与国内镜像' })
    try {
      const { version, registry } = await fetchLatestDshVersion({
        fetchImpl,
        registries: resolveDshRegistries(),
      })
      await writeDshUpdateCache(cachePath, version, Date.now(), true, registry)
      if (!registry.includes('registry.npmjs.org')) {
        reportStatus({
          message: 'Harness 版本检查完成',
          detail: `使用镜像源 ${registryDisplayName(registry)}`,
        })
      }
      return { version, registry, stale: false }
    } catch (error) {
      // 失败原因里可能带出含凭据的软件源 URL，日志前统一脱敏。
      console.warn('[dsh] update check failed', describeError(error))
      reportStatus({
        message: '无法联网检查 Harness 更新',
        detail: '如已安装，将继续使用当前版本',
      })
      const fallbackVersion = cached?.version ?? installedVersion
      if (fallbackVersion) {
        try {
          await writeDshUpdateCache(
            cachePath,
            fallbackVersion,
            Date.now(),
            false,
            cached?.registry ?? null,
          )
        } catch (cacheError) {
          console.warn('[dsh] unable to cache failed update check', cacheError)
        }
      }
      // stale=true：这个版本号不是刚联网查到的，调用方不能据此宣称"已是最新版本"。
      return { version: fallbackVersion ?? null, registry: cached?.registry ?? null, stale: true }
    }
  }

  return { resolve }
}

// npm 安装执行器：把"阶段 + 已用时"持续喂给启动页与托盘（npm 拿不到精确百分比，
// 让画面持续变化才不会像卡死），并在装完后回调新的安装信息。
export function createInstallRunner({
  installDsh = updateGlobalDsh,
  reportStatus,
  onInstallationChanged,
  noticePath,
}) {
  let progressTimer = null

  function startElapsedProgress(message, detail) {
    const startedAt = Date.now()
    const render = () => {
      const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000))
      reportStatus({ message, detail: `${detail} · 已用时 ${seconds} 秒` })
    }
    render()
    progressTimer = setInterval(render, 1_000)
    progressTimer.unref?.()
  }

  function stopElapsedProgress() {
    if (!progressTimer) return
    clearInterval(progressTimer)
    progressTimer = null
  }

  async function install({ nodeEnvironment, env, version, registry, isUpdate }) {
    const scope = nodeEnvironment.source === 'system' ? '用户全局环境' : '应用私有环境'
    startElapsedProgress(
      isUpdate ? '正在更新 DeepSeek Harness' : '正在安装 DeepSeek Harness',
      `${scope} · ${DSH_PACKAGE_NAME}@${version}`,
    )
    try {
      const installation = await installDsh({
        nodeEnvironment,
        version,
        platform: process.platform,
        env,
        registry,
      })
      if (!installation) throw new Error('npm 完成后未找到 dsh 全局安装')
      await onInstallationChanged?.(installation)
      return installation
    } finally {
      stopElapsedProgress()
    }
  }

  async function clearNotice() {
    try {
      await rm(noticePath, { force: true })
    } catch (error) {
      console.warn('[dsh] unable to reset the update notice', error)
    }
  }

  function dispose() {
    stopElapsedProgress()
  }

  return { install, clearNotice, dispose }
}
