import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const preloadPath = new URL('../src/preload.cjs', import.meta.url)

// 回归守卫：preload 桥存在于窗口的每个页面，包括 npm 更新流管理的第三方
// Harness UI。因此「打开命令行」通道绝不能经 contextBridge 暴露给页面 JS，
// 否则第三方页面代码也能直接拉起终端窗口。
test('preload never exposes the console channel to page scripts', async () => {
  const source = await readFile(preloadPath, 'utf8')

  const start = source.indexOf('exposeInMainWorld')
  const end = source.indexOf('\n})', start)
  assert.ok(start > 0 && end > start, 'preload 应该保留 desktopRuntime 桥')
  assert.equal(
    source.slice(start, end).includes('open-harness-console'),
    false,
    'open-harness-console 不能出现在 contextBridge 暴露的接口里',
  )
  assert.match(source, /ipcRenderer\.invoke\('open-harness-console'\)/)
})

// 按钮只注入 Harness 页面（http/https），启动页是 file:// 页面，不该出现
// 这个入口；并且只接受真实用户点击，拒绝页面用 element.click() 伪造。
test('preload injects the console button only on Harness pages for real clicks', async () => {
  const source = await readFile(preloadPath, 'utf8')

  assert.match(source, /location\.protocol === 'http:' \|\| location\.protocol === 'https:'/)
  assert.match(source, /if \(!event\.isTrusted\) return/)
  assert.match(source, /document\.getElementById\(CONSOLE_BUTTON_ID\)/)
  assert.match(source, /document\.body\.append\(button\)/)
})

// 主进程必须校验发送方，不能只依赖渲染进程的自律。
test('main process guards the console channel with the harness sender check', async () => {
  const source = await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8')

  assert.match(source, /ipcMain\.handle\('open-harness-console'/)
  assert.match(source, /isTrustedHarnessSender\(event\.senderFrame, harnessOrigin\)/)
})
