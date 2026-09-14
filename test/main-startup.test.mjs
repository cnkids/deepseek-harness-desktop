import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

// 回归守卫：Electron 只有在入口模块求值完成后才发出 ready 事件，因此顶层写
// `await app.whenReady()` 会让应用永久挂起（不显示窗口也不退出）。静态检查比
// 运行时覆盖更早暴露问题：这类死锁不会抛错，只会让应用“双击没反应”。
test('main process waits for ready with a promise chain', async () => {
  const source = await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8')

  assert.equal(
    /^\s*await\s+app\.whenReady\(\)/m.test(source),
    false,
    'main.mjs 不能在顶层 await app.whenReady()：Electron 会因此永不触发 ready',
  )
  assert.match(source, /app\.whenReady\(\)\.then\(/)
})

test('main process registers the single instance guard before ready', async () => {
  const source = await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8')

  assert.match(source, /app\.requestSingleInstanceLock\(\)/)
  assert.match(source, /app\.quit\(\)/)
})

// 回归守卫：启动缓存会把「用私有 runtime」这个决定固化下来，用户后来装了兼容的
// 系统 Node.js 也不会生效。缓存里是私有 runtime 时必须做一次便宜复核。
test('main process re-checks a managed startup cache against a system Node', async () => {
  const source = await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8')

  assert.match(source, /startupCache\?\.nodeEnvironment\.source === 'managed'/)
  assert.match(source, /findCompatibleSystemNode\(\{[\s\S]*?loginShell: false,/)
})

// 回归守卫：托盘不再提供「打开 Harness 命令行」入口——该能力已移除，
// 无系统 Node.js 的场景改由 README 的安装说明覆盖。
test('main process no longer ships a console launcher', async () => {
  const source = await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8')

  assert.equal(source.includes('harness-console'), false)
  assert.equal(source.includes('harnessConsoleContext'), false)
  assert.equal(source.includes('打开 Harness 命令行'), false)
})
