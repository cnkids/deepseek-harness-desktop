import { chmod, lstat, mkdir, rm } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import semver from 'semver'
import * as tar from 'tar'
import yauzl from 'yauzl'
import {
  commandOutput,
  fileExists,
  isCompatibleNodeVersion,
  managedNodeInstallDirectory,
  managedNpxCliRelativePath,
} from './node-artifacts.mjs'

const UNSAFE_TAR_ENTRY_TYPES = new Set([
  'SymbolicLink',
  'Link',
  'CharacterDevice',
  'BlockDevice',
  'FIFO',
])

// 解压上限：官方归档（约 5 万个文件、解压后不到 200 MB）远低于这些值，设上限是为了
// 拒绝"解压炸弹"式归档，同时让损坏的下载尽快失败而不是把磁盘写满。
// 这是 SonarQube S5042（解压归档未限制资源消耗）推荐的缓解措施。
export const MAX_ARCHIVE_ENTRIES = 60_000
export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
const MAX_ENTRY_BYTES = 256 * 1024 * 1024

function assertArchiveBudget(entries, totalBytes) {
  if (entries > MAX_ARCHIVE_ENTRIES || totalBytes > MAX_ARCHIVE_BYTES) {
    throw new Error('Node.js 归档超出解压上限')
  }
}

export function validateTarEntry(entryName, entry) {
  const normalized = entryName.replaceAll('\\', '/')
  if (
    normalized.startsWith('/') ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.split('/').includes('..')
  ) {
    throw new Error(`Node.js 归档包含不安全路径：${entryName}`)
  }
  if (UNSAFE_TAR_ENTRY_TYPES.has(entry?.type)) {
    throw new Error(`Node.js 归档包含不允许的条目类型(${entry.type})：${entryName}`)
  }
  return true
}

export async function extractArchive(artifact, archivePath, extractDir) {
  await mkdir(extractDir, { recursive: true })
  if (artifact.archive === 'tar.gz') {
    let rejected = 0
    let entries = 0
    let totalBytes = 0
    await tar.x({
      file: archivePath,
      cwd: extractDir,
      strip: 1,
      filter: (entryPath, entry) => {
        try {
          validateTarEntry(entryPath, entry)
          const size = Number(entry?.size ?? 0)
          if (size > MAX_ENTRY_BYTES) throw new Error('Node.js 归档条目超出解压上限')
          entries += 1
          totalBytes += size
          assertArchiveBudget(entries, totalBytes)
          return true
        } catch {
          // 越界路径、链接/设备文件，以及超限条目都在这里被挡下，不写进磁盘。
          rejected += 1
          return false
        }
      },
    })
    if (rejected > 0) {
      throw new Error(
        `Node.js 归档包含 ${rejected} 个不安全条目或超出解压上限的条目,已中止安装。`,
      )
    }
    return extractDir
  }

  await extractZipSafely(archivePath, extractDir)
  const rootName = artifact.file.replace(/\.zip$/, '')
  return path.join(extractDir, rootName)
}

export function validateZipEntry(entryName, destinationRoot) {
  const normalized = entryName.replaceAll('\\', '/')
  const segments = normalized.split('/').filter(Boolean)
  if (
    normalized.startsWith('/') ||
    /^[a-zA-Z]:/.test(normalized) ||
    segments.includes('..')
  ) {
    throw new Error(`Node.js ZIP 包含不安全路径：${entryName}`)
  }
  const destination = path.resolve(destinationRoot, ...segments)
  const root = path.resolve(destinationRoot)
  if (destination !== root && !destination.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Node.js ZIP 路径越界：${entryName}`)
  }
  return { destination, normalized }
}

function openZip(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, decodeStrings: true }, (error, zipFile) => {
      if (error) reject(error)
      else resolve(zipFile)
    })
  })
}

function openZipEntryStream(zipFile, entry) {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) reject(error)
      else resolve(stream)
    })
  })
}

async function extractZipSafely(zipPath, destinationRoot) {
  const zipFile = await openZip(zipPath)
  return new Promise((resolve, reject) => {
    let settled = false
    let entries = 0
    let totalBytes = 0
    const fail = (error) => {
      if (settled) return
      settled = true
      zipFile.close()
      reject(error)
    }

    zipFile.once('error', fail)
    zipFile.once('end', () => {
      if (!settled) {
        settled = true
        resolve()
      }
    })
    zipFile.on('entry', (entry) => {
      void (async () => {
        const { destination, normalized } = validateZipEntry(entry.fileName, destinationRoot)
        const unixType = (entry.externalFileAttributes >>> 16) & 0xf000
        if (unixType === 0xa000) {
          throw new Error(`Node.js ZIP 包含不允许的符号链接：${entry.fileName}`)
        }
        // 用中央目录声明的解压后大小做预算：解压炸弹在写盘之前就被拒绝。
        const size = Number(entry.uncompressedSize ?? 0)
        if (size > MAX_ENTRY_BYTES) {
          throw new Error(`Node.js ZIP 条目超出解压上限：${entry.fileName}`)
        }
        entries += 1
        totalBytes += size
        assertArchiveBudget(entries, totalBytes)

        if (normalized.endsWith('/')) {
          await mkdir(destination, { recursive: true })
        } else {
          await mkdir(path.dirname(destination), { recursive: true })
          const input = await openZipEntryStream(zipFile, entry)
          await pipeline(input, createWriteStream(destination, { flags: 'wx' }))
        }
        zipFile.readEntry()
      })().catch(fail)
    })
    zipFile.readEntry()
  })
}

export async function assertManagedRuntime(runtimeDir, platform = process.platform) {
  const nodePath =
    platform === 'win32'
      ? path.join(runtimeDir, 'node.exe')
      : path.join(runtimeDir, 'bin', 'node')
  const npxCliPath = path.join(runtimeDir, managedNpxCliRelativePath(platform))
  if (!(await fileExists(nodePath)) || !(await fileExists(npxCliPath))) {
    throw new Error('下载的 Node.js 运行时不完整。')
  }
  if (platform !== 'win32') {
    // fs.chmod does not follow symbolic links on macOS and throws EPERM, so
    // only adjust permissions on regular files. A symlinked runtime keeps the
    // permissions of its target and must not be treated as damaged.
    const metadata = await lstat(nodePath)
    if (!metadata.isSymbolicLink()) await chmod(nodePath, 0o755)
  }
  const version = await commandOutput(nodePath, ['--version'])
  if (!isCompatibleNodeVersion(version)) {
    throw new Error(`下载的 Node.js 版本不兼容：${version || '未知版本'}`)
  }
  return {
    source: 'managed',
    version: semver.clean(version),
    nodePath,
    npxCliPath,
  }
}

export async function findInstalledManagedNode({
  runtimeRoot,
  platform = process.platform,
  arch = process.arch,
}) {
  const installDir = managedNodeInstallDirectory(runtimeRoot, platform, arch)
  if (!(await fileExists(installDir))) return null

  try {
    return await assertManagedRuntime(installDir, platform)
  } catch {
    await rm(installDir, { recursive: true, force: true })
    return null
  }
}
