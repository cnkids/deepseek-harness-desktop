import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { deflateRawSync, gzipSync } from 'node:zlib'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { extractArchive } from '../src/node/node-extract.mjs'

// 私有 Node.js runtime 的解压路径：Windows 用 zip、macOS/Linux 用 tar.gz。
// 这里用极简的归档写入器造出小样本，覆盖"正常解压"与"危险条目被拒绝"两条路径。

function createTarEntry(name, content, declaredSize = null) {
  const data = Buffer.from(content ?? '')
  const size = declaredSize ?? data.length
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write('0000644\0', 100, 8, 'ascii')
  header.write('0000000\0', 108, 8, 'ascii')
  header.write('0000000\0', 116, 8, 'ascii')
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii')
  header.write('00000000000\0', 136, 12, 'ascii')
  header.write('        ', 148, 8, 'ascii')
  header.write('0', 156, 1, 'ascii')
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  let checksum = 0
  for (const byte of header) checksum += byte
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)])
}

function createTarGz(entries) {
  const parts = entries.map((entry) => createTarEntry(entry.name, entry.content))
  parts.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(parts))
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

// 只写"存储"（不压缩）的 ZIP：yauzl 能正常读取，够用来驱动解压逻辑。
function createZip(entries) {
  const locals = []
  const centralDirectory = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const content = Buffer.from(entry.content ?? '')
    const crc = crc32(content)
    // deflate=true 时用真正的压缩流：这样"压缩后大小 ≠ 解压后大小"才是合法结构
    // （存储型条目的这两个值必须相等，yauzl 会在解析阶段就拒绝）。
    const method = entry.deflate ? 8 : 0
    const payload = entry.deflate ? deflateRawSync(content) : content
    const uncompressedSize = entry.declaredSize ?? content.length
    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(uncompressedSize, 22)
    local.writeUInt16LE(name.length, 26)
    name.copy(local, 30)

    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(payload.length, 20)
    // 中央目录声明的"解压后大小"允许与实际内容不同，用来模拟解压炸弹。
    central.writeUInt32LE(uncompressedSize, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(entry.unixMode ?? 0, 38)
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)

    locals.push(local, payload)
    centralDirectory.push(central)
    offset += local.length + payload.length
  }

  const directory = Buffer.concat(centralDirectory)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

async function withTempDir(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'node-extract-'))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('extracts a tar.gz private runtime and strips the top-level directory', async () => {
  await withTempDir(async (root) => {
    const archivePath = path.join(root, 'node-v24.12.0-darwin-arm64.tar.gz')
    await writeFile(
      archivePath,
      createTarGz([
        { name: 'node-v24.12.0-darwin-arm64/bin/node', content: 'fake node binary' },
        {
          name: 'node-v24.12.0-darwin-arm64/lib/node_modules/npm/bin/npx-cli.js',
          content: '// fake npx',
        },
      ]),
    )

    const extractDir = path.join(root, 'extracted')
    const result = await extractArchive(
      { archive: 'tar.gz', file: 'node-v24.12.0-darwin-arm64.tar.gz' },
      archivePath,
      extractDir,
    )

    assert.equal(result, extractDir)
    assert.equal(await readFile(path.join(result, 'bin', 'node'), 'utf8'), 'fake node binary')
    assert.equal(
      await readFile(path.join(result, 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'), 'utf8'),
      '// fake npx',
    )
  })
})

test('aborts the tar.gz install when the archive contains unsafe paths', async () => {
  await withTempDir(async (root) => {
    const archivePath = path.join(root, 'tampered.tar.gz')
    await writeFile(
      archivePath,
      createTarGz([
        { name: 'node-v24.12.0-darwin-arm64/bin/node', content: 'real' },
        { name: '../escape.txt', content: 'should never be written' },
      ]),
    )

    await assert.rejects(
      extractArchive(
        { archive: 'tar.gz', file: 'tampered.tar.gz' },
        archivePath,
        path.join(root, 'extracted'),
      ),
      /不安全条目/,
    )
  })
})

test('extracts a Windows zip private runtime', async () => {
  await withTempDir(async (root) => {
    const archivePath = path.join(root, 'node-v24.12.0-win-x64.zip')
    await writeFile(
      archivePath,
      createZip([
        { name: 'node-v24.12.0-win-x64/', content: '' },
        { name: 'node-v24.12.0-win-x64/node.exe', content: 'fake node exe' },
        { name: 'node-v24.12.0-win-x64/npm/bin/npx-cli.js', content: '// fake npx' },
      ]),
    )

    const extractDir = path.join(root, 'extracted')
    const result = await extractArchive(
      { archive: 'zip', file: 'node-v24.12.0-win-x64.zip' },
      archivePath,
      extractDir,
    )

    assert.equal(result, path.join(extractDir, 'node-v24.12.0-win-x64'))
    assert.equal(await readFile(path.join(result, 'node.exe'), 'utf8'), 'fake node exe')
  })
})

test('rejects a zip that hides a symlink entry', async () => {
  await withTempDir(async (root) => {
    const archivePath = path.join(root, 'symlink.zip')
    // externalFileAttributes 高 16 位是 Unix 模式：0xa000 表示符号链接。
    await writeFile(
      archivePath,
      createZip([
        { name: 'node-v24.12.0-win-x64/node.exe', content: 'fake' },
        { name: 'node-v24.12.0-win-x64/link', content: '/etc/passwd', unixMode: 0xa1ff0000 },
      ]),
    )

    await assert.rejects(
      extractArchive(
        { archive: 'zip', file: 'symlink.zip' },
        archivePath,
        path.join(root, 'extracted'),
      ),
      /符号链接/,
    )
  })
})

// 安全守卫：解压炸弹在写盘之前就要被拒绝（SonarQube S5042 的缓解措施）。
test('rejects a zip entry whose declared size exceeds the extraction budget', async () => {
  await withTempDir(async (root) => {
    const archivePath = path.join(root, 'bomb.zip')
    await writeFile(
      archivePath,
      createZip([
        {
          name: 'node-v24.12.0-win-x64/node.exe',
          content: 'small',
          deflate: true,
          declaredSize: 512 * 1024 * 1024,
        },
      ]),
    )

    await assert.rejects(
      extractArchive(
        { archive: 'zip', file: 'bomb.zip' },
        archivePath,
        path.join(root, 'extracted'),
      ),
      /超出解压上限/,
    )
  })
})

test('rejects a tar entry whose declared size exceeds the extraction budget', async () => {
  await withTempDir(async (root) => {
    const archivePath = path.join(root, 'bomb.tar.gz')
    // 头部声明的条目大小远超上限：过滤器必须在读取数据之前拦下它。
    const entry = createTarEntry('node-v24.12.0-darwin-arm64/bin/node', 'x', 512 * 1024 * 1024)
    await writeFile(archivePath, gzipSync(Buffer.concat([entry, Buffer.alloc(1024)])))

    // 归档既可能被解压预算拒绝，也可能因为声明的数据长度与实际不符被 tar 自己拒绝，
    // 两条路径都必须以失败告终，绝不能把超限条目写进磁盘。
    await assert.rejects(
      extractArchive(
        { archive: 'tar.gz', file: 'bomb.tar.gz' },
        archivePath,
        path.join(root, 'extracted'),
      ),
    )
  })
})
