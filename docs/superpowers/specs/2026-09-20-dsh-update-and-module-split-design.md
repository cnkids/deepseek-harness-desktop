# dsh（Harness）更新检测提示 + 全仓模块拆分设计

日期：2026-09-20　版本：0.2.8 → 0.3.0

## 1. 背景与问题

- Harness 包 `@deepseek-ai/dsh` 目前只在启动时静默更新：查到新版本就直接执行
  `npm install -g @deepseek-ai/dsh@latest`，用户既不知道在装什么、也看不到进度。
- 应用长时间不重启时（本项目的典型使用方式：桌面端常驻），**完全不会发现 dsh 有新版本，
  也没有任何手动更新入口**。
- 桌面端自身的自动更新（GitHub Releases 清单 + SHA-256 校验 + 弹窗）已经是完整链路，本次不动。

## 2. 功能设计

核心原则：**每个版本只主动提示一次**（跨「启动时」与「运行中」，落盘记忆），
托盘入口任何时候都可用——避免每次启动都弹窗骚扰。

落盘：`userData/cache/dsh-update-notice.json` → `{ notifiedVersion, notifiedAt }`。
该文件只影响「是否弹窗」，绝不影响「运行哪个版本」。

### 2.1 启动时

| 情况 | 行为 |
| --- | --- |
| 本机没有 dsh（首次安装） | 静默安装（没有旧版本可退），启动页照常显示进度 |
| 有新版且该版本未提示过 | 弹窗一次 `[立即更新] [稍后]`（默认立即更新）；立即 → 启动页显示更新进度；稍后 → 立刻用当前版本启动 |
| 有新版但该版本已提示过 | 不弹窗，启动页提示「发现新版本 vX，可从托盘更新」，用当前版本启动 |
| 已是最新 / 离线 | 行为不变 |

### 2.2 运行中（核心需求）

- 每 6 小时复查一次（复用 `DSH_UPDATE_CHECK_INTERVAL_MS`），托盘亦可手动「检查 Harness 更新」。
- 发现未提示过的版本 → 弹一次窗，明确说明「更新会重启 Harness，当前页面会重新加载」；
  已提示过的版本 → 只更新托盘标签，不再打扰。
- 确认后的执行顺序：**先停 Harness 子进程 → 再 npm install → 装完重启 Harness**
  （先停再装可避免 Windows 下覆盖正在运行的 dsh 文件失败）。
- 失败：保留当前版本继续运行，托盘变「Harness 更新失败，点击重试」并弹窗说明原因。

### 2.3 进度可见性

npm 安装拿不到精确百分比，因此更新阶段显示「正在更新到 vX · 阶段 + 已用时 N 秒」
配合不确定进度动画，保证画面持续变化，不会像卡死。

## 3. 安全设计

1. **供应链/注入**
   - `fetchLatestDshVersion()` 返回的版本号必须经 `semver.valid()/clean()` 校验，非法即跳过该源
     （原先只检查是字符串，该值会拼进 `@deepseek-ai/dsh@<version>`）。
   - npm 调用继续 `execFile` + 参数数组 + `shell: false`；registry 走 `npm_config_registry` 环境变量。
   - `DSH_DESKTOP_NPM_REGISTRY` 只接受 `https:`（额外允许 `http://127.0.0.1|localhost`），否则忽略并告警。
2. **渲染进程信任边界**
   - 更新动作只由主进程驱动（托盘/主进程定时器），**不新增渲染进程 → 主进程的更新 IPC**。
   - dsh Web UI 属于第三方页面代码，不得获得任何更新能力；新增静态守卫防止 preload 桥接扩大。
   - `contextIsolation: true` / `nodeIntegration: false` / `sandbox: true` 保持不变。
3. **落盘状态**：读取时严格校验（版本 `semver.valid`、时间戳有限合理），非法视为无记录。
4. **不新增下载/替换链路**：dsh 更新完全交给 npm（https 源 + npm integrity），应用侧不手写文件。
5. **凭据脱敏**：registry URL 可能含 basic auth，日志与启动页文案只显示 host。
6. **自我保护**：检查与更新单飞；更新中托盘项禁用；失败后 5 分钟冷却；失败绝不回退到
   「PATH 上随便找一个 dsh」（现有 `findPathInstallation` 的 package.json 校验保持不变）。

## 4. 模块拆分（每个文件 ≤ 300 行）

### 4.1 Node 运行时

