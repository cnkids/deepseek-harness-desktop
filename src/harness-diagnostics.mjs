// dsh web 启动失败时，真正的错误常常夹在源码片段与堆栈之间。启动页原先只
// 能看到“进程意外退出（代码 1）”，这里从子进程输出里筛出可读的错误行，
// 让插件缺失、端口占用、权限不足这类问题可以直接显示在界面上。

const ERROR_HINT_PATTERN =
  /(\berror\b|\berr!|enoent|eacces|eaddrinuse|\bfailed\b|\bfatal\b|cannot|错误|失败|无法)/i

export function summarizeHarnessFailure(lines, { maxLines = 3, maxLength = 400 } = {}) {
  const cleaned = lines.map((line) => String(line).trim()).filter(Boolean)
  if (cleaned.length === 0) return ''

  // 优先展示真正的错误行；一条都匹配不到时退回最后几行，至少给出结尾现场。
  const hints = cleaned.filter((line) => ERROR_HINT_PATTERN.test(line))
  const picked = (hints.length > 0 ? hints : cleaned.slice(-maxLines)).slice(0, maxLines)
  const summary = picked.join('\n')
  return summary.length > maxLength ? `${summary.slice(0, maxLength)}…` : summary
}
