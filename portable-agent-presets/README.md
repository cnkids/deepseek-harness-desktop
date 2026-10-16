# 自定义 Agent 跨机移植包

把这份目录整体复制到另一台电脑后，运行一条命令，两个自定义 agent
（标准模式（中文回复）、测试架构师）即可正常显示。

> 结论先说明：**全程不需要重新打包桌面包装器**。本次修复全部在 DSH 数据目录（`~/.dsh`）内，
> 包装器代码（`--profile web`）没有改动。脚本会自动完成「复制素材 + 接线声明 + 修旧包名」，
> 幂等可重复执行。

## 一步安装（推荐）

把 `portable-agent-presets/` 整个目录复制到目标电脑任意位置，然后执行：

```bash
# macOS / Linux
bash install.sh

# Windows（PowerShell）
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

脚本会自动：
1. 把 `agent-presets/` 复制到 `~/.dsh/.agent-presets/`（冲突时先备份）；
2. **自动修复旧包引用**（`workflow-worker-thread` → `workflow-ptc`），避免旧预设文件导致预设被 UI 静默隐藏；
3. 把 `wiring.yml` 的声明块以「受管标记块」形式接入 `~/.dsh/profiles/web/cordis.patch.yml`（只新增/替换受管块，绝不覆盖你原有的 provider、主题等配置，改动前自动备份）。

然后**重启桌面应用**（重新拉起 `dsh --profile web`）即可。重复执行是安全的（幂等）。

> 只在 `DSH_HOME` 不是默认 `~/.dsh` 时，需要显式指定：
> `DSH_HOME=/path/.dsh bash install.sh`

### Windows 详细步骤

1. 把 `portable-agent-presets/` 整个文件夹复制到 Windows 电脑，比如 `D:\portable-agent-presets`；
2. 打开 PowerShell（开始菜单搜 "PowerShell"，或 Win+R 输入 `powershell`）；
3. 依次执行：

   ```powershell
   cd D:\portable-agent-presets
   powershell -ExecutionPolicy Bypass -File .\install.ps1
   ```

   - 不需要管理员权限（只写你自己用户目录下的 `$HOME\.dsh`）；
   - 如果桌面应用用的是非默认 `DSH_HOME`，加参数：
     `.\install.ps1 -DSH_HOME "D:\your\path\.dsh"`；
   - 脚本会先打印 `DSH_HOME = ...`，再逐项执行：`preset source ready: standard-zh / test-architect`，最后打印 `DONE. Restart the desktop app...`；
   - 改动前会自动生成 `cordis.patch.yml.bak-时间戳` 备份；脚本幂等，重复执行安全。

4. 完全退出桌面应用（托盘图标右键 → 退出）后**重新打开**，Agent 选择器里即可看到两个自定义 agent。

> **注意**：`install.ps1` 输出是英文，且保存为 UTF-8 with BOM 的纯 ASCII 文件。如果执行时出现
> 乱码或「字符串缺少终止符」一类的解析错误，说明你拿到的是**旧版脚本**（老版本含中文、且
> Windows PowerShell 5.1 默认按 GBK 解析导致出错）——请从仓库重新拷贝更新后的 `install.ps1`。
> 跨机传输建议打 zip 压缩包或直接复制文件夹，避免部分聊天/网盘工具重编码文件内容。

> 如果双击文件夹里的 `install.ps1` 没有反应，是因为 Windows 默认禁止运行脚本——用上面的
> `powershell -ExecutionPolicy Bypass -File .\install.ps1` 方式执行即可，无需修改系统策略。

## 脚本帮你在做什么（等价手动步骤）

如果你想知道它到底动了什么，手动等价于下面的 1 + 2：

1. **`agent-presets/` 目录** → 目标电脑的 `~/.dsh/.agent-presets/`
2. **`wiring.yml` 的声明内容** → **追加**到目标电脑的 `~/.dsh/profiles/web/cordis.patch.yml` 末尾（先备份、不要覆盖原有内容）

```bash
cp -a agent-presets ~/.dsh/                          # 第 1 份：预设素材
cp ~/.dsh/profiles/web/cordis.patch.yml ~/.dsh/profiles/web/cordis.patch.yml.bak-$(date +%Y%m%d-%H%M%S)
printf '\n' >> ~/.dsh/profiles/web/cordis.patch.yml
cat wiring.yml >> ~/.dsh/profiles/web/cordis.patch.yml   # 第 2 份：声明接线
```

安装脚本和手动做的是同一件事，只是脚本会加「受管块标记 + 幂等替换 + 旧包名修复」。


## 为什么必须两份、不能只复制 agent-presets

DSH 的 agent-preset 注册表**不扫描目录**（官方说明：`注册表不扫描目录，也不接受 preset 路径`）。
`~/.dsh/.agent-presets/` 里的 `preset.yml + agent.cordis.yml` 只是"素材文件"；
必须把对应声明以 `@deepseek-ai/dsh-agent-preset` 插件行的形式写进
`~/.dsh/profiles/web/cordis.patch.yml`，预设才会进入组合树并显示在 Web 界面的 Agent 选择器里。
只复制素材文件夹、不同步声明，新机器上自定义 agent 依然不显示。

## 为什么"追加" 而不是"整文件覆盖" cordis.patch.yml

`cordis.patch.yml` 是**补丁**文件，除了本包的 agent 声明块之外，还承载这台机器自己的定制，
尤其是**模型服务配置**，是机器/环境相关的：

- `llm-pi-ai`：本机配置了 `szjf`（内网 `http://10.20.0.11:52800/v1`）、`omlx`（本机 MLX `http://127.0.0.1:8623`）、`mimo`（云端 API）等服务商；
- `agent-default-model`：默认模型写死为 `szjf/deepseek-v4-flash-910b`（依赖上面那个内网 provider）；
- 还有 `ui-theme`（深色）、`ui-settings-account`（引导已完成）等 UI 状态。

