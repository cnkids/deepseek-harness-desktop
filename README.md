<h1 align="center">DeepSeek Harness Desktop</h1>

<p align="center">
  <strong>一键在本机启动 DeepSeek Harness</strong><br>
  自动检测或安全准备 Node.js 运行环境，无需配置命令行。
</p>

<p align="center"><sub>社区维护的开源项目，并非 DeepSeek 官方产品。</sub></p>

<p align="center">
  <a href="https://github.com/cnkids/deepseek-harness-desktop/releases/latest"><img src="https://img.shields.io/github/v/release/cnkids/deepseek-harness-desktop?style=flat&amp;label=release&amp;color=4D6BFE" alt="Latest release"></a>
  <a href="https://github.com/cnkids/deepseek-harness-desktop/releases"><img src="https://img.shields.io/github/downloads/cnkids/deepseek-harness-desktop/total?style=flat&amp;label=downloads&amp;color=4D6BFE" alt="Total downloads"></a>
  <a href="https://github.com/cnkids/deepseek-harness-desktop/actions/workflows/release.yml"><img src="https://github.com/cnkids/deepseek-harness-desktop/actions/workflows/release.yml/badge.svg" alt="Build status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2EA44F?style=flat" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-4493F8?style=flat" alt="Supported platforms: macOS, Windows and Linux">
</p>

<p align="center">
  <a href="https://github.com/cnkids/deepseek-harness-desktop/releases/latest">GitHub Releases</a>
</p>

DeepSeek Harness Desktop 是面向 macOS、Windows 和 Linux 的非官方桌面启动器。它将 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的本地 Web UI 带入原生桌面窗口，自动管理运行环境、本地服务和系统托盘。

这个仓库专注于轻量、可靠的启动体验：不修改 Harness 上游源码，不请求管理员权限，不替换电脑上已有的 Node.js。系统 `PATH` 也不会被悄悄改动——只有你点击「修复 dsh 命令（加入 PATH）」时，才会把 `dsh` 所在目录写进**当前用户**的 `PATH`。

## 下载与安装

