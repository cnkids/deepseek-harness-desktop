import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import semver from 'semver'

// Harness（@deepseek-ai/dsh）更新检测的纯逻辑：版本比对、托盘文案、提示节流与
// 失败冷却。这里不碰 Electron、不碰 npm，全部可在 Node 单元测试里驱动。
//
// 设计要点：**每个版本只主动提示一次**（跨"启动时"与"运行中"，落盘记忆），
// 托盘入口任何时候都在——避免每次启动都弹窗骚扰。

export const DSH_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60_000
export const DSH_UPDATE_RETRY_INTERVAL_MS = 5 * 60_000
export const DSH_UPDATE_FAILURE_COOLDOWN_MS = 5 * 60_000

export function dshUpdateNoticePath(userDataPath) {
  return path.join(userDataPath, 'cache', 'dsh-update-notice.json')
}

function cleanVersion(raw) {
  return semver.valid(semver.clean(String(raw ?? ''))) ? semver.clean(String(raw)) : null
}

// 落盘记录只用来决定"要不要弹窗"，绝不参与"运行哪个版本"的判断，因此读取时
// 一律严格校验：版本必须是合法 semver，时间戳必须有限且为正数，否则当作没有记录。
export async function readDshUpdateNotice(noticePath) {
  try {
    const raw = JSON.parse(await readFile(noticePath, 'utf8'))
    const version = cleanVersion(raw?.notifiedVersion)
    const notifiedAt = Number(raw?.notifiedAt)
    if (!version || !Number.isFinite(notifiedAt) || notifiedAt <= 0) return null
    return { version, notifiedAt }
  } catch {
    return null
  }
}

export async function writeDshUpdateNotice(noticePath, version, notifiedAt = Date.now()) {
  const cleaned = cleanVersion(version)
  if (!cleaned || !Number.isFinite(notifiedAt) || notifiedAt <= 0) {
    throw new Error('无法记录无效的 Harness 更新提示状态。')
  }
  await mkdir(path.dirname(noticePath), { recursive: true })
  await writeFile(
    noticePath,
    `${JSON.stringify({ notifiedVersion: cleaned, notifiedAt })}\n`,
    'utf8',
  )
}

// 该版本是否已经主动提示过（启动时/运行中共用同一份记录）。
export function isDshUpdateNotified(notice, latestVersion) {
  const latest = cleanVersion(latestVersion)
  if (!latest || !notice) return false
  return notice.version === latest
}

export function isDshUpdateCoolingDown({
  failedAt,
  now = Date.now(),
  cooldownMs = DSH_UPDATE_FAILURE_COOLDOWN_MS,
}) {
  if (!Number.isFinite(failedAt) || failedAt <= 0) return false
  const elapsed = now - failedAt
  return elapsed >= 0 && elapsed < cooldownMs
}

// 更新检查结果缓存的有效期：成功的检查缓存 6 小时，失败的重试间隔 5 分钟。
export function resolveDshUpdateCacheMaxAge(successful) {
  return successful ? DSH_UPDATE_CHECK_INTERVAL_MS : DSH_UPDATE_RETRY_INTERVAL_MS
}

export function isDshUpdateCacheFresh({ checkedAt, successful, now = Date.now() }) {
  if (!Number.isFinite(checkedAt) || checkedAt <= 0) return false
  const age = now - checkedAt
  return age >= 0 && age < resolveDshUpdateCacheMaxAge(successful)
}

export function dshUpdateMenuLabel(state = {}) {
  const latest = cleanVersion(state.latestVersion)
  const installed = cleanVersion(state.installedVersion)
  switch (state.status) {
    case 'updating':
      return latest ? `正在更新 Harness 到 v${latest}…` : '正在更新 Harness…'
    case 'available':
      return latest ? `更新 Harness 到 v${latest}` : '更新 Harness'
    case 'failed': {
      // 查版本失败与装包失败的处置不同：前者只是没联网，后者才需要重试安装。
      const label =
        state.failureKind === 'check'
          ? 'Harness 更新检查失败，点击重试'
          : 'Harness 更新失败，点击重试'
      return latest ? `${label}（v${latest}）` : label
    }
    default:
      return installed ? `检查 Harness 更新（当前 v${installed}）` : '检查 Harness 更新'
  }
}

// 供启动页显示的一行提示（托盘才是常驻入口）。
export function dshUpdateLaunchNotice(state = {}) {
  const latest = cleanVersion(state.latestVersion)
  const installed = cleanVersion(state.installedVersion)
  if (!latest) return ''
  if (installed) return `发现新版本 v${latest}，本次继续使用 v${installed}（可从托盘更新）`
  return `发现新版本 v${latest}`
}
