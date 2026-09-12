// dsh 版本查询与 npm 软件源回退。
//
// 默认使用 npm 官方源；无法访问境外地址的机器会依次回退到国内镜像，
// 也可以用 DSH_DESKTOP_NPM_REGISTRY 指定私有源（企业内网 / 代理）。

export const DSH_METADATA_PATH = '@deepseek-ai%2fdsh/latest'

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
      if (!manifest || typeof manifest.version !== 'string') {
        throw new Error('软件源返回的版本信息无效')
      }
      return { version: manifest.version, registry: registry.base }
    } catch (error) {
      lastError = error
    }
  }

  throw lastError ?? new Error('没有可用的 dsh 软件源。')
}
