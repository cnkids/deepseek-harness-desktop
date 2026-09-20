import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createDesktopUpdateController } from '../src/updates/desktop-update.mjs'

// 桌面端更新控制器：注入假 Electron（app / shell）与假更新源，在 Node 里完整驱动
// "检查 → 下载 → 提示 → 安装"这条链路。platform 也可以注入，因此 macOS / Windows /
// Linux 三条分支在任何平台上都能确定性验证。
async function setup({
  version = '0.3.0',
  isPackaged = true,
  isPortable = false,
  platform = 'darwin',
  appImagePath = null,
  manifestVersion = null,
  responses = [],
  downloadFails = false,
  openPathError = '',
  initialNow = () => 1_700_000_000_000,
} = {}) {
  const userDataPath = await mkdtemp(path.join(os.tmpdir(), 'desktop-update-'))
  const dialogs = []
  const calls = []
  let clock = initialNow()

  const controller = createDesktopUpdateController({
    app: {
      getVersion: () => version,
      isPackaged,
      relaunch: (options) => calls.push(['relaunch', options]),
    },
    shell: {
      openPath: async (file) => {
        calls.push(['openPath', file])
        return openPathError
      },
    },
    fetchImpl: async () => Response.json({}),
    isPortableBuild: isPortable,
    userDataPath,
    showMessageBox: async (options) => {
      dialogs.push(options)
      return { response: responses.shift() ?? 1 }
    },
    quitApplication: () => calls.push(['quit']),
    appImagePath,
    platform,
    now: () => clock,
    fetchUpdate: async ({ currentVersion, platform: target, isAppImage }) => {
      calls.push(['fetch', currentVersion, target, isAppImage])
      if (!manifestVersion) return null
      // 安装包扩展名要跟平台一致：Linux AppImage 走原位替换，其余交给系统安装界面。
      const extension = target === 'darwin' ? 'dmg' : target === 'win32' ? 'exe' : isAppImage ? 'AppImage' : 'deb'
      const assetName = `DeepSeek-Harness-Desktop-${manifestVersion}-${target}-arm64.${extension}`
      return {
        manifest: { version: manifestVersion },
        asset: {
          name: assetName,
          size: 10,
          sha256: 'a'.repeat(64),
          url: `https://example.com/${assetName}`,
        },
      }
    },
    downloadUpdate: async ({ destination, onProgress }) => {
      calls.push(['download', destination])
      onProgress?.({ received: 4, total: 10 })
      if (downloadFails) throw new Error('网络中断')
      await mkdir(path.dirname(destination), { recursive: true })
      await writeFile(destination, 'installer-bytes')
      return destination
    },
  })

  return {
    controller,
    dialogs,
    calls,
    userDataPath,
    setNow: (value) => {
      clock = value
    },
    downloadsRoot: path.join(userDataPath, 'updates'),
    cleanup: () => rm(userDataPath, { recursive: true, force: true }),
  }
}

test('labels the tray entry for the idle and portable cases', async () => {
  const harness = await setup()
  const portable = await setup({ isPortable: true, version: '0.2.8' })
  try {
    assert.equal(harness.controller.menuItem().label, '检查桌面端更新（当前 v0.3.0）')
    assert.equal(harness.controller.menuItem().enabled, true)
    assert.equal(portable.controller.menuItem().label, '便携版 v0.2.8（手动更新）')
  } finally {
    await harness.cleanup()
    await portable.cleanup()
  }
})

test('does not check for updates in development mode', async () => {
  const harness = await setup({ isPackaged: false })
  try {
    await harness.controller.check({ manual: true })

    assert.equal(harness.calls.some(([name]) => name === 'fetch'), false)
    assert.match(harness.dialogs[0].message, /开发模式不会检查桌面端更新/)
  } finally {
    await harness.cleanup()
  }
})

test('tells portable users to download the new file manually', async () => {
  const harness = await setup({ isPortable: true, version: '0.2.8' })
  try {
    await harness.controller.check({ manual: true })

    assert.equal(harness.calls.some(([name]) => name === 'fetch'), false)
    assert.match(harness.dialogs[0].message, /当前是便携版 v0\.2\.8/)
    assert.match(harness.dialogs[0].detail, /便携版不会自动安装新版本/)
  } finally {
    await harness.cleanup()
  }
})

test('reports an up-to-date desktop app on manual checks', async () => {
  const harness = await setup({ manifestVersion: null })
  try {
    await harness.controller.check({ manual: true })

    assert.deepEqual(harness.calls[0], ['fetch', '0.3.0', 'darwin', false])
    assert.match(harness.dialogs[0].message, /当前已是最新版本 v0\.3\.0/)
    assert.equal(harness.controller.menuItem().label, '检查桌面端更新（当前 v0.3.0）')
  } finally {
    await harness.cleanup()
  }
})

