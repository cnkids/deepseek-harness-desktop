import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeHarnessFailure } from '../src/harness-diagnostics.mjs'

// 取自真实场景：profile 里引用的插件目录不存在时 dsh 的输出。
const pluginFailureOutput = [
  'file:///Users/me/.nvm/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:831',
  'throw new Error(`${binName}: cannot resolve profile bundle ${JSON.stringify(packageName)} ...`);',
  '^',
  'Error: dsh: cannot resolve profile bundle "dsh-office-tools" from the dsh installation or /Users/me/.dsh/profiles/web',
  '    at resolveBundleDir (file:///Users/me/.nvm/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:831:8)',
  '    at loadProfileDirectory (file:///Users/me/.nvm/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:849:25)',
  'Node.js v24.15.0',
]

test('returns nothing when there is no captured output', () => {
  assert.equal(summarizeHarnessFailure([]), '')
  assert.equal(summarizeHarnessFailure(['', '   ']), '')
})

test('surfaces the actionable error line instead of the stack', () => {
  const summary = summarizeHarnessFailure(pluginFailureOutput)

  assert.match(summary, /cannot resolve profile bundle "dsh-office-tools"/)
  assert.equal(summary.includes('Node.js v24.15.0'), false)
})

test('falls back to the tail when no error keyword is present', () => {
  const summary = summarizeHarnessFailure(['alpha', 'beta', 'gamma', 'delta'], { maxLines: 2 })

  assert.equal(summary, 'gamma\ndelta')
})

test('caps the number of lines and the total length', () => {
  const noisy = ['error one', 'error two', 'error three', 'error four']
  assert.equal(summarizeHarnessFailure(noisy, { maxLines: 2 }), 'error one\nerror two')

  const long = [`error ${'x'.repeat(600)}`]
  assert.equal(summarizeHarnessFailure(long, { maxLength: 20 }).length, 21)
})

test('recognises localised failure wording', () => {
  assert.match(summarizeHarnessFailure(['无法启动 Harness 服务']), /无法启动/)
  assert.match(summarizeHarnessFailure(['端口被占用：EADDRINUSE']), /EADDRINUSE/)
})
