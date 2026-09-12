import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Clipboard writes back user actions inside the Harness Web UI (for example
// "copy" buttons). Everything else - camera, microphone, notifications,
// geolocation, HID, serial and friends - is denied by default because the
// loaded page content is third-party code managed by the npm update flow.
export const ALLOWED_RENDERER_PERMISSIONS = Object.freeze([
  'clipboard-sanitized-write',
  'clipboard-write',
])

export function isAllowedRendererPermission(permission) {
  return ALLOWED_RENDERER_PERMISSIONS.includes(permission)
}

function decodePathname(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

// The only local document the launcher ever loads is its own loading page.
// Any other file: navigation would let remote (npm-provided) page content
// render arbitrary local HTML inside the privileged window.
export function isStartupPageUrl(value, loadingHtmlPath) {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'file:') return false
    if (parsed.host && parsed.host !== 'localhost') return false
    const expected = pathToFileURL(path.resolve(loadingHtmlPath))
    return decodePathname(parsed.pathname) === decodePathname(expected.pathname)
  } catch {
    return false
  }
}

export function isAllowedNavigationUrl(value, { loadingHtmlPath, harnessOrigin }) {
  try {
    const parsed = new URL(value)
    if (parsed.protocol === 'file:') {
      return isStartupPageUrl(value, loadingHtmlPath)
    }
    return Boolean(harnessOrigin && parsed.origin === harnessOrigin)
  } catch {
    return false
  }
}

// Loading-page-only guard for privileged IPC: the preload bridge is injected
// into every page of the window, including the third-party Harness UI, so
// restart-capable channels must reject other senders.
export function isTrustedIpcSender(senderFrame, loadingHtmlPath) {
  return Boolean(
    senderFrame &&
      typeof senderFrame.url === 'string' &&
      isStartupPageUrl(senderFrame.url, loadingHtmlPath),
  )
}

// 「打开命令行」按钮只由 preload 注入到 Harness 页面：通道没有经
// contextBridge 暴露，preload 也拒绝合成点击，但主进程仍然要确认请求来自
// 窗口顶层框架，并且仍在当前 Harness origin 内。
export function isTrustedHarnessSender(senderFrame, harnessOrigin) {
  if (!senderFrame || senderFrame.parent || !harnessOrigin) return false
  if (typeof senderFrame.url !== 'string') return false
  try {
    return new URL(senderFrame.url).origin === harnessOrigin
  } catch {
    return false
  }
}
