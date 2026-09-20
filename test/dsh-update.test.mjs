import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  DSH_UPDATE_FAILURE_COOLDOWN_MS,
  dshUpdateLaunchNotice,
  dshUpdateMenuLabel,
  dshUpdateNoticePath,
  isDshUpdateCacheFresh,
  isDshUpdateCoolingDown,
  isDshUpdateNotified,
  readDshUpdateNotice,
  writeDshUpdateNotice,
} from '../src/updates/dsh-update.mjs'
import { createDshUpdateController } from '../src/updates/dsh-update-controller.mjs'

async function createTempUserData() {
  return mkdtemp(path.join(os.tmpdir(), 'dsh-update-'))
}

test('labels the tray entry for every update state', () => {
  assert.equal(dshUpdateMenuLabel({ status: 'idle' }), '检查 Harness 更新')
  assert.equal(
    dshUpdateMenuLabel({ status: 'idle', installedVersion: '1.2.2' }),
    '检查 Harness 更新（当前 v1.2.2）',
  )
  assert.equal(
    dshUpdateMenuLabel({ status: 'available', latestVersion: '1.3.0' }),
    '更新 Harness 到 v1.3.0',
  )
  assert.equal(
    dshUpdateMenuLabel({ status: 'updating', latestVersion: '1.3.0' }),
    '正在更新 Harness 到 v1.3.0…',
  )
  assert.equal(
    dshUpdateMenuLabel({ status: 'failed', latestVersion: '1.3.0' }),
    'Harness 更新失败，点击重试（v1.3.0）',
  )
  // 非法版本号（例如被投毒的软件源）不能进入托盘文案。
  assert.equal(
    dshUpdateMenuLabel({ status: 'available', latestVersion: 'not-a-version' }),
    '更新 Harness',
  )
})

test('describes the pending update for the loading page', () => {
  assert.equal(dshUpdateLaunchNotice({}), '')
  assert.match(
    dshUpdateLaunchNotice({ latestVersion: '1.3.0', installedVersion: '1.2.2' }),
    /发现新版本 v1\.3\.0/,
  )
})

test('only prompts once per version across launches and runtime checks', () => {
  assert.equal(isDshUpdateNotified(null, '1.3.0'), false)
  assert.equal(isDshUpdateNotified({ version: '1.3.0' }, '1.3.0'), true)
  assert.equal(isDshUpdateNotified({ version: '1.2.0' }, '1.3.0'), false)
  assert.equal(isDshUpdateNotified({ version: '1.3.0' }, 'invalid'), false)
})

test('cools down after a failed update instead of retrying immediately', () => {
  const failedAt = 1_000_000
  assert.equal(isDshUpdateCoolingDown({ failedAt, now: failedAt + 1_000 }), true)
  assert.equal(
    isDshUpdateCoolingDown({ failedAt, now: failedAt + DSH_UPDATE_FAILURE_COOLDOWN_MS }),
    false,
  )
  // 时钟回拨或空记录都不算冷却中。
  assert.equal(isDshUpdateCoolingDown({ failedAt, now: failedAt - 5_000 }), false)
  assert.equal(isDshUpdateCoolingDown({ failedAt: 0 }), false)
})

test('keeps successful checks for six hours and failures for five minutes', () => {
  const checkedAt = 1_000_000
  assert.equal(isDshUpdateCacheFresh({ checkedAt, successful: true, now: checkedAt + 60_000 }), true)
  assert.equal(
    isDshUpdateCacheFresh({ checkedAt, successful: true, now: checkedAt + 7 * 60 * 60_000 }),
    false,
  )
  assert.equal(
    isDshUpdateCacheFresh({ checkedAt, successful: false, now: checkedAt + 6 * 60_000 }),
    false,
  )
})

