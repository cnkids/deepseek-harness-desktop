import { spawn } from 'node:child_process'
import { chmod, copyFile, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net as electronNet,
  session,
  shell,
  Tray,
} from 'electron'
import {
  downloadReleaseAsset,
  fetchAvailableUpdate,
} from './app-update.mjs'
import {
  createApplicationMenuTemplate,
  createWebContextMenuTemplate,
} from './edit-menu.mjs'
import { summarizeHarnessFailure } from './harness-diagnostics.mjs'
import { fetchLatestDshVersion, resolveDshRegistries } from './dsh-registry.mjs'
import {
  buildHarnessEnvironment,
  DSH_PACKAGE_NAME,
  findUserDshInstallation,
  isDshUpdateRequired,
  parseDshLaunchUrl,
  readDshUpdateCache,
  updateGlobalDsh,
  writeDshUpdateCache,
} from './dsh-runtime.mjs'
import { resolveNodeEnvironment } from './node-runtime.mjs'
import { createHarnessConsoleLaunch, findLinuxTerminal } from './harness-console.mjs'
import {
  isAllowedNavigationUrl,
  isAllowedRendererPermission,
  isTrustedIpcSender,
} from './security-policy.mjs'
import { readStartupCache, writeStartupCache } from './startup-cache.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STARTUP_TIMEOUT_MS = 10 * 60_000
const DSH_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60_000
const DSH_UPDATE_RETRY_INTERVAL_MS = 5 * 60_000
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60_000
const DESKTOP_UPDATE_READY_MAX_AGE_MS = 48 * 60 * 60_000
const LOADING_HTML_PATH = path.join(__dirname, 'loading.html')
// 启动失败时用于回溯原因的 dsh 输出行数上限。
const HARNESS_OUTPUT_LIMIT = 200
// electron-builder 的便携版会把可执行文件所在目录写入该变量。便携版不能像
// 安装版那样用 NSIS 安装包覆盖自己，因此只提示手动下载新版本。
const IS_PORTABLE_BUILD =
  process.platform === 'win32' && Boolean(process.env.PORTABLE_EXECUTABLE_DIR)

let mainWindow = null
let tray = null
let dshProcess = null
let startupPromise = null
let harnessOrigin = null
let harnessLaunchUrl = null
let isQuitting = false
let desktopUpdateCheck = null
let desktopUpdateTimeout = null
let desktopUpdateInterval = null
let desktopUpdateState = { status: 'idle', progress: null, update: null, file: null }
let desktopUpdatePrompt = null
// 上次成功启动 Harness 时解析出的环境，供托盘里的「打开 Harness 命令行」复用。
let harnessConsoleContext = null

function emitStatus(message, detail = '', progress = null, error = false) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('runtime-status', { message, detail, progress, error })
}

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function reportNodeProgress(event) {
  switch (event.phase) {
    case 'download-start':
      emitStatus(
        '正在安装私有 Node.js',
        event.source === 'mirror' ? `通过国内镜像下载 ${event.file}` : `准备下载 ${event.file}`,
        0,
      )
      break
    case 'download': {
      const progress = event.total ? Math.round((event.received / event.total) * 100) : null
      const total = event.total ? ` / ${formatBytes(event.total)}` : ''
      emitStatus(
        '正在下载私有 Node.js',
        `${formatBytes(event.received)}${total}`,
        progress,
      )
      break
    }
    case 'verify':
      emitStatus('正在校验 Node.js', '验证官方安装包的 SHA-256', 100)
      break
    case 'extract':
      emitStatus('正在安装私有 Node.js', '正在解压应用私有运行时', null)
      break
    default:
      break
  }
}

async function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : null
      server.close((error) => {
        if (error) reject(error)
        else if (port) resolve(port)
        else reject(new Error('无法分配本地端口。'))
      })
    })
  })
}

function appendProcessOutput(stream, channel, onLine) {
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
        console[channel](`[dsh] ${trimmed}`)
        onLine?.(trimmed)
      }
    }
  })
}

