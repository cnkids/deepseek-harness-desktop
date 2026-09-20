import path from 'node:path'
import {
  applyUserPathFix,
  hasPathEntry,
  isPathFixApplied,
  readPathFixState,
  writePathFixState,
} from './dsh-path.mjs'

// 「让 dsh 命令在用户自己的终端里可用」的控制器：探测 dsh 命令目录、托盘的
// 常驻自述行、一次性提示与 PATH 修复。
//
// 应用只在启动 Harness 时把私有 Node.js 与全局 dsh 目录注入子进程 PATH，
// 用户自己的终端拿不到。只有用系统 Node.js 时才谈得上 PATH 修复：私有 runtime
// 目录里同时含 node 与 npm，把它加进用户 PATH 等于顺手给用户装一套 Node.js，
// 代价不可接受。
export function createDshCommandController({
  userDataPath,
  showMessageBox,
  pathValue,
  applyPathFix = applyUserPathFix,
}) {
  // undefined 表示还没启动完成（此时托盘不显示该行）；null = 不适用（私有 runtime）。
  let dshCommandState
  // 从 userData/cache/dsh-path.json 读入：记过提示与成功修复过的目录。
  let dshPathState = { promptedFor: null, appliedFor: null }
  let dshPathPrompted = false

  function dshPathStatePath() {
    return path.join(userDataPath, 'cache', 'dsh-path.json')
  }

  async function loadState() {
    dshPathState = await readPathFixState(dshPathStatePath())
  }

  // 同一个目录只提示一次：把已提示过的目录落盘，之后改用托盘菜单里的常驻入口，
  // 不再每次启动都弹窗打扰（此前只有进程内的 dshPathPrompted，重启就会再弹）。
  async function promptOnce() {
    const fix = dshCommandState?.needsPathFix ? dshCommandState : null
    if (!fix || dshPathPrompted) return
    dshPathPrompted = true
    try {
      if (dshPathState.promptedFor === fix.binDir) return
      dshPathState = { ...dshPathState, promptedFor: fix.binDir }
      await writePathFixState(dshPathStatePath(), dshPathState)
      const { response } = await showMessageBox({
        type: 'info',
        title: 'dsh 命令还不能在终端里使用',
        message: 'dsh 已经装好，但它的目录不在你的 PATH 上。',
        detail: `${fix.binDir}\n\n加入后即可在自己的终端里执行 dsh plugin --profile web add ...。这个提示只会出现一次，之后可从托盘菜单选择「修复 dsh 命令（加入 PATH）」。`,
        buttons: ['立即修复', '稍后'],
        defaultId: 0,
        cancelId: 1,
      })
      if (response === 0) await apply()
    } catch (error) {
      console.warn('[dsh-path] unable to ask about PATH', error)
    }
  }

  async function apply() {
    const target = dshCommandState
    if (!target?.needsPathFix) return
    try {
      const result = await applyPathFix({ binDir: target.binDir })
      target.needsPathFix = false
      // 记住已为这个目录写过 PATH：shell rc 的改动不会反映到应用自身的环境里，
      // 不记下来就会每次启动都重复判定"还没修好"。
      dshPathState = { ...dshPathState, appliedFor: target.binDir }
      await writePathFixState(dshPathStatePath(), dshPathState)
      await showMessageBox({
        type: 'info',
        title: 'dsh 命令已加入 PATH',
        message: '请重新打开一个终端，再执行 dsh 命令。',
        detail:
          result.kind === 'shell-rc'
            ? `已写入 ${result.detail}，新开的终端即可使用 dsh。`
            : '已写入当前用户的 PATH，新开的终端即可使用 dsh。',
      })
    } catch (error) {
      console.warn('[dsh-path] unable to update PATH', error)
      await showMessageBox({
        type: 'error',
        title: '加入 PATH 失败',
        message: '无法自动写入 PATH，请按 README 手动添加。',
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // 已经为这个目录写过用户 PATH / shell rc 时不再当作"缺失"：GUI 应用自身的
  // process.env.PATH 不会因此改变（macOS 上尤其明显），只看 PATH 会反复提示。
  async function refresh(nodeEnvironment, dshInstallation) {
    dshCommandState = detectDshCommandState(nodeEnvironment, dshInstallation, pathValue)
    if (!dshCommandState?.needsPathFix) return dshCommandState
    const applied =
      dshPathState.appliedFor === dshCommandState.binDir ||
      (await isPathFixApplied({ binDir: dshCommandState.binDir }))
    if (applied) dshCommandState.needsPathFix = false
    return dshCommandState
  }

  function row() {
    if (dshCommandState === null) {
      return { label: 'dsh 命令仅在应用内可用（应用私有 Node.js）', enabled: false }
    }
    if (dshCommandState.needsPathFix) {
      return {
        label: '修复 dsh 命令（加入 PATH）',
        enabled: true,
        click: () => {
          void apply()
        },
      }
    }
    return {
      label: `dsh 命令已可用（用户 Node.js ${dshCommandState.version}）`,
      enabled: false,
    }
  }

  // 托盘据此常驻一行自述状态，用户不必猜也便于排查：undefined = 还没启动完成。
  function menuItems() {
    if (dshCommandState === undefined) return []
    return [row(), { type: 'separator' }]
  }

  return {
    loadState,
    refresh,
    menuItems,
    promptOnce,
    apply,
    get state() {
      return dshCommandState
    },
  }
}

export function detectDshCommandState(
  nodeEnvironment,
  dshInstallation,
  pathValue = process.env.PATH,
) {
  if (nodeEnvironment.source !== 'system' || !dshInstallation.binDir) return null
  return {
    binDir: dshInstallation.binDir,
    version: nodeEnvironment.version,
    needsPathFix: !hasPathEntry(pathValue, dshInstallation.binDir),
  }
}
