import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  downloadReleaseAsset,
  fetchAvailableUpdate,
  parseReleaseManifest,
  selectReleaseAsset,
} from '../src/app-update.mjs'

const contents = Buffer.from('verified update')
const sha256 = '59f19f34399b14e5f1628642e9ce341d660094ba76898e4db6b1875f525b6a6a'

function manifest(version = '1.2.3') {
  return {
    schemaVersion: 1,
    version,
    assets: [
      {
        name: `DeepSeek-Harness-Desktop-${version}-mac-arm64.dmg`,
        size: contents.length,
        sha256,
        url: `https://downloads.example.com/${version}/mac-arm64.dmg`,
      },
      {
        name: `DeepSeek-Harness-Desktop-${version}-linux-x64.AppImage`,
        size: contents.length,
        sha256,
        url: `https://downloads.example.com/${version}/linux-x64.AppImage`,
      },
      {
        name: `DeepSeek-Harness-Desktop-${version}-linux-x64.deb`,
        size: contents.length,
        sha256,
        url: `https://downloads.example.com/${version}/linux-x64.deb`,
      },
      {
        name: `DeepSeek-Harness-Desktop-${version}-win-x64.exe`,
        size: contents.length,
        sha256,
        url: `https://downloads.example.com/${version}/win-x64.exe`,
      },
      {
        name: `DeepSeek-Harness-Desktop-${version}-portable-x64.exe`,
        size: contents.length,
        sha256,
        url: `https://downloads.example.com/${version}/portable-x64.exe`,
      },
    ],
  }
}

test('validates manifests and selects the native package', () => {
  const release = parseReleaseManifest(manifest())
  assert.equal(
    selectReleaseAsset(release, { platform: 'darwin', arch: 'arm64' }).name,
    'DeepSeek-Harness-Desktop-1.2.3-mac-arm64.dmg',
  )
  // electron-builder 的 ${arch} 宏在 Linux 上同样是 x64/arm64：改名会让
  // 桌面端自动更新永远找不到安装包，这里锁定真实产物名。
  assert.equal(
    selectReleaseAsset(release, { platform: 'linux', arch: 'x64', isAppImage: true }).name,
    'DeepSeek-Harness-Desktop-1.2.3-linux-x64.AppImage',
  )
  assert.equal(
    selectReleaseAsset(release, { platform: 'linux', arch: 'x64', isAppImage: false }).name,
    'DeepSeek-Harness-Desktop-1.2.3-linux-x64.deb',
  )
  // 免安装版与安装版同名时会互相覆盖，自动更新必须只挑 NSIS 安装包。
  assert.equal(
    selectReleaseAsset(release, { platform: 'win32', arch: 'x64' }).name,
    'DeepSeek-Harness-Desktop-1.2.3-win-x64.exe',
  )
  assert.equal(selectReleaseAsset(release, { platform: 'win32', arch: 'arm64' }), null)
  assert.equal(selectReleaseAsset(release, { platform: 'linux', arch: 'arm64' }), null)
  assert.throws(() => parseReleaseManifest({ ...manifest(), schemaVersion: 2 }), /不受支持/)
  const unsafe = manifest()
  unsafe.assets[0].name = '../update.dmg'
  assert.throws(() => parseReleaseManifest(unsafe), /无效的安装包信息/)
})

test('only returns releases newer than the current app', async () => {
  const fetchImpl = async () => Response.json(manifest('1.2.3'))
  assert.equal(
    await fetchAvailableUpdate({
      fetchImpl,
      currentVersion: '1.2.3',
      platform: 'darwin',
      arch: 'arm64',
    }),
    null,
  )
  const update = await fetchAvailableUpdate({
    fetchImpl,
    currentVersion: '1.2.2',
    platform: 'darwin',
    arch: 'arm64',
  })
  assert.equal(update.manifest.version, '1.2.3')
})

test('downloads, verifies, and reuses a cached update', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-app-update-'))
  const destination = path.join(directory, 'update.dmg')
  const asset = manifest().assets[0]
  let requests = 0
  const fetchImpl = async () => {
    requests += 1
    return new Response(contents)
  }

  await downloadReleaseAsset({ fetchImpl, asset, destination })
  assert.deepEqual(await readFile(destination), contents)
  await downloadReleaseAsset({ fetchImpl, asset, destination })
  assert.equal(requests, 1)

  await writeFile(destination, 'tampered')
  await downloadReleaseAsset({ fetchImpl, asset, destination })
  assert.equal(requests, 2)
  assert.deepEqual(await readFile(destination), contents)
})

test('rejects a package that does not match the release manifest', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-app-update-bad-'))
  await assert.rejects(
    downloadReleaseAsset({
      fetchImpl: async () => new Response('not the expected update'),
      asset: manifest().assets[0],
      destination: path.join(directory, 'update.dmg'),
    }),
    /超过|校验失败/,
  )
})
