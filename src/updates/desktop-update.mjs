import { chmod, copyFile, readdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { downloadReleaseAsset, fetchAvailableUpdate } from '../app-update.mjs'

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60_000
const DESKTOP_UPDATE_READY_MAX_AGE_MS = 48 * 60 * 60_000

// 同一时间只保留最新版本的下载目录，避免旧安装包长期占着磁盘。
async function removeOldUpdates(updatesRoot, keepDirectory) {
  let entries
  try {
    entries = await readdir(updatesRoot, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name !== keepDirectory)
      .map((entry) => rm(path.join(updatesRoot, entry.name), { recursive: true, force: true })),
  )
}

// Linux AppImage 可以原位替换并重启，其他平台交给系统安装界面。
function resolveInstallLabel(file, platform = process.platform) {
  if (platform === 'linux' && file.endsWith('.AppImage')) return '重启并更新'
  return platform === 'win32' ? '退出并安装' : '打开安装包'
}

// 桌面端自身的自动更新控制器：读 Release 清单 → 后台下载校验 → 弹窗/托盘提示安装
//（被忽略的下载状态 48 小时后过期）；app / shell 由 main.mjs 注入而不是直接 import
// electron，这样本模块能在 Node 单元测试里用假 Electron 驱动完整流程。
export function createDesktopUpdateController({
  app,
  shell,
  fetchImpl,
  isPortableBuild,
  userDataPath,
  showMessageBox,
  quitApplication,
  appImagePath = process.env.APPIMAGE,
  fetchUpdate = fetchAvailableUpdate,
  downloadUpdate = downloadReleaseAsset,
  now = Date.now,
  platform = process.platform,
}) {
  let desktopUpdateCheck = null
  let desktopUpdateTimeout = null
  let desktopUpdateInterval = null
  let desktopUpdateState = { status: 'idle', progress: null, update: null, file: null }
  let desktopUpdatePrompt = null

  function setState(status, values = {}) {
    const has = (key) => Object.hasOwn(values, key)
    desktopUpdateState = {
      status,
      progress: values.progress ?? null,
      update: has('update') ? values.update : desktopUpdateState.update,
      file: has('file') ? values.file : desktopUpdateState.file,
      error: values.error ?? null,
      readyAt: status === 'ready' ? now() : null,
    }
  }

  function menuLabel() {
    if (isPortableBuild) return `便携版 v${app.getVersion()}（手动更新）`
    const version = desktopUpdateState.update?.manifest.version
    switch (desktopUpdateState.status) {
      case 'checking':
        return '正在检查桌面端更新…'
      case 'downloading':
        return `正在下载桌面端 v${version}（${desktopUpdateState.progress ?? 0}%）`
      case 'ready':
        return `安装桌面端更新 v${version}`
      case 'installing':
        return `正在打开桌面端 v${version} 安装包…`
      default:
        return `检查桌面端更新（当前 v${app.getVersion()}）`
    }
  }

  function menuItem() {
    const busy = ['checking', 'downloading', 'installing'].includes(desktopUpdateState.status)
    return {
      label: menuLabel(),
      enabled: !busy,
      click: () => {
        if (desktopUpdateState.status === 'ready') void prompt()
        else void check({ manual: true })
      },
    }
  }

  async function replaceCurrentAppImage(downloadedFile) {
    const currentAppImage = appImagePath
    if (!currentAppImage || !path.isAbsolute(currentAppImage)) {
      throw new Error('无法定位当前 AppImage。')
    }

    const stagedFile = `${currentAppImage}.update`
    await rm(stagedFile, { force: true })
    try {
      await copyFile(downloadedFile, stagedFile)
      await chmod(stagedFile, 0o755)
      await rename(stagedFile, currentAppImage)
    } catch (error) {
      await rm(stagedFile, { force: true })
      throw error
    }

    app.relaunch({ execPath: currentAppImage })
    quitApplication()
  }

  async function install() {
    const { update, file } = desktopUpdateState
    if (!update || !file || desktopUpdateState.status !== 'ready') return
    setState('installing', { update, file })

    try {
      if (platform === 'linux' && file.endsWith('.AppImage')) {
        await replaceCurrentAppImage(file)
        return
      }

      if (platform === 'win32') {
        const openError = await shell.openPath(file)
        if (openError) throw new Error(openError)
        quitApplication()
        return
      }

      const openError = await shell.openPath(file)
      if (openError) throw new Error(openError)
      setState('ready', { update, file })
    } catch (error) {
      console.error('[desktop-update] install failed', error)
      setState('ready', { update, file, error })
      await showMessageBox({
        type: 'error',
        title: '无法安装更新',
        message: '无法打开桌面端更新',
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async function prompt() {
    if (desktopUpdatePrompt) return desktopUpdatePrompt
    const { update, file } = desktopUpdateState
    if (!update || !file || desktopUpdateState.status !== 'ready') return

    const version = update.manifest.version
    const installLabel = resolveInstallLabel(file, platform)

    desktopUpdatePrompt = showMessageBox({
      type: 'info',
      title: '桌面端更新已就绪',
      message: `DeepSeek Harness Desktop v${version} 已下载并通过完整性校验。`,
      detail:
        platform === 'darwin'
          ? '打开 DMG 后，请将新版本拖入“应用程序”文件夹完成更新。'
          : '现在安装，或稍后从系统托盘菜单继续。',
      buttons: [installLabel, '稍后'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
      .then(({ response }) => {
        if (response === 0) return install()
      })
      .finally(() => {
        desktopUpdatePrompt = null
      })
    return desktopUpdatePrompt
  }

  async function runCheck({ manual = false } = {}) {
    setState('checking', { update: null, file: null })
    try {
      const update = await fetchUpdate({
        fetchImpl,
        currentVersion: app.getVersion(),
        platform,
        arch: process.arch,
        isAppImage: Boolean(appImagePath),
      })
      if (!update) {
        setState('current', { update: null, file: null })
        if (manual) {
          await showMessageBox({
            type: 'info',
            title: '桌面端更新',
            message: `当前已是最新版本 v${app.getVersion()}。`,
          })
        }
        return null
      }

      setState('downloading', { update, file: null, progress: 0 })
      const updatesRoot = path.join(userDataPath, 'updates')
      const versionDirectory = `v${update.manifest.version}`
      const destination = path.join(updatesRoot, versionDirectory, update.asset.name)
      const file = await downloadUpdate({
        fetchImpl,
        asset: update.asset,
        destination,
        onProgress: ({ received, total }) => {
          const progress = total ? Math.min(100, Math.round((received / total) * 100)) : null
          setState('downloading', { update, progress })
        },
      })
      try {
        await removeOldUpdates(updatesRoot, versionDirectory)
      } catch (error) {
        console.warn('[desktop-update] unable to remove old downloads', error)
      }
      setState('ready', { update, file, progress: 100 })
      await prompt()
      return update
    } catch (error) {
      console.warn('[desktop-update] check failed', error)
      setState('error', { update: null, file: null, error })
      throw error
    }
  }

  async function check({ manual = false } = {}) {
    if (!app.isPackaged) {
      if (manual) {
        await showMessageBox({
          type: 'info',
          title: '桌面端更新',
          message: '开发模式不会检查桌面端更新。',
        })
      }
      return
    }
    if (isPortableBuild) {
      if (manual) {
        await showMessageBox({
          type: 'info',
          title: '桌面端更新',
          message: `当前是便携版 v${app.getVersion()}。`,
          detail: '便携版不会自动安装新版本，请从发布页下载新的便携版文件后替换。',
        })
      }
      return
    }
    if (desktopUpdateState.status === 'ready') {
      const readyAt = desktopUpdateState.readyAt ?? 0
      if (now() - readyAt >= DESKTOP_UPDATE_READY_MAX_AGE_MS) {
        // An ignored download must not shadow newer releases forever: expire the
        // pending state and fall through to a fresh check. A still-current
        // package is reused from the verified download cache.
        setState('idle', { update: null, file: null })
      } else {
        if (manual) await prompt()
        return
      }
    }
    if (desktopUpdateCheck) return desktopUpdateCheck

    desktopUpdateCheck = (async () => {
      try {
        await runCheck({ manual })
      } catch (error) {
        if (manual) {
          await showMessageBox({
            type: 'error',
            title: '检查更新失败',
            message: '暂时无法检查桌面端更新。',
            detail: error instanceof Error ? error.message : String(error),
          })
        }
      } finally {
        desktopUpdateCheck = null
      }
    })()
    return desktopUpdateCheck
  }

  function schedule() {
    desktopUpdateTimeout = setTimeout(() => {
      void check()
    }, 5_000)
    desktopUpdateInterval = setInterval(() => {
      void check()
    }, UPDATE_CHECK_INTERVAL_MS)
    desktopUpdateTimeout.unref()
    desktopUpdateInterval.unref()
  }

  function dispose() {
    if (desktopUpdateTimeout) clearTimeout(desktopUpdateTimeout)
    if (desktopUpdateInterval) clearInterval(desktopUpdateInterval)
  }

  return { menuItem, check, schedule, dispose }
}