从 [GitHub Releases](https://github.com/cnkids/deepseek-harness-desktop/releases/latest) 获取安装包和 `SHA256SUMS.txt`。

| 平台 | 系统要求 | 安装包 |
| --- | --- | --- |
| macOS Apple Silicon | macOS 12.0+，`arm64` | DMG / ZIP |
| macOS Intel | macOS 12.0+，`x64` | DMG / ZIP |
| Windows | Windows 10/11，`x64` | NSIS 安装程序 / 便携版 EXE |
| Linux | 常见 `x86_64` 发行版 | AppImage / DEB |

每个 Release 都会附带一份更新清单，可通过[最新版清单](https://github.com/cnkids/deepseek-harness-desktop/releases/latest/download/latest.json)查询版本、文件大小、下载地址与 SHA-256。

安装后的桌面端会自动读取这份清单：启动后检查新版本，并每 6 小时复查一次。发现新版时会在后台下载与校验对应平台的安装包，完成后提示安装；也可以从系统托盘手动检查。Windows 会退出后启动 NSIS 安装程序，Linux AppImage 会原位替换并重启，DEB 与 macOS DMG 会交给系统安装界面处理。被忽略的更新提示会在 48 小时后过期，不会长期屏蔽后续版本。

Windows 还提供文件名带 `-portable-` 的免安装版：双击即可运行，不创建开始菜单项或卸载记录，适合快速试用或放在 U 盘中携带。便携版同样把私有 Node.js 运行时与 Harness 缓存保存在 `%APPDATA%\DeepSeek Harness Desktop`，并沿用同一套桌面端自动更新流程；自动更新始终选择 NSIS 安装程序，不会用便携版覆盖已安装的版本。

> 当前安装包尚未进行 Apple notarization 或 Windows Authenticode 签名，系统可能显示“未知开发者”或类似提示。请确认下载来源，并在安装前核对 SHA-256。

### Windows 运行提示

**问题：弹出“Windows 已保护你的电脑”，无法运行安装程序或便携版。**

解决方案：点击“更多信息”，再点击“仍要运行”。安装包与便携版都未做 Authenticode 代码签名，首次运行必然触发 SmartScreen；请先核对发布页提供的 SHA-256 再放行。


### macOS 安装错误

**问题：“无法打开，因为无法验证开发者。”**

解决方案：将应用拖入“应用程序”文件夹，在 Finder 中按住 `Control` 键点按应用图标，选择“打开”，再在弹窗中确认“打开”。

**问题：“Apple 无法检查其是否包含恶意软件。”**

解决方案：打开“系统设置”→“隐私与安全性”，找到被拦截的应用，选择“仍要打开”，然后在弹窗中再次确认。

**问题：“应用已损坏，无法打开。您应该将它移到废纸篓。”**

解决方案：打开“终端”，执行以下命令移除此应用的隔离属性，然后重新打开应用：

```sh
xattr -dr com.apple.quarantine "/Applications/DeepSeek Harness Desktop.app"
```

## 首次启动

1. 打开 DeepSeek Harness Desktop。
2. 首次启动时，应用检查本机是否存在兼容的 Node.js 与全局安装的 `dsh`。
3. 如果没有，应用下载并校验一份仅供自身使用的私有 Node.js runtime。
4. 使用系统 Node.js 时，应用在用户的 npm 全局环境安装或更新 `@deepseek-ai/dsh`；只有本机没有兼容的 Node.js 时，应用才下载私有 runtime 并把 Harness 装到那里。
5. 健康检查通过后，桌面窗口自动进入 Harness，并保存已验证的启动环境快照。

首次启动需要联网访问 Node.js、npm 与 DeepSeek Harness 相关服务，耗时取决于网络状况。后续启动直接复用上次已验证的 Node.js 与 Harness 路径，仅在缓存失效时重新检测环境；Harness 更新检查结果会短期缓存，避免频繁联网阻塞启动。启动失败时可以在启动页直接重试。

### 国内网络环境

初始化地址默认使用官方源，探测不通时会自动改用国内镜像，无需手动配置：

| 用途 | 官方源 | 自动回退 |
| --- | --- | --- |
| 私有 Node.js 下载 | `nodejs.org/dist` | `cdn.npmmirror.com/binaries/node` |
| `@deepseek-ai/dsh` 查询与安装 | `registry.npmjs.org` | `registry.npmmirror.com` |

探测只用几 KB 的 `SHASUMS256.txt` 做一次 HEAD 请求（5 秒超时），因此无法访问境外地址的机器会很快切换，而不是等到下载超时。镜像内容与官方一致，Node.js 归档仍会通过固定 SHA-256 校验；启动页会显示实际使用的下载来源。

如需指向企业内网或代理，可用环境变量指定（会排在官方源之前优先尝试）：

```sh
# 把尖括号里的地址换成你自己的内网地址
DSH_DESKTOP_NODE_MIRROR=https://<内网镜像域名>/node/v24.12.0 \
DSH_DESKTOP_NPM_REGISTRY=https://<内网 registry 域名> \
npm start
```

`DSH_DESKTOP_NODE_MIRROR` 指向 Node.js 发行目录（不含文件名），`DSH_DESKTOP_NPM_REGISTRY` 指向 npm registry 根地址。

## 主要功能

| 功能 | 说明 |
| --- | --- |
| 一键启动 | 自动运行 `@deepseek-ai/dsh web`，无需手动使用终端 |
| 环境自适应 | 优先使用兼容的系统 Node.js，`dsh` 因此装进你自己的全局 npm 环境；没有兼容的才安装应用私有 runtime |
| 网络自适应 | 初始化默认走官方源，探测不通时自动回退国内镜像，也可用环境变量指定私有源 |
| 安全校验 | 下载的 Node.js 官方归档通过固定 SHA-256 校验后才会安装 |
| 自动同步 | 启动时查询 npm registry（官方源优先，不可达时自动改用国内镜像），并在用户全局环境或应用私有环境中原位更新 DSH |
| 桌面端自动更新 | 通过 Release 里的更新清单自动检查、下载并校验新版安装包，失败不影响当前版本运行；忽略的更新提示会过期，不会屏蔽更新的版本 |
| 本地优先 | Harness 服务绑定 `127.0.0.1`，工作状态与缓存保存在本机 |
| 最小权限 | 页面权限默认拒绝（剪贴板写入除外），窗口只允许导航到本地启动页与当前 Harness，重启通道仅对启动页开放 |
| 启动可视化 | 展示运行环境、版本同步、插件装载和界面就绪四个阶段 |
| 原生体验 | 集成桌面窗口、系统托盘、后台进程管理与失败重试 |
| 多平台发布 | 使用原生 GitHub Actions runner 构建 macOS、Windows 和 Linux 安装包 |

## 工作方式

```text
启动应用
   │
   ├─ 找到兼容的系统 Node.js（^22.19.0 或 >=24.0.0）
   │
   └─ 未找到 → 探测下载源（官方 → 国内镜像）→ 下载 Node.js 24.12.0
              → SHA-256 校验 → 安装到私有目录
   │
   └─ 查询 @deepseek-ai/dsh 最新版本（官方源 → 国内镜像）
   │
   └─ 系统 Node.js → 复用/更新用户全局 dsh
   │  私有 Node.js → 复用/更新私有全局 dsh
   │
   └─ 在 127.0.0.1 的空闲端口启动 Harness
   │
   └─ 健康检查通过 → 加载 Web UI
```

托管 runtime 位于 Electron 的 `userData` 目录。桌面端不会覆盖 `DSH_HOME`：默认与命令行共用 `~/.dsh`，因此通过 `dsh plugin --profile web add ...` 安装的插件会在桌面端下次启动时生效（安装后需要重启应用）；如果启动环境显式设置了 `DSH_HOME`，桌面端会原样继承。

本机没有系统 Node.js 时，`dsh` 只存在于应用私有 runtime 里，不在你自己终端的 `PATH` 上，直接敲 `dsh` 会提示命令不存在。这种情况按下一节自行安装一份兼容的 Node.js，应用就会把 `dsh` 装进你的全局 npm 环境。

### 在自己的终端里使用 dsh

应用**优先使用兼容的系统 Node.js**，并把 `@deepseek-ai/dsh` 装进你自己的 npm 全局环境（Windows 通常是 `%APPDATA%\npm`，POSIX 是 npm 全局前缀下的 `bin`）。本机有兼容的 Node.js 时，`dsh` 就应该能直接在终端里使用。

如果终端里仍提示找不到 `dsh`，通常是下面两种情况之一。

**一、Node.js 版本不在兼容范围内**

范围是 `^22.19.0 || >=24.0.0`，即 22.19.0 及以上的 22.x，或 24.x 及以上。20.x 与 23.x 都不被接受——应用会判定本机没有兼容的 Node.js，转而下载并使用私有 runtime，`dsh` 自然不在你的 `PATH` 上。建议装 24.x LTS。

**二、npm 全局目录不在 `PATH` 上**

dsh 装好了，但那个目录不在 `PATH` 上。应用检测到这种情况时（仅限使用系统 Node.js 时）会：

- 在启动完成后弹一次提示，提供「立即修复」，一键把该目录写进**当前用户**的 `PATH`：Windows 走 `HKCU\Environment` 并用 .NET API 广播（不用会把 `PATH` 截断到 1024 字符的 `setx`）；macOS/Linux 在登录 shell 的 rc 文件里写入一段带标记的 `export PATH`，可重复执行不会重复追加
- 同时在托盘菜单提供一个常驻入口「修复 dsh 命令（加入 PATH）」
- 修复只影响**新开的**终端，已经打开的终端需要重开

也可以手动处理，Windows 上：

```powershell
# 先确认目录里确实有 dsh.cmd
Get-ChildItem "$env:APPDATA\npm" -Filter 'dsh*' | Select-Object -ExpandProperty Name
# 再把它加入当前用户的 PATH
[Environment]::SetEnvironmentVariable('Path',
  ([Environment]::GetEnvironmentVariable('Path','User').TrimEnd(';') + ';' + "$env:APPDATA\npm"), 'User')
```

如果本机 Node.js 版本兼容、应用却仍在用私有 runtime，删掉 `userData/runtime` 后重启应用即可让它重新探测（Windows 上该目录里的 npm 依赖树会超出 `MAX_PATH`，删不掉时见下一段）。

以 Windows 为例：

```bat
:: 1. 安装 Node.js 24.x（官方 MSI；zip 便携版或 nvm4w 需自行确认 PATH）
node -v                        :: 2. 确认版本落在兼容范围内
:: 3. 退出应用，然后删除私有 runtime
rmdir /s /q "%APPDATA%\deepseek-harness-desktop\runtime"
:: 4. 重新打开应用，等首次启动流程走完（它会用系统 Node.js 安装/更新 dsh）
where dsh                      :: 5. 应指向 %APPDATA%\npm\dsh.cmd
dsh plugin --profile web add github:cnkids/dsh-office-toolkit
```

macOS 与 Linux 对应删除：

```sh
rm -rf "$HOME/Library/Application Support/deepseek-harness-desktop/runtime"  # macOS
rm -rf "$HOME/.config/deepseek-harness-desktop/runtime"                       # Linux
```

> 目录名取自 `package.json` 的 `name`（`deepseek-harness-desktop`），不是窗口标题里的 "DeepSeek Harness Desktop"。

Windows 上直接 `rmdir` 可能失败：私有 runtime 里的 npm 依赖树会超出 `MAX_PATH`（260 字符），报“未能找到路径的一部分”或“目录不是空的”。先确认应用已从托盘完全退出，再用下面任一方式删除：

```powershell
# 方式 1：用 Node 删（内部走 \\?\ 长路径 API）
node -e "require('node:fs').rmSync(process.env.APPDATA + '\\deepseek-harness-desktop\\runtime', { recursive: true, force: true, maxRetries: 5 })"
```

```bat
:: 方式 2：robocopy 用空目录镜像过去，再删空壳
mkdir C:\tmp\empty
robocopy C:\tmp\empty "%APPDATA%\deepseek-harness-desktop\runtime" /MIR
rmdir /s /q "%APPDATA%\deepseek-harness-desktop\runtime"
rmdir /s /q C:\tmp\empty
```

```bat
:: 方式 3：\\?\ 前缀绕过路径长度限制
rd /s /q "\\?\%APPDATA%\deepseek-harness-desktop\runtime"
```

也可以完全不删：设置用户环境变量 `DSH_DESKTOP_NODE` 指向系统 `node.exe`，它会同时绕过“私有 runtime 优先”和启动缓存，那个目录留着不影响使用。

`dsh` 与 `node` 的可执行文件位置由 npm 全局前缀决定（Windows 通常是 `%APPDATA%\npm`，官方安装包已把它加入 `PATH`；zip 便携版与 nvm4w 需自行确认）。也可以用 `DSH_DESKTOP_NODE` 指定 Node.js 绝对路径来强制使用系统 Node.js——它同时会绕过“私有 runtime 优先”和启动缓存。如果之后系统 Node.js 被卸载或版本变得不兼容，应用会重新下载并使用私有 runtime，`dsh` 也随之回到私有目录。

打包后的应用以用户的“文档”目录作为默认工作目录；开发模式使用当前项目目录。

关闭窗口时应用会保留在系统托盘。从托盘可以重新显示窗口、在默认浏览器中打开当前 Harness，或完全退出并停止后台进程。

## 本地开发

需要 Node.js 24 和 npm。

```sh
git clone https://github.com/cnkids/deepseek-harness-desktop.git
cd deepseek-harness-desktop
npm ci
npm test
npm run check:environment
npm start
```

启动时可用环境变量覆盖默认行为：

| 变量 | 用途 |
| --- | --- |
| `DSH_DESKTOP_NODE` | 指定用于启动 Harness 的 Node.js 绝对路径 |
| `DSH_DESKTOP_DSH` | 指定 `dsh` 可执行文件路径 |
| `DSH_DESKTOP_NODE_MIRROR` | 覆盖 Node.js 下载源，会排在官方源之前优先尝试 |
| `DSH_DESKTOP_NPM_REGISTRY` | 覆盖 npm registry，会排在官方源之前优先尝试 |

```sh
DSH_DESKTOP_NODE=/absolute/path/to/node npm start
```

完整环境变量说明见[国内网络环境](#国内网络环境)。

常用命令：

| 命令 | 用途 |
| --- | --- |
| `npm start` | 启动 Electron 开发版本 |
| `npm test` | 运行 Node.js 单元测试 |
| `npm run check:environment` | 检查当前平台、Node.js 与 `npx` 环境 |
| `npm run pack` | 生成未封装的应用目录 |
| `npm run dist` | 构建当前平台的安装包 |

CI 会在 macOS、Windows、Linux 三个平台各跑一遍 `npm test`，因此**单元测试不能依赖宿主平台**：涉及平台的断言必须显式传入 `platform`，路径拼接要用 `path.posix` / `path.win32` 指定，不要用会随宿主变化的 `path.join`、`path.sep`。否则会出现"本地全绿、Windows 作业红"的情况。

## 发布

维护者在干净且已同步的 `main` 分支运行：

```sh
npm run release -- 0.3.0
```

脚本会更新版本、运行测试、创建 release commit 和 `v0.3.0` tag，再推送到 GitHub。发布工作流随后在原生 runner 上构建各平台安装包、生成 SHA-256 摘要、写出自动更新清单 `latest.json` 并创建 GitHub Release。

完整配置与发布流程见[发布说明](docs/releasing.md)。

## 版本记录

### 0.2.8

- PATH 提示改成**每个目录只提示一次**：此前只用进程内的标志去重，应用一重启就再弹，用户每次启动都被打扰。现在把已提示过的目录写进 `userData/cache/dsh-path.json`，之后不再弹窗；托盘菜单里的「修复 dsh 命令（加入 PATH）」入口始终保留，随时可点。npm 全局目录发生变化时会重新提示一次。
- 提示文案也说明了"只会出现一次"，避免用户误以为关掉后就没别的入口了。
- 记住「已经修复过」：macOS 等平台把目录写进 shell rc 之后，GUI 应用自身的 `process.env.PATH` 并不会因此改变（launchd 只给系统默认 PATH），此前会每次启动都判定"还没修好"——弹窗不断，而且点完「立即修复」后托盘那一行还会当场消失。现在成功修复过的目录会记入 `userData/cache/dsh-path.json` 的 `appliedFor`；POSIX 下还会直接检查 shell rc 里是否存在含该目录的标记块，两者任一成立即视为已可用。
- 托盘里**常驻一行自述 dsh 状态**（此前只在需要修复时才出现，用户反馈很难找到入口，也无法判断应用当前用哪种 Node.js）：使用系统 Node.js 且目录尚未处理时显示可点的「修复 dsh 命令（加入 PATH）」；已可用时显示置灰的「dsh 命令已可用（用户 Node.js x.y.z）」；仍在用私有 runtime 时显示置灰的「dsh 命令仅在应用内可用（应用私有 Node.js）」。

### 0.2.7

- 修复 0.2.6 的「系统 Node 优先」对**已经跑过应用**的机器不生效：启动缓存会把上次解析出的环境固化下来（很可能就是私有 runtime），`launchHarness` 命中缓存后直接复用，根本不会再走新的探测顺序。现在缓存里是私有 runtime 时会做一次便宜复核——`findCompatibleSystemNode({ loginShell: false })`，跳过登录 shell 探测以免每次启动都付这笔开销——一旦发现兼容的系统 Node.js 就丢弃缓存重新解析。
- 于是"先装了 Node.js 却一直用私有 runtime"的机器升级后首次启动即可切到系统 Node，`dsh` 会装进用户自己的全局 npm 环境，托盘也会出现「修复 dsh 命令（加入 PATH）」（当该目录不在 `PATH` 上时）。

### 0.2.6

- 修复「本机已经装了 Node.js，却依然拿不到 `dsh` 命令」：`resolveNodeEnvironment` 此前只要发现私有 runtime 就无条件复用它，于是先装好 Node.js 的机器仍然把 `dsh` 装进应用私有目录，用户终端里永远看不到。现在改为**优先使用兼容的系统 Node.js**，与 README 一直承诺的「环境自适应」一致；私有 runtime 只在没有兼容系统 Node.js 时兜底。
- 新增 PATH 检测与一键修复：使用系统 Node.js 且 npm 全局目录不在 `PATH` 上时，启动完成后弹一次提示，并可从该提示或托盘菜单「修复 dsh 命令（加入 PATH）」把目录写入当前用户 PATH。Windows 走 `HKCU\Environment` 并用 .NET API 广播（不用会截断 `PATH` 的 `setx`）；macOS/Linux 写入登录 shell rc 的标记块，重复执行不会重复追加。修复只影响新开的终端。
- 该修复只在系统 Node.js 场景下提供：私有 runtime 目录里同时含 `node` 与 `npm`，把它加进用户 PATH 等于顺手给用户装一套 Node.js，代价不可接受。
- 品牌与链接清理：README 移除指向原始作者站点的产品页、AI 安装文档与预览图，以及另一个社区桌面端项目的外链；无法访问的示例占位链接改为纯占位文本。`package.json` 的 `author.name` 与 `build.appId`、`src/main.mjs` 的 `setAppUserModelId`、`LICENSE` 版权署名统一为 `cnkids`。
  注意：`appId` 由 `com.atlankj.deepseekharnessdesktop` 改为 `com.cnkids.deepseekharnessdesktop`，应用身份随之变化——Windows 上旧的卸载记录不会被新安装包接管（会多出一条），macOS 的 bundle id 也变了；用户数据目录不受影响（它取自 `name`）。

### 0.2.5

- 移除托盘菜单里的「打开 Harness 命令行（安装插件）」入口及其实现（`src/harness-console.mjs`、对应单元测试与主进程接线）：不再由应用代开终端，`dsh` 命令改为在用户自行安装 Node.js 后于自己的终端里使用。
- 修正 README 里私有 runtime 的目录名：实际是 `deepseek-harness-desktop`（取自 `package.json` 的 `name`），此前误写成窗口标题 “DeepSeek Harness Desktop”。
- README 补充 Windows 删除私有 runtime 时长路径（`MAX_PATH` 260 字符）失败的处理方式：Node `fs.rmSync`、robocopy 空目录镜像、`\\?\` 前缀三种做法，以及用 `DSH_DESKTOP_NODE` 完全不删的替代路线。

### 0.2.4

- 撤回 0.2.3 在 Harness 页面里注入的「命令行」按钮：这个入口更适合用文档与托盘菜单承载，托盘菜单里的「打开 Harness 命令行（安装插件）」保留不变。
- README 新增「在自己的终端里使用 dsh」章节：写清兼容的 Node.js 版本范围（`^22.19.0 || >=24.0.0`）、应用“优先复用已有私有 runtime”的探测顺序会导致装了 Node.js 也不生效，以及删除 `userData/runtime` 后重启用系统 Node.js 的完整步骤（含 Windows 命令与 `DSH_DESKTOP_NODE` 覆盖方式）。

### 0.2.3

- Harness 页面右下角新增「命令行」按钮，点一下就能打开已注入私有 Node.js 与全局 `dsh` 的终端，不用再去托盘菜单里找入口（托盘菜单的同名项保留）。该按钮已在 0.2.4 撤回，入口改由文档与托盘菜单承载。
- 按钮由 preload 注入到 Harness 页面：IPC 通道不经 `contextBridge` 暴露、只接受真实用户点击（拒绝 `element.click()` 这类合成事件），主进程另校验发送方是窗口顶层框架且仍在当前 Harness origin 内，避免第三方页面代码自行拉起终端。
- 启动页（`file://`）不显示该按钮。

### 0.2.2

- 托盘菜单新增「打开 Harness 命令行（安装插件）」：打开一个已把应用私有 Node.js 与全局 `dsh` 目录前置进 `PATH` 的终端窗口，在没有系统 Node.js 的机器（尤其是 Windows）上也能直接执行 `dsh plugin --profile web add ...`。不改写系统 `PATH`，窗口独立于应用生命周期；macOS 与 Linux 会生成一个启动脚本再交给系统终端执行。
- 修正 README 里“通过命令行安装的插件会生效”的说法：该路径此前只在本机已装 Node.js、`dsh` 已经在 `PATH` 上时才成立。
- 启动页粒子缩放改用与粒子散布相同的 `crypto.getRandomValues` 随机源，消除 SonarQube S2245 安全热点。

### 0.2.1

- 应用内自动更新改用 GitHub Releases 作为更新源：更新清单 `latest.json` 随 Release 一起发布，客户端读取固定地址 `https://github.com/cnkids/deepseek-harness-desktop/releases/latest/download/latest.json`，不再依赖 Cloudflare R2 与额外的仓库密钥。
- 发布工作流在创建 Release 时生成并上传更新清单，原先需要 R2 凭据才会执行的镜像作业已移除。
- 注意：已经安装 0.2.0 及更早版本的客户端内置的是旧 R2 清单地址，需要手动下载安装包升级一次，之后的自动更新才会走新地址；由于清单与安装包都由 GitHub 提供，网络受限环境下检查与下载可能需要代理。

### 0.2.0

- 初始化支持国内网络环境：私有 Node.js 下载与 `dsh` 安装会在官方源不可达时自动回退到国内镜像，无需手动配置；也可用 `DSH_DESKTOP_NODE_MIRROR`、`DSH_DESKTOP_NPM_REGISTRY` 指定企业内网或代理。
- 启动页会显示 Node.js 的下载来源（官方源 / 国内镜像）。
- 补齐软件源回退、镜像探测与 npm 全局安装路径的单元测试，项目整体覆盖率提升到 83%。

### 0.1.11

- 补齐单元测试：npm 全局安装位置探测、`dsh` 全局安装检查与启动页预览分支，项目整体覆盖率由 74% 提升到 81%（SonarQube 侧 81.3%）。
- 仓库不再包含本地 SonarQube 扫描配置，`sonar-project.properties` 仅保留在开发者本机。

### 0.1.10

- 启动失败时把 `dsh` 子进程真正报出的错误（插件未解析、端口占用、权限不足等）显示在启动页，不再只提示“进程意外退出（代码 1）”。

### 0.1.9

- 修复主进程顶层 `await app.whenReady()` 造成的启动死锁：进程会驻留却永不显示窗口，双击应用表现为“没有反应”，macOS 与 Windows 包都受影响。
- 修复 Windows 退出后残留 `dsh` 子进程：改用 `taskkill /T` 结束整棵进程树。
- 修复便携版被自动更新成 NSIS 安装版：便携版现在只提示手动下载新文件。
- 修复 Linux 桌面端自动更新始终找不到安装包：按 `x64/arm64` 匹配真实产物名。
- 启动页进度条改用原生 `<progress>` 元素，保留原有视觉并改善可访问性；启动页脚本统一使用 `globalThis`。
- 补齐启动守卫、加载页状态机与像素采样的单元测试，SonarQube 存量问题清零（新代码覆盖率门槛 ≥80%，当前约 90%）。

## 项目关系

- [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)：提供核心 Agent、插件系统和 Web UI；本项目通过公开的 npm 包运行它。
- 本仓库是独立实现的轻量启动器，与 DeepSeek Harness 项目不存在隶属或背书关系。

## 安全与许可证

请勿在公开 Issue 中提交 token、密码、私有文件或其他敏感信息。安全问题请按 [Security Policy](SECURITY.md) 使用 GitHub 私密漏洞报告。

本项目基于 [MIT License](LICENSE) 开源。

> DeepSeek 是 DeepSeek AI 的商标。DeepSeek Harness Desktop 是独立的社区项目，并非 DeepSeek 官方产品，也未获得其背书。
