import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

// 主进程只在 Electron 运行时里执行，Node 单元测试无法直接驱动它，因此这里用
// 静态检查守住那些"回归了也不会报错、只会让应用变哑"的约束。拆分 main.mjs 后，
// 每条守卫都指向它现在所在的模块。

function source(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8')
}

// 回归守卫：Electron 只有在入口模块求值完成后才发出 ready 事件，因此顶层写
// `await app.whenReady()` 会让应用永久挂起（不显示窗口也不退出）。静态检查比
// 运行时覆盖更早暴露问题：这类死锁不会抛错，只会让应用“双击没反应”。
test('main process waits for ready with a promise chain', async () => {
  const main = await source('src/main.mjs')

  assert.equal(
    /^\s*await\s+app\.whenReady\(\)/m.test(main),
    false,
    'main.mjs 不能在顶层 await app.whenReady()：Electron 会因此永不触发 ready',
  )
  assert.match(main, /app\.whenReady\(\)\.then\(/)
})

test('main process registers the single instance guard before ready', async () => {
  const main = await source('src/main.mjs')

  assert.match(main, /app\.requestSingleInstanceLock\(\)/)
  assert.match(main, /app\.quit\(\)/)
})

// 回归守卫：启动缓存会把「用私有 runtime」这个决定固化下来，用户后来装了兼容的
// 系统 Node.js 也不会生效。缓存里是私有 runtime 时必须做一次便宜复核。
test('main process re-checks a managed startup cache against a system Node', async () => {
  const environment = await source('src/harness-environment.mjs')

  assert.match(environment, /startupCache\?\.nodeEnvironment\.source === 'managed'/)
  assert.match(environment, /findCompatibleSystemNode\(\{[\s\S]*?loginShell: false,/)
})

// 回归守卫：PATH 提示必须是「每个目录一次」，且已成功修复过的目录不能因为
// 应用自身 PATH 未变而反复判定"还没修好"（shell rc 改动不会进 GUI 应用环境）。
test('main process prompts at most once and remembers applied fixes', async () => {
  const command = await source('src/dsh-command.mjs')

  assert.match(command, /dshPathState\.promptedFor === fix\.binDir/)
  assert.match(command, /await writePathFixState\(dshPathStatePath\(\), dshPathState\)/)
  assert.match(command, /dshPathState\.appliedFor === dshCommandState\.binDir/)
  assert.match(command, /dshPathState = \{ \.\.\.dshPathState, appliedFor: target\.binDir \}/)
})

// 回归守卫：托盘常驻一行自述 dsh 状态——此前只在需要修复时才出现，用户反馈
// "从来没在托盘里看到过"，也无法远程判断应用当前用的是哪种 Node.js。
test('tray always shows a self-describing dsh command row', async () => {
  const tray = await source('src/tray.mjs')
  const command = await source('src/dsh-command.mjs')

  assert.match(tray, /\.\.\.providers\.dshCommandItems\(\),/)
  assert.match(command, /修复 dsh 命令（加入 PATH）/)
  assert.match(command, /dsh 命令已可用（用户 Node\.js \$\{dshCommandState\.version\}）/)
  assert.match(command, /dsh 命令仅在应用内可用（应用私有 Node\.js）/)
})

// 回归守卫：托盘不再提供「打开 Harness 命令行」入口——该能力已移除，
// 无系统 Node.js 的场景改由 README 的安装说明覆盖。
test('main process no longer ships a console launcher', async () => {
  const main = await source('src/main.mjs')
  const tray = await source('src/tray.mjs')

  for (const text of [main, tray]) {
    assert.equal(text.includes('harness-console'), false)
    assert.equal(text.includes('harnessConsoleContext'), false)
    assert.equal(text.includes('打开 Harness 命令行'), false)
  }
})

// 回归守卫：应用常驻不重启时也必须能发现 dsh 新版本——启动流程只查一次是不够的，
// 主进程要定时复查并把"更新 Harness"常驻在托盘里。
test('re-checks for Harness updates while the app keeps running', async () => {
  const main = await source('src/main.mjs')
  const controller = await source('src/updates/dsh-update-controller.mjs')

  assert.match(main, /state\.dshUpdate\.schedule\(\)/)
  assert.match(main, /dshUpdateItem: \(\) => state\.dshUpdate\.menuItem\(\)/)
  assert.match(controller, /DSH_UPDATE_CHECK_INTERVAL_MS/)
  assert.match(controller, /setInterval\(\(\) => \{[\s\S]{0,160}?checkForUpdate\(\)/)
})

// 回归守卫：Windows 下 npm 覆盖正在运行的 dsh 文件会失败，所以运行中更新必须
// 先停 Harness 再安装，装完（成功或失败）都要把 Harness 拉回来。
test('stops the harness before a running update and restarts it afterwards', async () => {
  const controller = await source('src/updates/dsh-update-controller.mjs')

  const stopAt = controller.indexOf('stopHarness()')
  const installAt = controller.indexOf('runner.install({')
  assert.notEqual(stopAt, -1)
  assert.notEqual(installAt, -1)
  assert.ok(stopAt < installAt, '必须先停 Harness 再执行 npm 安装')
  assert.match(controller, /await restartHarness\(\{ installation: installation \?\? runtime\.installed \}\)/)
})

// 回归守卫：同一个版本只提示一次（落盘记忆），否则每次启动都会弹窗；失败后要有
// 冷却，避免定时任务反复执行 npm 安装。
test('asks at most once per version and cools down after failures', async () => {
  const controller = await source('src/updates/dsh-update-controller.mjs')
  const launch = await source('src/updates/dsh-update-launch.mjs')

  for (const text of [controller, launch]) {
    assert.match(text, /isDshUpdateNotified\(/)
    assert.match(text, /writeDshUpdateNotice\(/)
  }
  assert.match(controller, /isDshUpdateCoolingDown\(\{ failedAt \}\)/)
})

// 安全守卫：更新能力只能由主进程驱动。preload 桥接面保持最小，主进程也只注册
// retry-startup 一个 IPC 通道——主窗口里跑的是 dsh 提供的第三方页面代码。
test('never exposes update capabilities to the renderer', async () => {
  const preload = await source('src/preload.cjs')
  const main = await source('src/main.mjs')

  assert.equal(/update/i.test(preload), false, 'preload 不得暴露任何更新能力')
  assert.match(preload, /retry-startup/)
  assert.equal(main.match(/ipcMain\.handle\(/g)?.length, 1)
})
