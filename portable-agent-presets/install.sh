#!/usr/bin/env bash
# DeepSeek Harness — 自定义 Agent 预设「一键安装」脚本 (macOS / Linux)
#
# 用法：
#   bash install.sh                 # 安装/更新到 $HOME/.dsh
#   DSH_HOME=/path/.dsh bash install.sh   # 指定 DSH 数据目录（便携/多配置场景）
#
# 做的事（全部幂等，可重复执行）：
#   1. 把 ./agent-presets/* 复制到 DSH_HOME/.agent-presets/（冲突先备份）
#   2. 自动修复旧包引用（workflow-worker-thread -> workflow-ptc），避免预设被静默隐藏
#   3. 把 ./wiring.yml 的声明块以「受管标记块」形式接入 DSH_HOME/profiles/web/cordis.patch.yml
#      （只新增/替换受管块，绝不覆盖你原有的 provider、主题等配置）
#   4. 每次运行最多产生一份改动前备份
#
# 完成后请重启桌面应用（重新拉起 dsh --profile web）生效。
set -euo pipefail

# ── 定位本脚本所在目录（跟随软链） ─────────────────────────────────────────
_SRC="${BASH_SOURCE[0]}"
while [ -L "$_SRC" ]; do
  _DIR="$(cd -P "$(dirname "$_SRC")" >/dev/null 2>&1 && pwd)"
  _SRC="$(readlink "$_SRC")"
  [[ "$_SRC" != /* ]] && _SRC="$_DIR/$_SRC"
done
PKG_DIR="$(cd -P "$(dirname "$_SRC")" >/dev/null 2>&1 && pwd)"

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
AGENT_PRESETS_DIR="$DSH_HOME/.agent-presets"
PROFILE_WEB_DIR="$DSH_HOME/profiles/web"
PATCH="$PROFILE_WEB_DIR/cordis.patch.yml"
WIRING="$PKG_DIR/wiring.yml"
PRESETS_SRC="$PKG_DIR/agent-presets"

# 与 generate-presets.mjs 产出的 wiring.yml 保持一致的标记/首行
WIRING_HEADER='# Wired from ./agent-presets/'
BEGIN_MARKER='# === dsh portable agent presets: BEGIN (managed block) ==='
END_MARKER='# === dsh portable agent presets: END (managed block) ==='
OLD_STYLE='# Custom agent presets, wired from'
LEGACY_PKG='@deepseek-ai/dsh-workflow-worker-thread'
FIXED_PKG='@deepseek-ai/dsh-workflow-ptc'

info() { printf '\033[36m[dsh-presets]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[dsh-presets]\033[0m 错误: %s\n' "$*" >&2; exit 1; }
stamp() { date +%Y%m%d-%H%M%S; }

# ── 前置校验 ───────────────────────────────────────────────────────────────
[ -d "$PRESETS_SRC" ] || die "找不到预设素材目录: $PRESETS_SRC"
[ -f "$WIRING" ] || die "找不到声明文件: $WIRING"

info "DSH_HOME = $DSH_HOME"

backed=0
backup() { # 每次运行最多打一份备份
  if [ "$backed" = "0" ]; then
    cp -a "$1" "$1.bak-$(stamp)"
    backed=1
  fi
}

# ── 1) 预设素材 ────────────────────────────────────────────────────────────
mkdir -p "$AGENT_PRESETS_DIR"
for d in "$PRESETS_SRC"/*/; do
  [ -d "$d" ] || continue
  d="${d%/}"   # 去掉尾斜杠，确保 cp 复制「目录本身」而不是把内容摊平
  name="$(basename "$d")"
  target="$AGENT_PRESETS_DIR/$name"
  if [ -d "$target" ] && ! diff -rq "$d" "$target" >/dev/null 2>&1; then
    backup "$target"
    info "已备份旧素材: $name"
  fi
  cp -a "$d" "$AGENT_PRESETS_DIR/"
  info "预设素材就绪: $name"
done

# ── 2) 旧包引用修复（防御性；同时处理目标机已有的自定义预设） ───────────────
for f in "$AGENT_PRESETS_DIR"/*/agent.cordis.yml; do
  [ -f "$f" ] || continue
  if grep -q -- "$LEGACY_PKG" "$f"; then
    backup "$f"
    # 搜索侧用 \Q..\E 字面匹配；替换串不要用 \Q..\E（会对替换文本做 quotemeta 加反斜杠）
    perl -0pi -e 's!\Q'"$LEGACY_PKG"'\E!'"$FIXED_PKG"'!g; s!(?m)^[ \t]*-\s*id:\s*workflow-worker-thread!- id: workflow-ptc!g' "$f"
    info "已修复旧包引用: $(basename "$(dirname "$f")")"
  fi
done

# ── 3) 声明块接入 cordis.patch.yml（只管理受管块，其余行不动） ────────────
mkdir -p "$PROFILE_WEB_DIR"
if [ ! -f "$PATCH" ]; then
  cat > "$PATCH" <<'PATCH_HEADER'
# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; `!!js` expressions allowed).
PATCH_HEADER
  info "已创建 $PATCH"
fi

changed=0
# 删除旧的受管块（字面匹配，避免 sed 分隔符/转义坑）
if grep -q -- "$BEGIN_MARKER" "$PATCH"; then
  backup "$PATCH"
  perl -0pi -e 's!\Q'"$WIRING_HEADER"'\E.*?\Q'"$END_MARKER"'\E!!s' "$PATCH"
  changed=1
fi
# 删除更早的手工追加块（至文件末尾）
if grep -q -- "$OLD_STYLE" "$PATCH"; then
  backup "$PATCH"
  perl -0pi -e 's!\Q'"$OLD_STYLE"'\E.*\z!!s' "$PATCH"
  changed=1
fi

if grep -q -- "$BEGIN_MARKER" "$PATCH"; then
  info "受管声明块已存在，跳过追加"
else
  # dsh 新建 profile 的占位补丁是空列表 []（本身即一个完整文档），直接追加会变成
  # 「两个文档」导致 dsh 解析失败（end of the stream ... expected）；先移除占位行。
  if grep -qE '^[[:space:]]*\[\][[:space:]]*$' "$PATCH"; then
    backup "$PATCH"
    perl -0pi -e 's!^[ \t]*\[\][ \t]*(\r?\n)?!!m' "$PATCH"
    info "已移除 dsh 空补丁占位 []"
  fi
  backup "$PATCH"
  : >> "$PATCH"
  printf '\n' >> "$PATCH"
  cat "$WIRING" >> "$PATCH"
  info "已接入受管声明块 -> $PATCH"
fi

# ── 4) 收尾 ────────────────────────────────────────────────────────────────
[ "$changed" = "1" ] && info "已替换旧声明块（改动前已备份）"
info "完成。请重启桌面应用（重新拉起 dsh --profile web）以生效。"
info "预设清单: $(ls "$AGENT_PRESETS_DIR" | tr '\n' ' ')"
