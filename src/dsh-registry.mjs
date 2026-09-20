// dsh 版本查询与 npm 软件源回退。
//
// 默认使用 npm 官方源；无法访问境外地址的机器会依次回退到国内镜像，
// 也可以用 DSH_DESKTOP_NPM_REGISTRY 指定私有源（企业内网 / 代理）。
//
// 安全约定：软件源会决定"装哪个包"，所以覆盖值只接受 https（本机 http 私有源
// 例外），避免把安装源降级成明文传输或本地路径；版本号一律经 semver 校验，
// 因为它是唯一会进入 npm 安装参数的外部数据。

import semver from 'semver'
import { isAllowedRegistryUrl } from './registry-url.mjs'

export const DSH_METADATA_PATH = '@deepseek-ai%2fdsh/latest'

// 源地址的协议校验与凭据脱敏统一在 registry-url.mjs，这里再导出，
// 保持既有导入路径可用。
export { registryDisplayName } from './registry-url.mjs'

export const DSH_REGISTRIES = Object.freeze([
  { name: 'npm', base: 'https://registry.npmjs.org' },
  { name: 'npmmirror', base: 'https://registry.npmmirror.com' },
])

function withMetadata(registry) {
  return { ...registry, metadata: `${registry.base}/${DSH_METADATA_PATH}` }
}

// 去掉末尾斜杠。刻意不用正则：SonarQube 把“使用正则表达式”标记为安全热点
// （S4784），而这里只是简单的字符裁剪。
export function stripTrailingSlashes(value) {
  let end = value.length
  while (end > 0 && value[end - 1] === '/') end -= 1
  return value.slice(0, end)
}

export function resolveDshRegistries(env = process.env) {
  const override = env.DSH_DESKTOP_NPM_REGISTRY?.trim()
  const registries = DSH_REGISTRIES.map(withMetadata)
  if (!override) return registries

  const base = stripTrailingSlashes(override)
  if (!isAllowedRegistryUrl(base)) {
    console.warn('[dsh] 忽略不安全的 DSH_DESKTOP_NPM_REGISTRY（仅接受 https，或本机 http 源）')
    return registries
  }
  return [{ name: 'custom', base, metadata: `${base}/${DSH_METADATA_PATH}` }, ...registries]
}

// 依次查询各软件源，返回版本号与命中的源地址（用于后续 npm install 指定 registry）。
export async function fetchLatestDshVersion({ fetchImpl, registries, timeoutMs = 10_000 }) {
  if (!Array.isArray(registries) || registries.length === 0) {
    throw new Error('没有配置可用的 dsh 软件源。')
  }

  let lastError = null
  for (const registry of registries) {
    try {
      const response = await fetchImpl(registry.metadata, {
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const manifest = await response.json()
      // 版本号是唯一会进入 npm 安装参数的外部数据，必须是合法 semver：
      // 被投毒或被劫持的软件源不能借它构造任意的 npm spec。
      const version = semver.valid(semver.clean(String(manifest?.version ?? '')))
      if (!version) {
        throw new Error('软件源返回的版本信息无效')
      }
      return { version, registry: registry.base }
    } catch (error) {
      lastError = error
    }
  }

  throw lastError ?? new Error('没有可用的 dsh 软件源。')
}