test('persists the prompted version and rejects tampered notice files', async () => {
  const userDataPath = await createTempUserData()
  try {
    const noticePath = dshUpdateNoticePath(userDataPath)
    assert.equal(await readDshUpdateNotice(noticePath), null)

    await writeDshUpdateNotice(noticePath, '1.3.0', 1_700_000_000_000)
    assert.deepEqual(await readDshUpdateNotice(noticePath), {
      version: '1.3.0',
      notifiedAt: 1_700_000_000_000,
    })

    await writeFile(noticePath, '{"notifiedVersion":"not-a-version","notifiedAt":1700000000000}')
    assert.equal(await readDshUpdateNotice(noticePath), null)

    await writeFile(noticePath, '{"notifiedVersion":"1.3.0","notifiedAt":"yesterday"}')
    assert.equal(await readDshUpdateNotice(noticePath), null)

    await writeFile(noticePath, 'not json at all')
    assert.equal(await readDshUpdateNotice(noticePath), null)

    await assert.rejects(writeDshUpdateNotice(noticePath, 'not-a-version'), /无效的 Harness/)
  } finally {
    await rm(userDataPath, { recursive: true, force: true })
  }
})

function createInstallation(version) {
  return {
    source: 'global',
    version,
    packageRoot: '/npm/lib/node_modules/@deepseek-ai/dsh',
    binPath: '/npm/bin/dsh.js',
    binDir: '/npm/bin',
  }
}

// 用假 npm / 假对话框驱动更新控制器：只注入纯函数式依赖，不触碰 Electron。
async function setupHarness({
  installedVersion = '1.2.2',
  latestVersion = '1.2.3',
  responses = [],
  failInstall = false,
  fetchFails = false,
  restartHarness = null,
} = {}) {
  const userDataPath = await createTempUserData()
  const nodeEnvironment = {
    source: 'system',
    version: '24.0.0',
    nodePath: '/usr/bin/node',
    npxCliPath: '/usr/lib/node_modules/npm/bin/npx-cli.js',
  }
  const calls = []
  const dialogs = []
  const statuses = []
  let manifestVersion = latestVersion
  let fetchShouldFail = fetchFails
  let installed = installedVersion ? createInstallation(installedVersion) : null

  const controller = createDshUpdateController({
    fetchImpl: async () => {
      if (fetchShouldFail) throw new Error('getaddrinfo ENOTFOUND')
      return Response.json({ version: manifestVersion })
    },
    reportStatus: (status) => statuses.push(status),
    showMessageBox: async (options) => {
      dialogs.push(options)
      return { response: responses.shift() ?? 1 }
    },
    userDataPath,
    getRuntime: () => (installed ? { nodeEnvironment, env: {}, installed } : null),
    stopHarness: () => calls.push('stop'),
    restartHarness:
      restartHarness ??
      (async () => {
        calls.push('restart')
      }),
    onInstallationChanged: (installation) => {
      installed = installation
    },
    installDsh: async ({ version }) => {
      calls.push(`install:${version}`)
      if (failInstall) throw new Error('npm 安装失败')
      return createInstallation(version)
    },
  })

  return {
    controller,
    calls,
    dialogs,
    statuses,
    nodeEnvironment,
    userDataPath,
    prepare: (overrides = {}) =>
      controller.prepareForLaunch({
        nodeEnvironment,
        installed: overrides.installed ?? installed,
        env: {},
      }),
    setLatest: (version) => {
      manifestVersion = version
    },
    setFetchFails: (value) => {
      fetchShouldFail = value
    },
    cleanup: () => rm(userDataPath, { recursive: true, force: true }),
  }
}

test('installs the first Harness silently without asking', async () => {
  const harness = await setupHarness({ installedVersion: null, latestVersion: '1.2.3' })
  try {
    const result = await harness.prepare({ installed: null })

    assert.equal(harness.dialogs.length, 0, '首次安装不该弹窗')
    assert.deepEqual(harness.calls, ['install:1.2.3'])
    assert.equal(result.installation.version, '1.2.3')
    assert.equal(result.notice, '')
  } finally {
    await harness.cleanup()
  }
})

