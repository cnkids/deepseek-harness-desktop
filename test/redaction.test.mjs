import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { appendProcessOutput } from '../src/harness-process.mjs'
import { describeError, stripLaunchToken, stripUrlCredentials } from '../src/redaction.mjs'
import { windowsSystemBinary } from '../src/system-binaries.mjs'

// 安全守卫：应用会把 dsh 原始输出转发到控制台、把失败原因显示到启动页/对话框。
// 这两条路径都不能带出本地访问令牌与软件源里的账号密码。

test('redacts the local Harness launch token but keeps the rest of the line', () => {
  const line = 'dsh web: http://127.0.0.1:1234/?token=AbC-123_xyz (LAN: http://10.0.0.2:1234/)'

  const redacted = stripLaunchToken(line)

  assert.equal(
    redacted,
    'dsh web: http://127.0.0.1:1234/?token=*** (LAN: http://10.0.0.2:1234/)',
  )
  assert.equal(redacted.includes('AbC-123_xyz'), false)
  assert.equal(stripLaunchToken(line.replace('?token=AbC-123_xyz', '')).includes('***'), false)
})

test('redacts every token it finds, not just the first', () => {
  const redacted = stripLaunchToken('a?token=one b?token=two&x=1')

  assert.equal(redacted, 'a?token=*** b?token=***&x=1')
})

test('strips credentials from URLs but keeps host and path', () => {
  const url = 'https://alice:s3cret@npm.internal/@deepseek-ai%2fdsh/latest'

  assert.equal(
    stripUrlCredentials(url),
    'https://npm.internal/@deepseek-ai%2fdsh/latest',
  )
  assert.equal(
    stripUrlCredentials(`request to ${url} failed`),
    'request to https://npm.internal/@deepseek-ai%2fdsh/latest failed',
  )
  assert.equal(
    stripUrlCredentials('https://a:1@x.example/ https://b:2@y.example/'),
    'https://x.example/ https://y.example/',
  )
  // 没有凭据、也不是 URL 的文本原样保留。
  assert.equal(stripUrlCredentials('https://registry.npmjs.org/x'), 'https://registry.npmjs.org/x')
  assert.equal(stripUrlCredentials('npm 安装失败'), 'npm 安装失败')
})

test('describeError redacts both secrets and tolerates odd input', () => {
  const error = new Error(
    'GET https://bob:hunter2@npm.internal/@deepseek-ai%2fdsh/latest?token=SECRET-1 failed',
  )

  const described = describeError(error)

  assert.equal(described.includes('hunter2'), false)
  assert.equal(described.includes('SECRET-1'), false)
  assert.match(described, /https:\/\/npm\.internal\//)
  assert.equal(describeError('plain failure'), 'plain failure')
  assert.equal(describeError(null), '')
})

test('never writes the launch token to the log while callers still get it', async () => {
  const stream = new Readable({ read() {} })
  const lines = []
  const logged = []
  const originalLog = console.log
  console.log = (text) => logged.push(String(text))
  try {
    appendProcessOutput(stream, 'log', (line) => lines.push(line))
    stream.push('dsh web: http://127.0.0.1:1234/?token=Super-Secret\n')
    await new Promise((resolve) => setImmediate(resolve))
  } finally {
    console.log = originalLog
  }

  // 回调拿到原文（启动流程要用它带上令牌去加载页面）……
  assert.equal(lines[0], 'dsh web: http://127.0.0.1:1234/?token=Super-Secret')
  // ……但日志里只剩结构。
  assert.equal(logged[0], '[dsh] dsh web: http://127.0.0.1:1234/?token=***')
  assert.equal(logged.join('\n').includes('Super-Secret'), false)
})

test('only resolves Windows system binaries from a sane absolute root', () => {
  assert.equal(
    windowsSystemBinary('where', { SystemRoot: 'C:\\Windows' }),
    'C:\\Windows\\System32\\where.exe',
  )
  assert.equal(
    windowsSystemBinary('taskkill', { windir: 'D:\\Windows' }),
    'D:\\Windows\\System32\\taskkill.exe',
  )
  // 相对路径（或缺失）时必须回退到命令名，不能从当前工作目录解析出可执行文件。
  assert.equal(windowsSystemBinary('where', { SystemRoot: 'relative-root' }), 'where.exe')
  assert.equal(windowsSystemBinary('where', {}), 'where.exe')
})

// 边界：只有"像样的协议名"才做凭据剥离，避免把 Windows 盘符路径里的 @ 当成密码删掉；
// 出错对象不是 Error（例如跨 IPC 传来的普通对象）时也要能取出 message。
test('keeps drive-letter paths and non-URL text intact', () => {
  assert.equal(stripUrlCredentials('C://foo@bar'), 'C://foo@bar')
  assert.equal(stripUrlCredentials('/home/user@host/file'), '/home/user@host/file')
  assert.equal(stripUrlCredentials('contact user@example.com'), 'contact user@example.com')
})

test('describes plain objects that only carry a message', () => {
  assert.equal(
    describeError({ message: 'fetch https://u:p@h/x failed' }),
    'fetch https://h/x failed',
  )
  assert.equal(describeError(undefined), '')
  assert.equal(describeError(42), '42')
})
