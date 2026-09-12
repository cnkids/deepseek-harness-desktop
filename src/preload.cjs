const { contextBridge, ipcRenderer } = require('electron')

const CONSOLE_BUTTON_ID = 'dsh-harness-console-button'
const CONSOLE_BUTTON_LABEL = '命令行'
const CONSOLE_BUTTON_TITLE = '打开 Harness 命令行（可执行 dsh 全局命令）'
const CONSOLE_BUTTON_RESTING_OPACITY = '0.45'

contextBridge.exposeInMainWorld('desktopRuntime', {
  onStatus(callback) {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('runtime-status', listener)
    return () => ipcRenderer.removeListener('runtime-status', listener)
  },
  retry() {
    return ipcRenderer.invoke('retry-startup')
  },
})

// 启动页是 file:// 页面，Harness 就绪后窗口会被 http://127.0.0.1:<端口> 的
// Web UI 替换。按钮只注入 Harness 页面：没有系统 Node.js 的机器上，用户需要
// 一个随时可点的入口来执行 dsh plugin 这类全局命令。
function isHarnessPage() {
  return location.protocol === 'http:' || location.protocol === 'https:'
}

function styleConsoleButton(button) {
  Object.assign(button.style, {
    position: 'fixed',
    right: '16px',
    bottom: '16px',
    zIndex: '2147483647',
    padding: '6px 12px',
    border: '1px solid rgba(127, 127, 127, 0.45)',
    borderRadius: '999px',
    background: 'rgba(18, 20, 26, 0.75)',
    color: '#f5f6f8',
    font: '12px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
    cursor: 'pointer',
    opacity: CONSOLE_BUTTON_RESTING_OPACITY,
    transition: 'opacity 120ms ease',
  })
  button.addEventListener('mouseenter', () => {
    button.style.opacity = '1'
  })
  button.addEventListener('mouseleave', () => {
    button.style.opacity = CONSOLE_BUTTON_RESTING_OPACITY
  })
}

function requestHarnessConsole(event) {
  // 通道不经 contextBridge 暴露，页面 JS 拿不到 ipcRenderer；这里再要求真实
  // 用户手势，避免第三方页面用 element.click() 伪造请求。
  if (!event.isTrusted) return
  event.preventDefault()
  event.stopPropagation()
  ipcRenderer.invoke('open-harness-console').catch((error) => {
    console.error('[console] 无法打开 Harness 命令行', error)
  })
}

function injectHarnessConsoleButton() {
  // 窗口没有开启 nodeIntegrationInSubFrames，preload 只在顶层框架运行，因此
  // 这里不需要再做 window.top 判断；子框架即使发起请求，也会被主进程的
  // isTrustedHarnessSender 拒绝。
  if (!isHarnessPage() || !document.body) return
  if (document.getElementById(CONSOLE_BUTTON_ID)) return

  const button = document.createElement('button')
  button.id = CONSOLE_BUTTON_ID
  button.type = 'button'
  button.textContent = CONSOLE_BUTTON_LABEL
  button.title = CONSOLE_BUTTON_TITLE
  styleConsoleButton(button)
  button.addEventListener('click', requestHarnessConsole)
  document.body.append(button)
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectHarnessConsoleButton, { once: true })
} else {
  injectHarnessConsoleButton()
}
