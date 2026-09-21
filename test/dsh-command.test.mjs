import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createDshCommandController, detectDshCommandState } from '../src/dsh-command.mjs'
import { readPathFixState } from '../src/dsh-path.mjs'

const systemNode = { source: 'system', version: '24.0.0', nodePath: '/usr/bin/node' }
const managedNode = { source: 'managed', version: '24.12.0', nodePath: '/app/runtime/bin/node' }
const installation = {
  source: 'global',
  version: '1.2.3',
  binPath: path.join('/npm', 'bin', 'dsh.js'),
  binDir: path.join('/npm', 'bin'),
}

// 假 PATH：只包含系统目录，因此 dsh 的 binDir 视为"不在 PATH 上"。
// 路径与分隔符都按宿主平台构造：Windows 上 binDir 是 `\npm\bin`，
// 用 POSIX 风格的 `/npm/bin` 永远匹配不上，测的就不是真实语义了。
const PATH_WITHOUT_DSH = path.join(path.sep, 'usr', 'bin')
const PATH_WITH_DSH = [installation.binDir, PATH_WITHOUT_DSH].join(path.delimiter)

function createHarness({ responses = [], pathValue = PATH_WITHOUT_DSH } = {}) {
  const dialogs = []
  const applied = []
  let userDataPath = null
  return {
    dialogs,
    applied,
    setUserDataPath(value) {
      userDataPath = value
    },
    build() {
      return createDshCommandController({
        userDataPath,
        pathValue,
        showMessageBox: async (options) => {
          dialogs.push(options)
          return { response: responses.shift() ?? 1 }
        },
        applyPathFix: async ({ binDir }) => {
          applied.push(binDir)
          return { kind: 'shell-rc', detail: '/home/me/.zshrc' }
        },
      })
    },
  }
}

async function withController(run, options) {
  const userDataPath = await mkdtemp(path.join(os.tmpdir(), 'dsh-command-'))
  const harness = createHarness(options)
  harness.setUserDataPath(userDataPath)
  try {
    await run(harness.build(), harness, userDataPath)
  } finally {
    await rm(userDataPath, { recursive: true, force: true })
  }
}

test('only offers the PATH fix when dsh comes from a system Node.js', () => {
  // 私有 runtime 目录里同时含 node 与 npm，把它加进用户 PATH 等于顺手装一套 Node.js。
  assert.equal(detectDshCommandState(managedNode, installation, PATH_WITHOUT_DSH), null)
  assert.equal(
    detectDshCommandState(systemNode, { ...installation, binDir: undefined }, PATH_WITHOUT_DSH),
    null,
  )

  const missing = detectDshCommandState(systemNode, installation, PATH_WITHOUT_DSH)
  assert.equal(missing.needsPathFix, true)
  assert.equal(missing.binDir, installation.binDir)

  const present = detectDshCommandState(systemNode, installation, PATH_WITH_DSH)
  assert.equal(present.needsPathFix, false)
})

test('hides the tray row until startup has resolved the environment', async () => {
  await withController(async (controller) => {
    assert.deepEqual(controller.menuItems(), [])

    await controller.loadState()
    await controller.refresh(systemNode, installation)

    const [row, separator] = controller.menuItems()
    assert.equal(row.label, '修复 dsh 命令（加入 PATH）')
    assert.equal(row.enabled, true)
    assert.equal(typeof row.click, 'function')
    assert.deepEqual(separator, { type: 'separator' })
  })
})

test('describes an already usable dsh command without offering the fix', async () => {
  await withController(async (controller) => {
    await controller.loadState()
    await controller.refresh(systemNode, installation)

    const [row] = controller.menuItems()
    assert.equal(row.label, 'dsh 命令已可用（用户 Node.js 24.0.0）')
    assert.equal(row.enabled, false)
    assert.equal(row.click, undefined)
  }, { pathValue: PATH_WITH_DSH })
})

test('describes the private runtime case in the tray', async () => {
  await withController(async (controller) => {
    await controller.loadState()
    await controller.refresh(managedNode, installation)

    const [row] = controller.menuItems()
    assert.equal(row.label, 'dsh 命令仅在应用内可用（应用私有 Node.js）')
    assert.equal(row.enabled, false)
  })
})

test('asks about the PATH fix once per directory and remembers the answer', async () => {
  await withController(async (controller, harness, userDataPath) => {
    await controller.loadState()
    await controller.refresh(systemNode, installation)

    await controller.promptOnce()
    assert.equal(harness.dialogs.length, 1)
    assert.deepEqual(harness.dialogs[0].buttons, ['立即修复', '稍后'])
    assert.deepEqual(harness.applied, [], '选择稍后不该改动 PATH')
    assert.deepEqual(await readPathFixState(path.join(userDataPath, 'cache', 'dsh-path.json')), {
      promptedFor: installation.binDir,
      appliedFor: null,
    })

    await controller.promptOnce()
    assert.equal(harness.dialogs.length, 1, '同一目录只提示一次')
  })
})

test('does not ask again after a restart for the same directory', async () => {
  const userDataPath = await mkdtemp(path.join(os.tmpdir(), 'dsh-command-restart-'))
  const first = createHarness({ responses: [1] })
  first.setUserDataPath(userDataPath)
  const second = createHarness({ responses: [0] })
  second.setUserDataPath(userDataPath)
  try {
    const initial = first.build()
    await initial.loadState()
    await initial.refresh(systemNode, installation)
    await initial.promptOnce()

    // 新进程（重启后）读取同一份状态：不该再弹窗。
    const restarted = second.build()
    await restarted.loadState()
    await restarted.refresh(systemNode, installation)
    await restarted.promptOnce()

    assert.equal(second.dialogs.length, 0)
  } finally {
    await rm(userDataPath, { recursive: true, force: true })
  }
})

test('repairs the PATH when the user accepts and remembers the directory', async () => {
  await withController(async (controller, harness, userDataPath) => {
    await controller.loadState()
    await controller.refresh(systemNode, installation)

    await controller.apply()

    assert.deepEqual(harness.applied, [installation.binDir])
    assert.equal(harness.dialogs.at(-1).title, 'dsh 命令已加入 PATH')
    const state = await readPathFixState(path.join(userDataPath, 'cache', 'dsh-path.json'))
    assert.equal(state.appliedFor, installation.binDir)

    // shell rc 的改动不会反映到 GUI 应用自身的 process.env.PATH：刷新时必须以
    // "已为这个目录修复过"为准，否则每次启动都会判定还没修好。
    await controller.refresh(systemNode, installation)
    assert.equal(controller.state.needsPathFix, false)
    assert.equal(controller.menuItems()[0].label, 'dsh 命令已可用（用户 Node.js 24.0.0）')
  })
})

test('reports a failed PATH fix instead of pretending it worked', async () => {
  const userDataPath = await mkdtemp(path.join(os.tmpdir(), 'dsh-command-failure-'))
  const dialogs = []
  try {
    const controller = createDshCommandController({
      userDataPath,
      pathValue: PATH_WITHOUT_DSH,
      showMessageBox: async (options) => {
        dialogs.push(options)
        return { response: 1 }
      },
      applyPathFix: async () => {
        throw new Error('没有写权限')
      },
    })
    await controller.loadState()
    await controller.refresh(systemNode, installation)
    await controller.apply()

    assert.equal(dialogs.at(-1).type, 'error')
    assert.match(dialogs.at(-1).detail, /没有写权限/)
    assert.equal(controller.state.needsPathFix, true)
  } finally {
    await rm(userDataPath, { recursive: true, force: true })
  }
})
