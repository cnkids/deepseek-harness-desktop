import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createHarnessLauncher } from '../src/harness-launcher.mjs'
import { findCompatibleSystemNode } from '../src/node-runtime.mjs'
import { readStartupCache } from '../src/startup-cache.mjs'

// 用假 dsh 驱动完整的启动编排：环境解析（DSH_DESKTOP_NODE 指到当前 Node）→
// 版本准备（由假 dshUpdate 提供）→ 真实 spawn 子进程 → 轮询本地 HTTP 就绪 →
// 加载 Web UI。这样 harness-launcher 的编排逻辑也在单元测试覆盖范围内。

const FAKE_DSH_SOURCE = [
  "import http from 'node:http'",
  'const portIndex = process.argv.indexOf("--port")',
  'const port = Number(process.argv[portIndex + 1])',
  'const server = http.createServer((_request, response) => {',
  '  response.writeHead(200, { "content-type": "text/html" })',
  '  response.end("<html>harness</html>")',
  '})',
  'server.listen(port, "127.0.0.1", () => {',
  '  console.log(`dsh web: http://127.0.0.1:${port}/?token=fake-token`)',
  '})',
  '',
].join('\n')

// 启动失败场景：dsh 直接打印自己的报错后退出。
const BROKEN_DSH_SOURCE = [
  'console.error("[dsh] plugin not found")',
  'process.exit(2)',
  '',
].join('\n')

async function createFixtures(source) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harness-launcher-'))
  const binPath = path.join(root, 'fake-dsh.mjs')
  await writeFile(binPath, source)
  // 写成像样的 npm 包：启动缓存会校验 package.json 里的包名、版本与 bin 入口。
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.9.9', bin: { dsh: 'fake-dsh.mjs' } }),
  )
  return {
    root,
    installation: {
      source: 'global',
      version: '9.9.9',
      packageRoot: root,
      binPath,
      binDir: root,
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

function createRecorder() {
  return {
    statuses: [],
    loaded: [],
    loadLoadingPageCalls: 0,
    commandCalls: [],
  }
}

function createLauncher({ root, installation, record }) {
  return createHarnessLauncher({
    app: { isPackaged: false, getPath: () => root },
    userDataPath: root,
    fetchImpl: (url, options) => fetch(url, options),
    reportStatus: (status) => record.statuses.push(status),
    loadLoadingPage: async () => {
      record.loadLoadingPageCalls += 1
    },
    loadUrl: async (url) => {
      record.loaded.push(url)
    },
    isQuitting: () => false,
    dshCommand: {
      loadState: async () => record.commandCalls.push('loadState'),
      refresh: async () => record.commandCalls.push('refresh'),
      promptOnce: async () => record.commandCalls.push('promptOnce'),
    },
    dshUpdate: {
      prepareForLaunch: async () => ({ installation, notice: '发现新版本 v10.0.0' }),
    },
  })
}

async function withEnvironment(run) {
  const previousNode = process.env.DSH_DESKTOP_NODE
  const previousDsh = process.env.DSH_DESKTOP_DSH
  process.env.DSH_DESKTOP_NODE = process.execPath
  process.env.DSH_DESKTOP_DSH = process.execPath
  try {
    await run()
  } finally {
    if (previousNode === undefined) delete process.env.DSH_DESKTOP_NODE
    else process.env.DSH_DESKTOP_NODE = previousNode
    if (previousDsh === undefined) delete process.env.DSH_DESKTOP_DSH
    else process.env.DSH_DESKTOP_DSH = previousDsh
  }
}

// 只有在没有 DSH_DESKTOP_NODE / DSH_DESKTOP_DSH 覆盖时，启动流程才会读写启动缓存。
async function withoutEnvironmentOverrides(run) {
  const previousNode = process.env.DSH_DESKTOP_NODE
  const previousDsh = process.env.DSH_DESKTOP_DSH
  delete process.env.DSH_DESKTOP_NODE
  delete process.env.DSH_DESKTOP_DSH
  try {
    await run()
  } finally {
    if (previousNode !== undefined) process.env.DSH_DESKTOP_NODE = previousNode
    if (previousDsh !== undefined) process.env.DSH_DESKTOP_DSH = previousDsh
  }
}

test('launches the harness, waits for readiness and loads the Web UI', async () => {
  const fixtures = await createFixtures(FAKE_DSH_SOURCE)
  const record = createRecorder()
  let launcher = null
  try {
    await withEnvironment(async () => {
      launcher = createLauncher({ ...fixtures, record })
      await launcher.start()

      assert.equal(record.loaded.length, 1)
      assert.match(record.loaded[0], /^http:\/\/127\.0\.0\.1:\d+\/\?token=fake-token$/)
      assert.equal(record.statuses.at(-1).message, 'Harness 已启动')
      assert.equal(
        record.statuses.some((status) => /发现新版本 v10\.0\.0/.test(status.detail ?? '')),
        true,
        '启动页要带上"发现新版本，本次仍用当前版本"的提示',
      )
      assert.deepEqual(record.commandCalls, ['loadState', 'refresh', 'promptOnce'])
      assert.equal(launcher.installed.version, '9.9.9')
      // runtime 是运行中更新执行 npm 安装时要用的上下文（当前 Node 环境 + 当前安装）。
      assert.equal(launcher.runtime.installed.version, '9.9.9')
      assert.equal(launcher.runtime.nodeEnvironment.source, 'system')
      assert.match(launcher.origin, /^http:\/\/127\.0\.0\.1:\d+$/)

      // 停止后再次 start 会重新走一遍启动流程（运行中更新后就是这么重启的）。
      launcher.stop()
      await launcher.start()
      assert.equal(record.loaded.length, 2)
    })
  } finally {
    // 必须停掉子进程：否则它的管道会让测试进程无法退出。
    launcher?.stop()
    await fixtures.cleanup()
  }
})

test('surfaces the error dsh printed when the harness cannot start', async () => {
  const fixtures = await createFixtures(BROKEN_DSH_SOURCE)
  const record = createRecorder()
  try {
    await withEnvironment(async () => {
      const launcher = createLauncher({ ...fixtures, record })
      await launcher.start()

      assert.equal(record.loaded.length, 0)
      const failure = record.statuses.at(-1)
      assert.equal(failure.message, '启动失败')
      assert.equal(failure.error, true)
      assert.match(failure.detail, /进程已退出|plugin not found/)
    })
  } finally {
    await fixtures.cleanup()
  }
})

// 更新/安装完成后要把新的安装写回启动缓存：否则下次启动仍从缓存读到旧版本号，
// 于是又提示一次刚装好的版本。
test('remembers the prepared installation in the startup cache', async () => {
  const fixtures = await createFixtures(FAKE_DSH_SOURCE)
  const record = createRecorder()
  let launcher = null
  try {
    await withoutEnvironmentOverrides(async () => {
      // 没有兼容的系统 Node.js 时这里会去下载私有 runtime，本用例只在有系统 Node 时跑。
      if (!(await findCompatibleSystemNode({ loginShell: false }))) return

      launcher = createLauncher({ ...fixtures, record })
      await launcher.start()

      const cached = await readStartupCache(
        path.join(fixtures.root, 'cache', 'startup.json'),
      )
      assert.equal(cached.dshInstallation.version, '9.9.9')
      assert.equal(cached.nodeEnvironment.source, 'system')
    })
  } finally {
    launcher?.stop()
    await fixtures.cleanup()
  }
})