**整文件覆盖到别的机器的影响**：
1. 把本机的内网/本机 provider（`szjf`、`omlx`）强制带过去 —— 目标机不在该内网就不可达；
2. 默认模型一起变成 `szjf/deepseek-v4-flash-910b` —— 目标机没配它时新会话默认模型会报错，需手动切换；
3. **覆盖会丢掉目标机自己已有的 patch 定制**（如它已配好的 API/provider）—— 最隐蔽的坑。

所以正确做法是**只追加** `wiring.yml`（本文件靠前的小节命令）：对目标机新建的 profile，
唯一新增的就是两个 agent 预设，其余行一律不动。模型服务让目标机在界面里自行配置即可，
不必把本机的 provider 带走。

## 维护：如何改预设内容

修改「标准模式（中文回复）」或「测试架构师」的素材时，**不要手改 `cordis.patch.yml`**：

1. 编辑 `agent-presets/<name>/` 下的 `preset.yml`（展示名/描述/排序）或 `agent.cordis.yml`（插件列表）；
2. 重新生成声明块：

   ```bash
   node generate-presets.mjs      # 会基于 agent-presets/ 重新生成 wiring.yml（幂等，只替换受管块）
   ```

3. 重新运行 install.sh / install.ps1 把新声明同步到本机（或按上面的手动命令追加）。

保存一次会生成一份新的 `wiring.yml`，每次也会在改动前自动备份，可随时还原。

## 注意事项

- **本包的 standard-zh 已修复旧包引用**：`agent.cordis.yml` 用的是
  `@deepseek-ai/dsh-workflow-ptc`（内建 standard 同款）。如果你复制的是早前那份
  `@deepseek-ai/dsh-workflow-worker-thread`，它在现有 dsh 版本里不存在，会导致该预设被判
  `broken: never started` 而被 UI 静默隐藏。请始终用本包里的这份文件。
- 目标电脑的 dsh 版本需 ≥ `0.2.0-rc.2`（保证内置 `@deepseek-ai/dsh-workflow-ptc`）；
  Node.js 满足桌面包装器的兼容范围（`^22.19.0 || >=24.0.0`）。
- **dsh 新建 profile 的空补丁占位 `[]`**：dsh 初始化 web profile 时，`cordis.patch.yml`
  内容为 3 行注释 + 一行 `[]`（一个空列表，本身就是一个完整的 YAML 文档）。直接在它后面
  追加 `- insert:` 会形成「两个文档」，dsh 启动时报
  `YAMLException: end of the stream or a document separator is expected`。安装脚本会自动
  **移除这一行占位**再接线（已覆盖此场景）；如果走手动追加，请先删掉 patch 文件里的 `[]` 行。
- 改配置前先备份；重复执行本说明的命令是幂等的（`wiring.yml` 重复追加会重复声明，
  无副作用，但若在意可先 grep 一下）。

## 内容清单

| 文件 | 作用 |
|------|------|
| `install.sh` | 一键安装脚本 (macOS / Linux)。复制素材 + 修旧包名 + 受管块接线，幂等 |
| `install.ps1` | 一键安装脚本 (Windows PowerShell)，行为同 install.sh |
| `generate-presets.mjs` | 维护用：基于 `agent-presets/` 重新生成 `wiring.yml` |
| `wiring.yml` | 声明块（带受管块标记）：由 generate-presets.mjs 产出，交给 install 脚本接入 |
| `agent-presets/standard-zh/preset.yml` | 展示名/描述/排序（标准模式（中文回复）） |
| `agent-presets/standard-zh/agent.cordis.yml` | 插件列表（已改用 `dsh-workflow-ptc`） |
| `agent-presets/test-architect/preset.yml` | 展示名/描述/排序（测试架构师） |
| `agent-presets/test-architect/agent.cordis.yml` | 插件列表 |
