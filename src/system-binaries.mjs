import path from 'node:path'

// Windows 系统工具一律用绝对路径调用：PATH 上可能被前置了同名程序，用相对名等于
// 把"结束进程树""查找命令位置"这类能力交给 PATH 里任意一个可执行文件。
// 取不到 SystemRoot（极少数精简环境）时退回原名，行为与之前一致。
export function windowsSystemBinary(name, env = process.env) {
  const root = env.SystemRoot ?? env.windir
  // 只接受绝对路径：SystemRoot 若被改成相对路径，join 出来的命令会从当前工作
  // 目录（打包后是用户的"文档"）解析，等于把执行权交给那里的同名文件。
  if (!root || !path.win32.isAbsolute(root)) return `${name}.exe`
  // 用 win32.join：这个函数只服务于 Windows，路径分隔符不应随宿主平台变化。
  return path.win32.join(root, 'System32', `${name}.exe`)
}
