// 软件源 URL 的安全判定与展示。
//
// dsh 包（npm 源）与 Node.js 运行时（下载镜像）都允许通过环境变量指定自定义源，
// 而"源"决定装的是哪个包、哪个运行时，属于供应链入口，因此统一在这里做两件事：
// 协议校验（只信加密传输，本机 http 例外）与凭据脱敏（日志/界面只显示主机名）。

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

export function isAllowedRegistryUrl(value) {
  try {
    const url = new URL(value)
    if (url.protocol === 'https:') return true
    return url.protocol === 'http:' && LOCAL_HOSTNAMES.has(url.hostname)
  } catch {
    return false
  }
}

export function registryDisplayName(base) {
  try {
    return new URL(base).host
  } catch {
    return '未知软件源'
  }
}