async function waitForHarness(url, child, getLaunchUrl, timeoutMs = STARTUP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  let exited = false
  let exitCode = null
  let spawnFailure = null
  let firstUnauthorizedAt = 0
  child.once('exit', (code) => {
    exited = true
    exitCode = code
  })
  child.once('error', (error) => {
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
      const response = await electronNet.fetch(launchUrl ?? url, {
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

async function resolveLatestDshVersion(installedVersion = null) {
  const cachePath = path.join(app.getPath('userData'), 'cache', 'dsh-update.json')
  const cached = await readDshUpdateCache(cachePath)
  const cacheMaxAge = cached?.successful
    ? DSH_UPDATE_CHECK_INTERVAL_MS
    : DSH_UPDATE_RETRY_INTERVAL_MS
  if (cached && Date.now() - cached.checkedAt < cacheMaxAge) {
    emitStatus('Harness 版本检查完成', `复用最近检查结果 ${cached.version}`, null)
    return { version: cached.version, registry: cached.registry ?? null }
  }

  emitStatus('正在检查 Harness 更新', '依次查询 npm 官方源与国内镜像', null)
  try {
    const { version, registry } = await fetchLatestDshVersion({
      fetchImpl: electronNet.fetch,
      registries: resolveDshRegistries(),
    })
    await writeDshUpdateCache(cachePath, version, Date.now(), true, registry)
    if (!registry.includes('registry.npmjs.org')) {
      emitStatus('Harness 版本检查完成', `使用镜像源 ${registry}`, null)
    }
    return { version, registry }
  } catch (error) {
    console.warn('[dsh] update check failed', error)
    emitStatus('无法联网检查 Harness 更新', '如已安装，将继续使用当前版本', null)
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
    return { version: fallbackVersion, registry: cached?.registry ?? null }
  }
}

function stopHarness() {
  const child = dshProcess
  dshProcess = null
  if (!child || child.killed) return

  // Windows 没有面向子进程的进程组信号：child.kill('SIGTERM') 只会结束直接
  // 子进程，而 dsh web 还会派生自己的子进程，它们会在应用退出后变成孤儿进程
  // 继续占用端口。taskkill /T 会连同整棵进程树一起结束。
  if (process.platform === 'win32' && typeof child.pid === 'number') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
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

async function prepareDshInstallation(nodeEnvironment, latestVersion, env, installed, registry = null) {
  const isSystemRuntime = nodeEnvironment.source === 'system'
  const scopeLabel = isSystemRuntime ? '用户全局环境' : '应用私有环境'

  if (installed && !isDshUpdateRequired(installed.version, latestVersion)) {
    const versionState = latestVersion ? '已是最新版本' : '使用已安装版本'
    emitStatus('DeepSeek Harness 已就绪', `${versionState} ${installed.version} · ${scopeLabel}`, null)
    return installed
  }

  const targetVersion = latestVersion ?? 'latest'
  const isUpdate = Boolean(installed)
  emitStatus(
    isUpdate ? '正在更新 DeepSeek Harness' : '正在安装 DeepSeek Harness',
    `${scopeLabel} · ${DSH_PACKAGE_NAME}@${targetVersion}`,
    null,
  )

  try {
    const installation = await updateGlobalDsh({
      nodeEnvironment,
      version: targetVersion,
      platform: process.platform,
      env,
      registry,
    })
    if (!installation) throw new Error('npm 完成后未找到 dsh 全局安装')
    return installation
  } catch (error) {
    if (installed) {
      console.warn('[dsh] update failed, using installed version', error)
      emitStatus(
        'Harness 更新失败',
        `继续使用已安装版本 ${installed.version} · ${scopeLabel}`,
        null,
      )
      return installed
    }
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`无法在${scopeLabel}安装 DeepSeek Harness：${reason}`)
  }
}

async function resolveWorkspacePath() {
  // 打包后默认在用户的“文档”目录中运行 Harness。OneDrive 重定向、目录被删除
  // 或组策略移除都会让 app.getPath 指向不存在的位置，导致 spawn 以 ENOENT
  // 直接失败，因此依次回退到主目录与应用数据目录。
  const candidates = app.isPackaged ? ['documents', 'home', 'userData'] : []
  for (const name of candidates) {
    try {
      const directory = app.getPath(name)
      if ((await stat(directory)).isDirectory()) return directory
    } catch {
      // 该候选目录不可用，继续尝试下一个。
    }
  }
  return process.cwd()
}

async function launchHarness() {
  const runtimeRoot = path.join(app.getPath('userData'), 'runtime')
  const startupCachePath = path.join(app.getPath('userData'), 'cache', 'startup.json')
  const shouldUseStartupCache =
    !process.env.DSH_DESKTOP_NODE && !process.env.DSH_DESKTOP_DSH
  const startupCache = shouldUseStartupCache
    ? await readStartupCache(startupCachePath)
    : null

  let nodeEnvironment
  let installed
  if (startupCache) {
    nodeEnvironment = startupCache.nodeEnvironment
    installed = startupCache.dshInstallation
    emitStatus(
      '正在复用上次运行环境',
      `${nodeEnvironment.source === 'system' ? '用户' : '应用私有'} Node.js ${nodeEnvironment.version} · Harness ${installed.version}`,
      null,
    )
  } else {
    emitStatus('正在检查运行环境', '查找兼容的 Node.js 与 npx', null)
    nodeEnvironment = await resolveNodeEnvironment({
      runtimeRoot,
      platform: process.platform,
      arch: process.arch,
      fetchImpl: electronNet.fetch,
      onProgress: reportNodeProgress,
    })

    const baseEnvironment = buildHarnessEnvironment(nodeEnvironment)
    installed = await findUserDshInstallation({
      nodeEnvironment,
      platform: process.platform,
      env: baseEnvironment,
      includePath: nodeEnvironment.source === 'system',
    })
  }

  const runtimeLabel = nodeEnvironment.source === 'system' ? '用户 Node.js' : '应用私有 Node.js'
  emitStatus(
    '运行环境已就绪',
    `使用${runtimeLabel} ${nodeEnvironment.version}（${process.platform}/${process.arch}）`,
    null,
  )

  const baseEnvironment = buildHarnessEnvironment(nodeEnvironment)
  const { version: latestVersion, registry } = await resolveLatestDshVersion(installed?.version)
  const dshInstallation = await prepareDshInstallation(
    nodeEnvironment,
    latestVersion,
    baseEnvironment,
    installed,
    registry,
  )
  if (shouldUseStartupCache) {
    try {
      await writeStartupCache(startupCachePath, nodeEnvironment, dshInstallation)
    } catch (error) {
      console.warn('[startup] unable to persist environment cache', error)
    }
  }

  const port = await getAvailablePort()
  const url = `http://127.0.0.1:${port}`
  const workspacePath = await resolveWorkspacePath()
  harnessConsoleContext = { nodeEnvironment, dshInstallation, workspacePath }
  const harnessEnvironment = buildHarnessEnvironment(nodeEnvironment, [
    dshInstallation.binDir,
  ])

  const child = spawn(
    nodeEnvironment.nodePath,
    [
      dshInstallation.binPath,
      'web',
      '--no-open',
      '--port',
      String(port),
    ],
    {
      cwd: workspacePath,
      env: harnessEnvironment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )
  dshProcess = child
  let harnessReady = false
  let authenticatedUrl = null
  // 保留最近的子进程输出：启动失败时要把 dsh 真正报的错带到启动页，
  // 否则用户只能看到“进程意外退出（代码 1）”。
  const harnessOutput = []
  const recordHarnessLine = (line) => {
    harnessOutput.push(line)
    if (harnessOutput.length > HARNESS_OUTPUT_LIMIT) harnessOutput.shift()
  }
  appendProcessOutput(child.stdout, 'log', (line) => {
    recordHarnessLine(line)
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
  })
  appendProcessOutput(child.stderr, 'error', recordHarnessLine)
  child.once('error', (error) => {
    console.error('[dsh] process error', error)
  })
  child.once('exit', (code, signal) => {
    if (!harnessReady || dshProcess !== child || isQuitting) return
    dshProcess = null
    harnessOrigin = null
    harnessLaunchUrl = null
    const exitReason = signal ?? `代码 ${code ?? '未知'}`
    mainWindow
      .loadFile(LOADING_HTML_PATH)
      .then(() => {
        const summary = summarizeHarnessFailure(harnessOutput)
        emitStatus(
          'Harness 已停止',
          summary
            ? `后台进程意外退出（${exitReason}）。\n${summary}`
            : `后台进程意外退出（${exitReason}）。`,
          null,
          true,
        )
      })
      .catch((error) => {
        console.warn('[dsh] unable to restore the loading page', error)
      })
  })

  emitStatus(
    '正在等待 Harness 界面',
    `启动版本 ${dshInstallation.version} · ${url}`,
    null,
  )
  let readyUrl
  try {
    readyUrl = await waitForHarness(url, child, () => authenticatedUrl)
  } catch (error) {
    // 附上 dsh 自己报的错，插件缺失、端口占用这类问题才可自助排查。
    const summary = summarizeHarnessFailure(harnessOutput)
    throw summary ? new Error(`${error.message}\n${summary}`) : error
  }
  harnessReady = true
  harnessOrigin = new URL(url).origin
  emitStatus('Harness 已启动', url, 100)
  await mainWindow.loadURL(readyUrl)
}

async function startApplication() {
  if (startupPromise) return startupPromise
  startupPromise = (async () => {
    stopHarness()
    harnessOrigin = null
    harnessLaunchUrl = null
    await mainWindow.loadFile(LOADING_HTML_PATH)
    try {
      await launchHarness()
    } catch (error) {
      stopHarness()
      console.error(error)
      emitStatus(
        '启动失败',
        error instanceof Error ? error.message : String(error),
        null,
        true,
      )
    } finally {
      startupPromise = null
    }
  })()
  return startupPromise
}

function isAllowedLocalUrl(targetUrl) {
  return isAllowedNavigationUrl(targetUrl, {
    loadingHtmlPath: LOADING_HTML_PATH,
    harnessOrigin,
  })
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function quitApplication() {
  isQuitting = true
  stopHarness()
  app.quit()
}

function restartApplication() {
  if (isQuitting) return
  app.relaunch()
  quitApplication()
}

function setDesktopUpdateState(status, values = {}) {
  const has = (key) => Object.hasOwn(values, key)
  desktopUpdateState = {
    status,
    progress: values.progress ?? null,
    update: has('update') ? values.update : desktopUpdateState.update,
    file: has('file') ? values.file : desktopUpdateState.file,
    error: values.error ?? null,
    readyAt: status === 'ready' ? Date.now() : null,
  }
}

function showMessageBox(options) {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
    return dialog.showMessageBox(mainWindow, options)
  }
  return dialog.showMessageBox(options)
}

function desktopUpdateMenuLabel() {
  if (IS_PORTABLE_BUILD) return `便携版 v${app.getVersion()}（手动更新）`
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

async function replaceCurrentAppImage(downloadedFile) {
  const currentAppImage = process.env.APPIMAGE
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

async function removeOldDesktopUpdates(updatesRoot, keepDirectory) {
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

async function installDesktopUpdate() {
  const { update, file } = desktopUpdateState
  if (!update || !file || desktopUpdateState.status !== 'ready') return
  setDesktopUpdateState('installing', { update, file })

  try {
    if (process.platform === 'linux' && file.endsWith('.AppImage')) {
      await replaceCurrentAppImage(file)
      return
    }

    if (process.platform === 'win32') {
      const openError = await shell.openPath(file)
      if (openError) throw new Error(openError)
      quitApplication()
      return
    }

    const openError = await shell.openPath(file)
    if (openError) throw new Error(openError)
    setDesktopUpdateState('ready', { update, file })
  } catch (error) {
    console.error('[desktop-update] install failed', error)
    setDesktopUpdateState('ready', { update, file, error })
    await showMessageBox({
      type: 'error',
      title: '无法安装更新',
      message: '无法打开桌面端更新',
      detail: error instanceof Error ? error.message : String(error),
    })
  }
}

function resolveInstallLabel(file) {
  if (process.platform === 'linux' && file.endsWith('.AppImage')) return '重启并更新'
  return process.platform === 'win32' ? '退出并安装' : '打开安装包'
}

async function promptDesktopUpdate() {
  if (desktopUpdatePrompt) return desktopUpdatePrompt
  const { update, file } = desktopUpdateState
  if (!update || !file || desktopUpdateState.status !== 'ready') return

  const version = update.manifest.version
  const installLabel = resolveInstallLabel(file)

  desktopUpdatePrompt = showMessageBox({
    type: 'info',
    title: '桌面端更新已就绪',
    message: `DeepSeek Harness Desktop v${version} 已下载并通过完整性校验。`,
    detail:
      process.platform === 'darwin'
        ? '打开 DMG 后，请将新版本拖入“应用程序”文件夹完成更新。'
        : '现在安装，或稍后从系统托盘菜单继续。',
    buttons: [installLabel, '稍后'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
    .then(({ response }) => {
      if (response === 0) return installDesktopUpdate()
    })
    .finally(() => {
      desktopUpdatePrompt = null
    })
  return desktopUpdatePrompt
}

async function checkForDesktopUpdate({ manual = false } = {}) {
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
  if (IS_PORTABLE_BUILD) {
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
    if (Date.now() - readyAt >= DESKTOP_UPDATE_READY_MAX_AGE_MS) {
      // An ignored download must not shadow newer releases forever: expire the
      // pending state and fall through to a fresh check. A still-current
      // package is reused from the verified download cache.
      setDesktopUpdateState('idle', { update: null, file: null })
    } else {
      if (manual) await promptDesktopUpdate()
      return
    }
  }
  if (desktopUpdateCheck) return desktopUpdateCheck

  desktopUpdateCheck = (async () => {
    setDesktopUpdateState('checking', { update: null, file: null })
    try {
      const update = await fetchAvailableUpdate({
        fetchImpl: electronNet.fetch,
        currentVersion: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        isAppImage: Boolean(process.env.APPIMAGE),
      })
      if (!update) {
        setDesktopUpdateState('current', { update: null, file: null })
        if (manual) {
          await showMessageBox({
            type: 'info',
            title: '桌面端更新',
            message: `当前已是最新版本 v${app.getVersion()}。`,
          })
        }
        return
      }

      setDesktopUpdateState('downloading', { update, file: null, progress: 0 })
      const updatesRoot = path.join(app.getPath('userData'), 'updates')
      const versionDirectory = `v${update.manifest.version}`
      const destination = path.join(
        updatesRoot,
        versionDirectory,
        update.asset.name,
      )
      const file = await downloadReleaseAsset({
        fetchImpl: electronNet.fetch,
        asset: update.asset,
        destination,
        onProgress: ({ received, total }) => {
          const progress = total ? Math.min(100, Math.round((received / total) * 100)) : null
          setDesktopUpdateState('downloading', { update, progress })
        },
      })
      try {
        await removeOldDesktopUpdates(updatesRoot, versionDirectory)
      } catch (error) {
        console.warn('[desktop-update] unable to remove old downloads', error)
      }
      setDesktopUpdateState('ready', { update, file, progress: 100 })
      await promptDesktopUpdate()
    } catch (error) {
      console.warn('[desktop-update] check failed', error)
      setDesktopUpdateState('error', { update: null, file: null, error })
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

function scheduleDesktopUpdates() {
  desktopUpdateTimeout = setTimeout(() => {
    void checkForDesktopUpdate()
  }, 5_000)
  desktopUpdateInterval = setInterval(() => {
    void checkForDesktopUpdate()
  }, UPDATE_CHECK_INTERVAL_MS)
  desktopUpdateTimeout.unref()
  desktopUpdateInterval.unref()
}

function resolveTrayIconName() {
  if (process.platform === 'darwin') return 'tray-icon.png'
  return nativeTheme.shouldUseDarkColors ? 'tray-icon-dark.png' : 'tray-icon-light.png'
}

function createTrayImage() {
  const assetName = resolveTrayIconName()
  const iconPath = path.join(__dirname, 'assets', 'brand', assetName)
  const iconSize = process.platform === 'darwin' ? 18 : 20
  const trayImage = nativeImage.createFromPath(iconPath).resize({
    width: iconSize,
    height: iconSize,
  })
  if (process.platform === 'darwin') trayImage.setTemplateImage(true)
  return trayImage
}

function updateTrayTheme() {
  if (tray) tray.setImage(createTrayImage())
}

// 应用只在启动 Harness 时把私有 Node.js 与全局 dsh 目录注入子进程 PATH，
// 用户自己的终端拿不到，因此在没装 Node.js 的机器（尤其是 Windows）上无法
// 执行 `dsh plugin` 这类全局命令。这里开一个已注入 PATH 的终端窗口，
// 不修改系统 PATH。
async function openHarnessConsole() {
  const context = harnessConsoleContext
  if (!context) return
  try {
    const launch = createHarnessConsoleLaunch({
      nodeEnvironment: context.nodeEnvironment,
      dshInstallation: context.dshInstallation,
      workspacePath: context.workspacePath,
      userDataPath: app.getPath('userData'),
      linuxTerminal: process.platform === 'linux' ? await findLinuxTerminal() : null,
    })
    if (launch.script) {
      await mkdir(path.dirname(launch.script.path), { recursive: true })
      await writeFile(launch.script.path, launch.script.content, { mode: launch.script.mode })
      await chmod(launch.script.path, launch.script.mode)
    }
    if (!launch.command) {
      shell.showItemInFolder(launch.script.path)
      await showMessageBox({
        type: 'info',
        title: '未找到可用的终端',
        message: '已为你生成 Harness 命令行脚本，请手动运行。',
        detail: launch.script.path,
      })
      return
    }
    const child = spawn(launch.command, launch.args, launch.options)
    child.on('error', (error) => {
      console.warn('[console] unable to open harness console', error)
      void showMessageBox({
        type: 'error',
        title: '无法打开 Harness 命令行',
        message: '启动终端失败。',
        detail: error instanceof Error ? error.message : String(error),
      })
    })
    // 终端独立于应用生命周期，关闭应用后仍可继续使用。
    child.unref()
  } catch (error) {
    console.warn('[console] unable to prepare harness console', error)
    await showMessageBox({
      type: 'error',
      title: '无法打开 Harness 命令行',
      message: '准备命令行环境失败。',
      detail: error instanceof Error ? error.message : String(error),
    })
  }
}

function createTrayContextMenu() {
  const updateBusy = ['checking', 'downloading', 'installing'].includes(desktopUpdateState.status)
  return Menu.buildFromTemplate([
    {
      label: '在默认浏览器中打开',
      enabled: Boolean(harnessOrigin),
      click: () => {
        // Reuse the token-carrying launch URL so an external browser can
        // complete its own authentication exchange when it has no cookie yet.
        if (harnessOrigin) {
          void shell.openExternal(harnessLaunchUrl ?? `${harnessOrigin}/`)
        }
      },
    },
    { type: 'separator' },
    {
      label: '打开 Harness 命令行（安装插件）',
      enabled: Boolean(harnessConsoleContext),
      click: () => {
        void openHarnessConsole()
      },
    },
    { type: 'separator' },
    {
      label: desktopUpdateMenuLabel(),
      enabled: !updateBusy,
      click: () => {
        if (desktopUpdateState.status === 'ready') void promptDesktopUpdate()
        else void checkForDesktopUpdate({ manual: true })
      },
    },
    { type: 'separator' },
    { label: '重启', click: restartApplication },
    { label: '退出', click: quitApplication },
  ])
}

function createTray() {
  if (tray) return

  tray = new Tray(createTrayImage())
  tray.setToolTip('DeepSeek Harness Desktop')

  tray.on('click', showMainWindow)
  tray.on('right-click', () => tray?.popUpContextMenu(createTrayContextMenu()))
  nativeTheme.on('updated', updateTrayTheme)
}

// The window later loads the Harness Web UI, whose page code is delivered by
// the auto-updated npm package. Deny every permission by default and allow
// only clipboard writes that mirror user copy actions; this keeps third-party
// page code from accessing the camera, microphone, notifications and other
// system capabilities without an explicit product decision.
function configureRendererPermissions() {
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      callback(isAllowedRendererPermission(permission))
    },
  )
  session.defaultSession.setPermissionCheckHandler(
    (_webContents, permission) => isAllowedRendererPermission(permission),
  )
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 900,
    minHeight: 640,
    show: false,
    autoHideMenuBar: process.platform === 'win32',
    backgroundColor: '#0a0a0a',
    title: 'DeepSeek Harness Desktop',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  if (process.platform === 'win32') mainWindow.removeMenu()

  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const contextMenu = Menu.buildFromTemplate(
      createWebContextMenuTemplate(params, {
        copyText: (text) => clipboard.writeText(text),
        openExternal: (url) => void shell.openExternal(url),
      }),
    )
    contextMenu.popup({ window: mainWindow, x: params.x, y: params.y })
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedLocalUrl(url)) {
      event.preventDefault()
      if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    }
  })
  mainWindow.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    mainWindow.hide()
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  void startApplication()
}

const singleInstance = app.requestSingleInstanceLock()
if (singleInstance) {
  app.on('second-instance', () => {
    showMainWindow()
  })

  if (process.platform === 'win32') {
    // 让任务栏分组、跳转列表和系统通知使用应用自身身份，而不是 Electron
    // 默认身份；该值必须与 package.json 的 build.appId 保持一致。
    app.setAppUserModelId('com.atlankj.deepseekharnessdesktop')
  }

  // Electron 只有在入口模块求值完成后才发出 ready 事件，所以顶层写
  // `await app.whenReady()` 会永久挂起：既不显示窗口也不退出。这里必须
  // 保留 promise 链，SonarQube 的 S7785 在 Electron 主进程中不适用。
  app.whenReady().then(() => { // NOSONAR: 顶层 await app.whenReady() 会死锁
    const applicationMenu =
      process.platform === 'darwin'
        ? Menu.buildFromTemplate(createApplicationMenuTemplate())
        : null
    Menu.setApplicationMenu(applicationMenu)
    configureRendererPermissions()
    createTray()
    createWindow()
    scheduleDesktopUpdates()
  })
  app.on('activate', () => {
    showMainWindow()
  })
} else {
  app.quit()
}

ipcMain.handle('retry-startup', async (event) => {
  // The preload bridge is present in every page of the window, so only the
  // local loading page is allowed to restart the startup flow.
  if (!isTrustedIpcSender(event.senderFrame, LOADING_HTML_PATH)) {
    throw new Error('拒绝来自非启动页的重试请求。')
  }
  await startApplication()
})

app.on('before-quit', () => {
  isQuitting = true
  if (desktopUpdateTimeout) clearTimeout(desktopUpdateTimeout)
  if (desktopUpdateInterval) clearInterval(desktopUpdateInterval)
  nativeTheme.removeListener('updated', updateTrayTheme)
  stopHarness()
})
