// 日志与界面脱敏。应用会把 dsh 的原始输出转发到控制台，并在失败时把子进程输出
// 显示到启动页/对话框，其中可能夹带两类秘密：
//   1. 本地 Harness 的访问令牌（dsh web 在 stdout 打印的 `?token=...`）；
//   2. 私有软件源 URL 里的账号密码（`https://user:pass@npm.internal/...`）。
// 这里统一做"保留结构、去掉秘密"的处理。刻意不用正则：SonarQube 把使用正则标为
// 安全热点（S4784），而这里只是两次线性扫描。

const TOKEN_MARKER = 'token='
const TOKEN_STOP_CHARS = new Set([' ', '\t', '\n', '\r', '&', '"', "'", '<', '>'])
const AUTHORITY_STOP_CHARS = new Set([
  '/',
  ' ',
  '\t',
  '\n',
  '\r',
  '"',
  "'",
  '<',
  '>',
  ')',
  ']',
  '}',
  ',',
])

function isStopChar(char, stopChars) {
  return char === undefined || stopChars.has(char)
}

// `dsh web: http://127.0.0.1:1234/?token=AbC-123` → `...?token=***`
export function stripLaunchToken(value) {
  const text = String(value ?? '')
  let result = ''
  let cursor = 0
  while (true) {
    const markerIndex = text.indexOf(TOKEN_MARKER, cursor)
    if (markerIndex === -1) break
    const valueStart = markerIndex + TOKEN_MARKER.length
    let valueEnd = valueStart
    while (!isStopChar(text[valueEnd], TOKEN_STOP_CHARS)) valueEnd += 1
    result += `${text.slice(cursor, valueStart)}***`
    cursor = valueEnd
  }
  return result + text.slice(cursor)
}

// `https://alice:s3cret@npm.internal/@deepseek-ai%2fdsh/latest`
//   → `https://npm.internal/@deepseek-ai%2fdsh/latest`
// 判断 `://` 前面是否是一个像样的协议名（`https`/`npm`…）。单个字母（如 Windows 的
// `C://`）不算，避免把盘符路径里的 `@` 当成凭据删掉。
function hasSchemeName(text, schemeEnd) {
  let start = schemeEnd
  while (start > 0 && /[A-Za-z0-9+.-]/.test(text[start - 1])) start -= 1
  return schemeEnd - start >= 2
}

export function stripUrlCredentials(value) {
  const text = String(value ?? '')
  let result = ''
  let cursor = 0
  while (true) {
    const schemeIndex = text.indexOf('://', cursor)
    if (schemeIndex === -1) break
    if (!hasSchemeName(text, schemeIndex)) {
      result += text.slice(cursor, schemeIndex + 3)
      cursor = schemeIndex + 3
      continue
    }
    const authorityStart = schemeIndex + 3
    let authorityEnd = authorityStart
    while (!isStopChar(text[authorityEnd], AUTHORITY_STOP_CHARS)) authorityEnd += 1
    const atIndex = text.lastIndexOf('@', authorityEnd)
    result +=
      atIndex > authorityStart
        ? `${text.slice(cursor, authorityStart)}${text.slice(atIndex + 1, authorityEnd)}`
        : text.slice(cursor, authorityEnd)
    cursor = authorityEnd
  }
  return result + text.slice(cursor)
}

// 出错信息可能把软件源 URL（含凭据）原样带出来，展示或落日志前统一脱敏。
function errorMessage(error) {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error ?? '')
}

export function describeError(error) {
  return stripUrlCredentials(stripLaunchToken(errorMessage(error)))
}