`src/node-runtime.mjs`(522) →
`src/node/node-artifacts.mjs`（平台产物/镜像/版本范围）、
`src/node/node-discovery.mjs`（系统 Node 探测）、
`src/node/node-download.mjs`（下载与镜像探测）、
`src/node/node-extract.mjs`（tar/zip 安全解压与私有运行时校验）、
`src/node-runtime.mjs`（编排 + 公共 API 门面，导出保持不变）。

### 4.2 启动页

- `src/background.js`(648) → `src/loading/visual-params.mjs`、`src/loading/shaders.mjs`、
  `src/loading/fluid-visual.mjs`、`src/loading/grid-visual.mjs` + 入口 `src/background.js`。
- `src/hero-whale.js`(366) → `src/hero/hero-scene.mjs`、`src/hero/hero-interaction.mjs` + 入口。
- `src/loading.css`(813) → 按职责拆成多个样式文件，`loading.html` 按顺序引入。
- `src/loading.js`(123) 未超限，仅在需要新提示文案时小幅修改。

### 4.3 主进程

`src/main.mjs`(1100) →
`src/window.mjs`（窗口、导航/权限策略、启动页加载与状态广播）、
`src/tray.mjs`（托盘图标与菜单装配）、
`src/harness-launcher.mjs`（启动编排）、
`src/harness-process.mjs`（子进程生命周期）、
`src/dsh-command.mjs`（dsh 命令状态与 PATH 修复）、
`src/updates/desktop-update.mjs`（桌面端更新控制器）、
`src/updates/dsh-update.mjs`（dsh 更新纯逻辑：状态机/文案/节流）、
`src/updates/dsh-update-controller.mjs`（dsh 更新控制器）、
`src/main.mjs`（引导与装配）。

## 5. 验证

1. 先纯重构（行为零变化），每步跑全量 `node --test`。
2. 再实现功能，新增 `test/dsh-update.test.mjs`，迁移/补充 `test/main-startup.test.mjs` 静态守卫。
3. 基线：91 个测试全绿；重构后保持全绿。
4. `sonar-project.properties` 的覆盖率排除清单随拆分同步更新。
5. SonarQube 门禁通过、README 更新、版本号 0.2.8 → 0.3.0。

## 6. 实施结果（2026-09-20）

- 功能、重构、安全加固全部落地；单元测试 91 → 177 全绿，整体行覆盖率 92.4%。
- `updates/desktop-update.mjs` 改为注入 `app`/`shell`/更新源后可在 Node 里完整驱动：
  新增 12 个用例覆盖"开发模式 / 便携版 / 已是最新 / 下载并提示 / 只保留最新下载 /
  48 小时过期 / 下载失败 / macOS 打开安装包 / Windows 退出安装 / Linux AppImage 原位替换 /
  安装失败"等分支（该文件行覆盖率 91%，因此不再需要 SonarQube 覆盖率排除）。
- 每个 JS/CSS 模块 ≤300 行；新增 `test/module-graph.test.mjs`，静态校验"相对导入的名字确实被目标模块导出"（Electron 主进程模块无法在 Node 里 import，这类错只有启动时才炸）。
- 真实 Electron 运行时冒烟通过：加载全部主进程模块、构造控制器、校验托盘菜单项形状。
- `harness-launcher` 用假 dsh 做集成测试：环境解析 → 版本准备 → 真实 spawn → 轮询本地 HTTP 就绪 → 加载 Web UI，并验证"更新完成后写回启动缓存"（否则下次启动会重复提示同一版本）。
- 复盘追加：日志与出错信息统一脱敏（dsh 启动令牌、软件源凭据）、区分"检查失败/更新失败"、
  离线时不谎称"已是最新版本"、`updateTask` 覆盖重启阶段避免并发 npm install、
  `SystemRoot` 必须绝对路径。
- SonarQube 门禁：新增问题 13 → 0，安全热点 2 → 1，重复度 0%，新代码覆盖率 91.0%。
  - 已消除的热点：按 PATH 名字调用 `where` / `taskkill`，改为 `SystemRoot\System32` 下的绝对路径。
  - 剩余 1 个 S5042（解压归档未限制资源消耗）由 `src/node/node-extract.mjs` 引入 `tar` / `yauzl` 触发。
    实验证明：停用解压调用仍在、移除这两个 import 才消失，因此**代码改写无法消除**（除非放弃解压或手写
    tar/zip 解析器）。已按该规则建议补上条目数（6 万）与解压体积（512 MB / 单条目 256 MB）上限，在写盘前
    拒绝解压炸弹；该热点需在 SonarQube 界面人工复核为 Safe。
