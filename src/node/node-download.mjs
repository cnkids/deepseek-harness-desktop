import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { stripTrailingSlashes } from '../dsh-registry.mjs'
import { isAllowedRegistryUrl } from '../registry-url.mjs'
import {
  NODE_DIST_MIRRORS,
  NODE_DOWNLOAD_TIMEOUT_MS,
} from './node-artifacts.mjs'

const NODE_MIRROR_PROBE_TIMEOUT_MS = 5_000

export async function sha256File(filePath) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(filePath), hash)
  return hash.digest('hex')
}

export async function downloadArchive(
  url,
  destination,
  fetchImpl,
  onProgress,
  timeoutMs = NODE_DOWNLOAD_TIMEOUT_MS,
) {
  const signal = AbortSignal.timeout(timeoutMs)
  let response
  try {
    response = await fetchImpl(url, { redirect: 'follow', signal })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError'
    throw new Error(
      timedOut
        ? `下载 Node.js 超时(超过 ${Math.round(timeoutMs / 60_000)} 分钟),请检查网络后重试。`
        : `下载 Node.js 失败：${reason}`,
    )
  }
  if (!response.ok || !response.body) {
    throw new Error(`下载 Node.js 失败：HTTP ${response.status}`)
  }
  const total = Number(response.headers.get('content-length')) || 0
  let received = 0
  const source = Readable.fromWeb(response.body)
  source.on('data', (chunk) => {
    received += chunk.length
    onProgress?.({ phase: 'download', received, total })
  })
  try {
    await pipeline(source, createWriteStream(destination, { flags: 'wx' }), { signal })
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw new Error(`下载 Node.js 超时(超过 ${Math.round(timeoutMs / 60_000)} 分钟),请检查网络后重试。`)
    }
    throw error
  }
}

export function getNodeDistMirrors(env = process.env) {
  const override = env.DSH_DESKTOP_NODE_MIRROR?.trim()
  const mirrors = [...NODE_DIST_MIRRORS]
  if (!override) return mirrors
  // 镜像决定下载哪个 Node.js 运行时，属于供应链入口：只接受 https（本机 http
  // 私有源例外），否则忽略并回退到内置源。
  const base = stripTrailingSlashes(override)
  if (!isAllowedRegistryUrl(base)) {
    console.warn('[node] 忽略不安全的 DSH_DESKTOP_NODE_MIRROR（仅接受 https，或本机 http 源）')
    return mirrors
  }
  return [base, ...mirrors]
}

// 用体积很小的 SHASUMS256.txt 做探测，避免在不可达的源上白等十分钟下载超时。
export async function resolveNodeDistMirror({
  fetchImpl = globalThis.fetch,
  env = process.env,
  probeTimeoutMs = NODE_MIRROR_PROBE_TIMEOUT_MS,
} = {}) {
  const mirrors = getNodeDistMirrors(env)
  for (const baseUrl of mirrors) {
    try {
      const response = await fetchImpl(`${baseUrl}/SHASUMS256.txt`, {
        method: 'HEAD',
        signal: AbortSignal.timeout(probeTimeoutMs),
      })
      if (response.ok) return baseUrl
    } catch {
      // 该镜像不可达，继续探测下一个。
    }
  }
  // 全部不可达时仍返回首选源，让下载阶段给出更具体的报错。
  return mirrors[0]
}