test('downloads a new release, verifies it and offers to install', async () => {
  const harness = await setup({ manifestVersion: '1.0.0', responses: [1] })
  try {
    await harness.controller.check({ manual: true })

    const download = harness.calls.find(([name]) => name === 'download')
    const assetName = 'DeepSeek-Harness-Desktop-1.0.0-darwin-arm64.dmg'
    assert.equal(download[1], path.join(harness.downloadsRoot, 'v1.0.0', assetName))
    assert.equal(await readFile(download[1], 'utf8'), 'installer-bytes')
    assert.equal(harness.controller.menuItem().label, '安装桌面端更新 v1.0.0')

    const prompt = harness.dialogs.at(-1)
    assert.match(prompt.message, /已下载并通过完整性校验/)
    assert.deepEqual(prompt.buttons, ['打开安装包', '稍后'])
    assert.match(prompt.detail, /拖入“应用程序”文件夹/)
  } finally {
    await harness.cleanup()
  }
})

test('keeps only the newest downloaded release', async () => {
  const harness = await setup({ manifestVersion: '1.0.0', responses: [1] })
  try {
    const stale = path.join(harness.downloadsRoot, 'v0.9.0')
    await mkdir(stale, { recursive: true })
    await writeFile(path.join(stale, 'old.dmg'), 'old')

    await harness.controller.check({ manual: true })

    await assert.rejects(stat(stale), /ENOENT/)
  } finally {
    await harness.cleanup()
  }
})

test('reuses a fresh pending download and expires an ignored one after 48 hours', async () => {
  const harness = await setup({ manifestVersion: '1.0.0', responses: [1, 1] })
  try {
    await harness.controller.check({ manual: true })
    assert.equal(harness.dialogs.length, 1)

    // 48 小时内再次手动检查：直接重新提示，不再联网。
    await harness.controller.check({ manual: true })
    assert.equal(harness.calls.filter(([name]) => name === 'fetch').length, 1)
    assert.equal(harness.dialogs.length, 2)

    // 超过 48 小时后过期：重新走一次检查。
    harness.setNow(1_700_000_000_000 + 49 * 60 * 60_000)
    await harness.controller.check({ manual: true })
    assert.equal(harness.calls.filter(([name]) => name === 'fetch').length, 2)
  } finally {
    await harness.cleanup()
  }
})

test('surfaces a download failure without breaking the current version', async () => {
  const harness = await setup({ manifestVersion: '1.0.0', downloadFails: true })
  try {
    await harness.controller.check({ manual: true })

    assert.match(harness.dialogs.at(-1).message, /暂时无法检查桌面端更新/)
    assert.match(harness.dialogs.at(-1).detail, /网络中断/)
    assert.equal(harness.controller.menuItem().label, '检查桌面端更新（当前 v0.3.0）')
  } finally {
    await harness.cleanup()
  }
})

test('opens the installer on macOS and keeps the app running', async () => {
  const harness = await setup({ manifestVersion: '1.0.0', responses: [0] })
  try {
    await harness.controller.check({ manual: true })

    const opened = harness.calls.filter(([name]) => name === 'openPath')
    assert.equal(opened.length, 1)
    assert.match(opened[0][1], /1\.0\.0-darwin-arm64\.dmg$/)
    assert.equal(harness.calls.some(([name]) => name === 'quit'), false)
    assert.equal(harness.controller.menuItem().label, '安装桌面端更新 v1.0.0')
  } finally {
    await harness.cleanup()
  }
})

test('quits after handing the NSIS installer to Windows', async () => {
  const harness = await setup({ manifestVersion: '1.0.0', platform: 'win32', responses: [0] })
  try {
    await harness.controller.check({ manual: true })

    assert.equal(harness.calls.some(([name]) => name === 'openPath'), true)
    assert.equal(harness.calls.some(([name]) => name === 'quit'), true)
    assert.match(harness.dialogs.at(-1).buttons[0] ?? '', /稍后|退出并安装/)
  } finally {
    await harness.cleanup()
  }
})

test('replaces the current AppImage in place and relaunches', async () => {
  const userDataPath = await mkdtemp(path.join(os.tmpdir(), 'desktop-update-appimage-'))
  const currentAppImage = path.join(userDataPath, 'DeepSeek-Harness-Desktop.AppImage')
  await writeFile(currentAppImage, 'old-appimage')
  const harness = await setup({
    manifestVersion: '1.0.0',
    platform: 'linux',
    appImagePath: currentAppImage,
    responses: [0],
  })
  try {
    await harness.controller.check({ manual: true })

    assert.equal(await readFile(currentAppImage, 'utf8'), 'installer-bytes')
    assert.equal((await stat(currentAppImage)).mode & 0o111, 0o111, '新 AppImage 必须可执行')
    assert.deepEqual(harness.calls.at(-1), ['quit'])
    assert.equal(
      harness.calls.some(([name, options]) => name === 'relaunch' && options?.execPath === currentAppImage),
      true,
    )
    // AppImage 场景要按"当前是 AppImage"去挑安装包。
    assert.deepEqual(harness.calls[0], ['fetch', '0.3.0', 'linux', true])
  } finally {
    await harness.cleanup()
    await rm(userDataPath, { recursive: true, force: true })
  }
})

test('reports a failed install instead of pretending it worked', async () => {
  const harness = await setup({
    manifestVersion: '1.0.0',
    responses: [0],
    openPathError: '权限不足',
  })
  try {
    await harness.controller.check({ manual: true })

    const failure = harness.dialogs.at(-1)
    assert.equal(failure.title, '无法安装更新')
    assert.match(failure.detail, /权限不足/)
    assert.equal(harness.controller.menuItem().enabled, true)
  } finally {
    await harness.cleanup()
  }
})
