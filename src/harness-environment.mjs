import net from 'node:net'
import path from 'node:path'
import { stat } from 'node:fs/promises'
import { findCompatibleSystemNode } from './node-runtime.mjs'
import { readStartupCache } from './startup-cache.mjs'

// 本地运行环境准备：本地端口、工作目录、启动缓存复核，以及 Node.js 安装进度
// 到启动页的翻译。这些都是"启动 Harness 之前"的环境问题，与 Harness 进程本身无关。

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function createNodeProgressReporter(reportStatus) {
  return function reportNodeProgress(event) {
    switch (event.phase) {
      case 'download-start':
        reportStatus({
          message: '正在安装私有 Node.js',
          detail:
            event.source === 'mirror'
              ? `通过国内镜像下载 ${event.file}`
              : `准备下载 ${event.file}`,
          progress: 0,
        })
        break
      case 'download': {
        const progress = event.total ? Math.round((event.received / event.total) * 100) : null
        const total = event.total ? ` / ${formatBytes(event.total)}` : ''
        reportStatus({
          message: '正在下载私有 Node.js',
          detail: `${formatBytes(event.received)}${total}`,
          progress,
        })
        break
      }
      case 'verify':
        reportStatus({ message: '正在校验 Node.js', detail: '验证官方安装包的 SHA-256', progress: 100 })
        break
      case 'extract':
        reportStatus({ message: '正在安装私有 Node.js', detail: '正在解压应用私有运行时', progress: null })
        break
      default:
        break
    }
  }
}

export async function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : null
      server.close((error) => {
        if (error) reject(error)
        else if (port) resolve(port)
        else reject(new Error('无法分配本地端口。'))
      })
    })
  })
}

// 打包后默认在用户的“文档”目录中运行 Harness。OneDrive 重定向、目录被删除
// 或组策略移除都会让 app.getPath 指向不存在的位置，导致 spawn 以 ENOENT
// 直接失败，因此依次回退到主目录与应用数据目录。
export async function resolveWorkspacePath(app) {
  const candidates = app.isPackaged ? ['documents', 'home', 'userData'] : []
  for (const name of candidates) {
    try {
      const directory = app.getPath(name)
      if ((await stat(directory)).isDirectory()) return directory
    } catch {
      // 该候选目录不可用，继续尝试下一个。
    }
  }
  return process.cwd()
}

// 读取启动缓存，并在缓存锁定私有 runtime 时做一次便宜复核：用户可能在本机还
// 没有 Node.js 时装过应用，后来又装了兼容的系统 Node.js，那就必须改用系统
// Node——否则 dsh 永远留在私有 runtime 里，用户的终端里拿不到 dsh 命令。
// 复核跳过登录 shell 探测，避免每次启动都付出拉起登录 shell 的开销。
export async function readUsableStartupCache(startupCachePath, shouldUseStartupCache) {
  if (!shouldUseStartupCache) return null
  const startupCache = await readStartupCache(startupCachePath)
  if (startupCache?.nodeEnvironment.source === 'managed') {
    const systemNode = await findCompatibleSystemNode({
      platform: process.platform,
      loginShell: false,
    })
    if (systemNode) return null
  }
  return startupCache
}

export function startupCachePath(userDataPath) {
  return path.join(userDataPath, 'cache', 'startup.json')
}
