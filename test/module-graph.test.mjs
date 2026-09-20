import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// 拆分模块后最容易出的错是"导入名和实际导出不匹配"：这种错误在 Node 单元测试里
// 抓不到（Electron 主进程模块无法直接 import），只有真正启动应用才会炸。这里静态
// 扫描相对导入，逐一核对目标文件确实导出过该名字，把这类错拦在提交前。

const SRC_ROOT = fileURLToPath(new URL('../src', import.meta.url))

async function listMjsFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await listMjsFiles(fullPath)))
    else if (entry.name.endsWith('.mjs')) files.push(fullPath)
  }
  return files
}

function exportedNames(source) {
  const names = new Set()
  const declarations = [
    /export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g,
    /export\s+const\s+([A-Za-z0-9_$]+)/g,
    /export\s+let\s+([A-Za-z0-9_$]+)/g,
    /export\s+class\s+([A-Za-z0-9_$]+)/g,
  ]
  for (const pattern of declarations) {
    for (const match of source.matchAll(pattern)) names.add(match[1])
  }
  for (const match of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const clause of match[1].split(',')) {
      const trimmed = clause.trim()
      if (!trimmed) continue
      const [, alias] = trimmed.split(/\s+as\s+/)
      names.add((alias ?? trimmed).trim())
    }
  }
  if (/export\s+default/.test(source)) names.add('default')
  return names
}

function relativeImports(source) {
  const imports = []
  for (const match of source.matchAll(/import\s+([^'"]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
    const clause = match[1].trim()
    const specifier = match[2]
    if (!specifier.startsWith('.')) continue
    const named = clause.match(/\{([^}]*)\}/)
    const names = named
      ? named[1]
          .split(',')
          .map((piece) => piece.trim().split(/\s+as\s+/)[0].trim())
          .filter(Boolean)
      : []
    imports.push({ specifier, names })
  }
  return imports
}

test('every relative import points at a real export', async () => {
  const files = await listMjsFiles(SRC_ROOT)
  const sources = new Map()
  for (const file of files) sources.set(file, await readFile(file, 'utf8'))

  for (const [file, source] of sources) {
    for (const { specifier, names } of relativeImports(source)) {
      const target = path.resolve(path.dirname(file), specifier)
      assert.equal(
        sources.has(target),
        true,
        `${path.relative(SRC_ROOT, file)} 导入了不存在的模块 ${specifier}`,
      )
      const available = exportedNames(sources.get(target))
      for (const name of names) {
        assert.equal(
          available.has(name),
          true,
          `${path.relative(SRC_ROOT, file)} 从 ${specifier} 导入了未导出的 ${name}`,
        )
      }
    }
  }
})