test('asks before updating and keeps the installed version when the user postpones', async () => {
  const harness = await setupHarness({ responses: [1] })
  try {
    const result = await harness.prepare()

    assert.equal(harness.dialogs.length, 1)
    assert.deepEqual(harness.dialogs[0].buttons, ['立即更新', '稍后'])
    assert.deepEqual(harness.calls, [], '选择稍后不该执行 npm 安装')
    assert.equal(result.installation.version, '1.2.2')
    assert.match(result.notice, /发现新版本 v1\.2\.3/)
  } finally {
    await harness.cleanup()
  }
})

test('never asks twice for the same version', async () => {
  const harness = await setupHarness({ responses: [1] })
  try {
    await harness.prepare()
    const second = await harness.prepare()

    assert.equal(harness.dialogs.length, 1, '同一版本只提示一次')
    assert.equal(second.installation.version, '1.2.2')
    assert.match(second.notice, /发现新版本 v1\.2\.3/)
  } finally {
    await harness.cleanup()
  }
})

test('updates before launching when the user accepts at startup', async () => {
  const harness = await setupHarness({ responses: [0] })
  try {
    const result = await harness.prepare()

    assert.deepEqual(harness.calls, ['install:1.2.3'])
    assert.equal(result.installation.version, '1.2.3')
    assert.equal(result.notice, '')
    // 装成功后清掉提示记录，避免下一版本误判为已提示过。
    assert.equal(await readDshUpdateNotice(dshUpdateNoticePath(harness.userDataPath)), null)
  } finally {
    await harness.cleanup()
  }
})

test('stops the harness before installing and restarts it afterwards', async () => {
  const harness = await setupHarness({ responses: [1, 0] })
  try {
    await harness.prepare()
    await harness.controller.menuItem().click()

    assert.deepEqual(harness.calls, ['stop', 'install:1.2.3', 'restart'])
    assert.equal(harness.controller.state.status, 'current')
  } finally {
    await harness.cleanup()
  }
})

test('keeps running the old version and reports the failure when npm fails', async () => {
  const harness = await setupHarness({ responses: [1, 0], failInstall: true })
  try {
    await harness.prepare()
    await harness.controller.menuItem().click()

    assert.deepEqual(harness.calls, ['stop', 'install:1.2.3', 'restart'])
    assert.equal(harness.controller.state.status, 'failed')
    assert.match(harness.controller.state.error, /npm 安装失败/)
    assert.equal(harness.dialogs.at(-1).type, 'error')
    assert.equal(
      harness.statuses.some((status) => status.error === true),
      true,
      '失败要带 error 标记，启动页才显示中断样式',
    )
  } finally {
    await harness.cleanup()
  }
})

test('detects a new release while running and only asks once per version', async () => {
  const harness = await setupHarness({ installedVersion: '1.2.2', latestVersion: '1.2.2', responses: [1] })
  try {
    await harness.prepare()
    assert.equal(harness.dialogs.length, 0)

    harness.setLatest('1.2.3')
    await harness.controller.checkForUpdate({ manual: true })
    assert.equal(harness.dialogs.length, 1, '运行中发现新版本要提示一次')

    await harness.controller.checkForUpdate({ manual: true })
    assert.equal(harness.dialogs.length, 1, '已提示过的版本不再打扰')
    assert.equal(
      harness.controller.menuItem().label,
      '更新 Harness 到 v1.2.3',
      '托盘常驻手动更新入口',
    )
  } finally {
    await harness.cleanup()
  }
})

test('reports an up-to-date harness for manual checks', async () => {
  const harness = await setupHarness({ installedVersion: '1.2.3', latestVersion: '1.2.3' })
  try {
    await harness.prepare()
    await harness.controller.checkForUpdate({ manual: true })

    assert.equal(harness.dialogs.length, 1)
    assert.match(harness.dialogs[0].message, /当前已是最新版本 v1\.2\.3/)
  } finally {
    await harness.cleanup()
  }
})

