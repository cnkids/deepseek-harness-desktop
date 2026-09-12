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
