import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserWindow, clipboard, dialog, Menu, session, shell } from 'electron'
import { createWebContextMenuTemplate } from './edit-menu.mjs'
import { isAllowedNavigationUrl, isAllowedRendererPermission } from './security-policy.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 主窗口控制器：窗口创建、启动页加载、状态广播、导航与权限策略。
//
// 窗口里最终加载的是 dsh 提供的 Harness Web UI（属于第三方页面代码），所以
// 这里同时负责收紧渲染进程能力：权限默认拒绝、外链交给系统浏览器、禁止跳转到
// 本地启动页与当前 Harness 源之外的地址。
// 页面里的新窗口请求一律交给系统浏览器，窗口自身只加载本地启动页与当前 Harness。
function handleWindowOpen({ url }) {
  if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
  return { action: 'deny' }
}

// 权限默认拒绝，只放行镜像用户复制动作的剪贴板写入；这样第三方页面代码
// 不会在未经产品决策的情况下拿到摄像头、麦克风、通知等系统能力。
function configurePermissions() {
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      callback(isAllowedRendererPermission(permission))
    },
  )
  session.defaultSession.setPermissionCheckHandler(
    (_webContents, permission) => isAllowedRendererPermission(permission),
  )
}

export function createWindowController({
  loadingHtmlPath,
  shouldQuit,
  getHarnessOrigin,
  onWindowCreated,
}) {
  let mainWindow = null

  function isAllowedLocalUrl(targetUrl) {
    return isAllowedNavigationUrl(targetUrl, {
      loadingHtmlPath,
      harnessOrigin: getHarnessOrigin(),
    })
  }

  function handleContextMenu(_event, params) {
    const contextMenu = Menu.buildFromTemplate(
      createWebContextMenuTemplate(params, {
        copyText: (text) => clipboard.writeText(text),
        openExternal: (url) => void shell.openExternal(url),
      }),
    )
    contextMenu.popup({ window: mainWindow, x: params.x, y: params.y })
  }

  function handleNavigation(event, url) {
    if (isAllowedLocalUrl(url)) return
    event.preventDefault()
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
  }

  function handleClose(event) {
    if (shouldQuit()) return
    event.preventDefault()
    mainWindow.hide()
  }

  function create() {
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
    mainWindow.webContents.on('context-menu', handleContextMenu)
    mainWindow.webContents.setWindowOpenHandler(handleWindowOpen)
    mainWindow.webContents.on('will-navigate', handleNavigation)
    mainWindow.on('close', handleClose)
    mainWindow.on('closed', () => {
      mainWindow = null
    })

    onWindowCreated?.()
  }

  function show() {
    if (!mainWindow || mainWindow.isDestroyed()) {
      create()
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }

  function reportStatus({ message, detail = '', progress = null, error = false }) {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('runtime-status', { message, detail, progress, error })
  }

  function showMessageBox(options) {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
      return dialog.showMessageBox(mainWindow, options)
    }
    return dialog.showMessageBox(options)
  }

  function loadLoadingPage() {
    if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve()
    return mainWindow.loadFile(loadingHtmlPath)
  }

  function loadUrl(url) {
    if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve()
    return mainWindow.loadURL(url)
  }

  return {
    create,
    show,
    reportStatus,
    showMessageBox,
    loadLoadingPage,
    loadUrl,
    configurePermissions,
    get current() {
      return mainWindow
    },
  }
}
