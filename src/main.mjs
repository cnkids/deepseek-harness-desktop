import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, ipcMain, Menu, net as electronNet, shell } from 'electron'
import { downloadReleaseAsset, fetchAvailableUpdate } from './app-update.mjs'
import { createApplicationMenuTemplate } from './edit-menu.mjs'
import { isTrustedIpcSender } from './security-policy.mjs'
import { createDshCommandController } from './dsh-command.mjs'
import { createHarnessLauncher } from './harness-launcher.mjs'
import { createTrayController } from './tray.mjs'
import { createWindowController } from './window.mjs'
import { createDesktopUpdateController } from './updates/desktop-update.mjs'
import { createDshUpdateController } from './updates/dsh-update-controller.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LOADING_HTML_PATH = path.join(__dirname, 'loading.html')
const BRAND_DIR = path.join(__dirname, 'assets', 'brand')
// electron-builder 的便携版会把可执行文件所在目录写入该变量。便携版不能像
// 安装版那样用 NSIS 安装包覆盖自己，因此只提示手动下载新版本。
const IS_PORTABLE_BUILD =
  process.platform === 'win32' && Boolean(process.env.PORTABLE_EXECUTABLE_DIR)

// 主进程引导与装配：各控制器职责见 window.mjs / tray.mjs / harness-launcher.mjs /
// dsh-command.mjs / updates/*。这里只负责创建它们、接线回调、处理退出。
let isQuitting = false
const state = {
  windows: null,
  tray: null,
  launcher: null,
  dshCommand: null,
  dshUpdate: null,
  desktopUpdate: null,
}

function quitApplication() {
  isQuitting = true
  state.launcher?.stop()
  app.quit()
}

function restartApplication() {
  if (isQuitting) return
  app.relaunch()
  quitApplication()
}

function showMainWindow() {
  state.windows?.show()
}

// 窗口建好后触发一次启动流程。start() 内部会把失败报到启动页，因此这里不需要
// 再处理它的返回值。
function startHarness() {
  state.launcher?.start()
}

function openHarnessInBrowser() {
  const launcher = state.launcher
  if (!launcher?.origin) return
  // Reuse the token-carrying launch URL so an external browser can complete its
  // own authentication exchange when it has no cookie yet.
  void shell.openExternal(launcher.launchUrl ?? `${launcher.origin}/`)
}

// 启动顺序：先建窗口控制器与更新控制器，再把它们接到启动流程与托盘上。
function configureControllers() {
  const userDataPath = app.getPath('userData')
  const windows = createWindowController({
    loadingHtmlPath: LOADING_HTML_PATH,
    shouldQuit: () => isQuitting,
    getHarnessOrigin: () => state.launcher?.origin ?? null,
    onWindowCreated: startHarness,
  })
  state.windows = windows

  state.dshCommand = createDshCommandController({
    userDataPath,
    showMessageBox: windows.showMessageBox,
  })

  state.dshUpdate = createDshUpdateController({
    fetchImpl: electronNet.fetch,
    reportStatus: windows.reportStatus,
    showMessageBox: windows.showMessageBox,
    userDataPath,
    getRuntime: () => state.launcher?.runtime ?? null,
    stopHarness: () => state.launcher?.stop(),
    restartHarness: () => state.launcher?.start(),
    onInstallationChanged: (installation) => state.launcher?.rememberInstallation(installation),
  })

  state.desktopUpdate = createDesktopUpdateController({
    app,
    shell,
    fetchImpl: electronNet.fetch,
    isPortableBuild: IS_PORTABLE_BUILD,
    userDataPath,
    showMessageBox: windows.showMessageBox,
    quitApplication,
    fetchUpdate: fetchAvailableUpdate,
    downloadUpdate: downloadReleaseAsset,
  })

  state.launcher = createHarnessLauncher({
    app,
    userDataPath,
    fetchImpl: electronNet.fetch,
    reportStatus: windows.reportStatus,
    loadLoadingPage: windows.loadLoadingPage,
    loadUrl: windows.loadUrl,
    isQuitting: () => isQuitting,
    dshCommand: state.dshCommand,
    dshUpdate: state.dshUpdate,
  })

  state.tray = createTrayController({
    brandDir: BRAND_DIR,
    onShowWindow: showMainWindow,
    providers: {
      isOpenInBrowserEnabled: () => Boolean(state.launcher?.origin),
      openInBrowser: openHarnessInBrowser,
      dshCommandItems: () => state.dshCommand.menuItems(),
      dshUpdateItem: () => state.dshUpdate.menuItem(),
      desktopUpdateItem: () => state.desktopUpdate.menuItem(),
      restart: restartApplication,
      quit: quitApplication,
    },
  })

  windows.configurePermissions()
  state.tray.create()
  state.desktopUpdate.schedule()
  state.dshUpdate.schedule()
  // 窗口创建会触发一次启动流程（onWindowCreated → launcher.start()）。
  windows.create()
}

const singleInstance = app.requestSingleInstanceLock()
if (singleInstance) {
  app.on('second-instance', () => {
    showMainWindow()
  })

  if (process.platform === 'win32') {
    // 让任务栏分组、跳转列表和系统通知使用应用自身身份，而不是 Electron
    // 默认身份；该值必须与 package.json 的 build.appId 保持一致。
    app.setAppUserModelId('com.cnkids.deepseekharnessdesktop')
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
    configureControllers()
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
  await state.launcher?.start()
})

app.on('before-quit', () => {
  isQuitting = true
  state.desktopUpdate?.dispose()
  state.dshUpdate?.dispose()
  state.tray?.dispose()
  state.launcher?.stop()
})