test('distinguishes a failed update check from a failed update', () => {
  assert.equal(
    dshUpdateMenuLabel({ status: 'failed', latestVersion: '1.3.0', failureKind: 'check' }),
    'Harness 更新检查失败，点击重试（v1.3.0）',
  )
  assert.equal(
    dshUpdateMenuLabel({ status: 'failed', latestVersion: '1.3.0', failureKind: 'update' }),
    'Harness 更新失败，点击重试（v1.3.0）',
  )
  // 老状态（没有 failureKind）按"更新失败"处理，措辞保持兼容。
  assert.equal(
    dshUpdateMenuLabel({ status: 'failed', latestVersion: '1.3.0' }),
    'Harness 更新失败，点击重试（v1.3.0）',
  )
})

test('says it could not check instead of claiming the app is up to date', async () => {
  const harness = await setupHarness({ installedVersion: '1.2.3', latestVersion: '1.2.3', fetchFails: true })
  try {
    await harness.prepare()
    await harness.controller.checkForUpdate({ manual: true })

    assert.match(harness.dialogs.at(-1).message, /无法联网检查 Harness 更新/)
    assert.equal(harness.dialogs.at(-1).message.includes('已是最新版本'), false)
    assert.equal(harness.controller.state.status, 'current')
  } finally {
    await harness.cleanup()
  }
})

test('marks a failed check as a check failure, not an update failure', async () => {
  const harness = await setupHarness({ installedVersion: '1.2.2', latestVersion: '1.2.3' })
  try {
    // 用目录占住"已提示版本"文件的位置：检查流程在记录提示状态时会抛错，
    // 这正是 markFailed(..., 'check') 要覆盖的异常分支。
    await mkdir(dshUpdateNoticePath(harness.userDataPath), { recursive: true })

    await harness.controller.checkForUpdate({ manual: true })

    assert.equal(harness.controller.state.status, 'failed')
    assert.equal(harness.controller.state.failureKind, 'check')
    assert.match(harness.controller.menuItem().label, /Harness 更新检查失败，点击重试/)
    assert.equal(
      harness.calls.some((call) => String(call).startsWith('install')),
      false,
      '检查失败不该触发任何安装',
    )
  } finally {
    await harness.cleanup()
  }
})

test('keeps the startup wording honest when the version check could not run', async () => {
  const harness = await setupHarness({ installedVersion: '1.2.2', latestVersion: '1.2.2', fetchFails: true })
  try {
    const result = await harness.prepare()

    assert.equal(result.installation.version, '1.2.2')
    assert.equal(
      harness.statuses.some((status) => /使用已安装版本 1\.2\.2/.test(status.detail ?? '')),
      true,
    )
  } finally {
    await harness.cleanup()
  }
})

test('reports which environment failed the first install', async () => {
  const harness = await setupHarness({ installedVersion: null, failInstall: true })
  try {
    await assert.rejects(harness.prepare({ installed: null }), /无法在用户全局环境安装 DeepSeek Harness：npm 安装失败/)
  } finally {
    await harness.cleanup()
  }
})

test('does not start a second install while the harness is restarting', async () => {
  let releaseRestart
  let restartEntered = false
  const gate = new Promise((resolve) => {
    releaseRestart = resolve
  })
  const harness = await setupHarness({
    responses: [1, 0, 0],
    restartHarness: async () => {
      restartEntered = true
      harness.calls.push('restart')
      await gate
    },
  })
  try {
    await harness.prepare()
    const first = harness.controller.menuItem().click()
    // 等第一次更新真正走到"重启 Harness"这一步（轮询而不是猜时间）。
    const deadline = Date.now() + 5_000
    while (!restartEntered && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(restartEntered, true, '第一次更新应当走到重启这一步')
    await harness.controller.menuItem().click()

    assert.equal(
      harness.calls.filter((call) => String(call).startsWith('install')).length,
      1,
      '重启期间连点托盘不能并发跑第二次 npm install',
    )

    releaseRestart()
    await first
    assert.equal(harness.controller.state.status, 'current')
  } finally {
    await harness.cleanup()
  }
})
