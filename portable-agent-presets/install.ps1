# DeepSeek Harness - one-click installer for custom agent presets (Windows PowerShell)
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -DSH_HOME "D:\some\.dsh"
#
# Same behavior as install.sh: copy preset sources into DSH_HOME/.agent-presets,
# fix legacy package names, and wire the managed declaration block into
# DSH_HOME/profiles/web/cordis.patch.yml (append/replace only the managed block,
# never touching your existing provider/theme settings). Idempotent; backs up
# before any change. Restart the desktop app afterwards to apply.
#
# IMPORTANT: keep this file ASCII-only AND saved as UTF-8 with BOM so Windows
# PowerShell 5.1 can parse it no matter the system code page. All file I/O below
# goes through .NET (UTF-8 without BOM) so the Chinese preset names written into
# cordis.patch.yml never get mangled.
param([string]$DSH_HOME = "")

if (-not $DSH_HOME) { $DSH_HOME = Join-Path $HOME ".dsh" }

$PkgDir        = Split-Path -Parent $MyInvocation.MyCommand.Path
$PresetsSrc    = Join-Path $PkgDir "agent-presets"
$Wiring        = Join-Path $PkgDir "wiring.yml"
$AgentPresets  = Join-Path $DSH_HOME ".agent-presets"
$ProfileWebDir = Join-Path $DSH_HOME "profiles\web"
$Patch         = Join-Path $ProfileWebDir "cordis.patch.yml"

$WiringHeader = "# Wired from ./agent-presets/"
$BeginMarker  = "# === dsh portable agent presets: BEGIN (managed block) ==="
$EndMarker    = "# === dsh portable agent presets: END (managed block) ==="
$OldStyle     = "# Custom agent presets, wired from"
$LegacyPkg    = "@deepseek-ai/dsh-workflow-worker-thread"
$FixedPkg     = "@deepseek-ai/dsh-workflow-ptc"

function Info($msg) { Write-Host "[dsh-presets] $msg" -ForegroundColor Cyan }

if (-not (Test-Path $PresetsSrc)) { throw "preset source dir not found: $PresetsSrc" }
if (-not (Test-Path $Wiring))     { throw "wiring file not found: $Wiring" }

Info "DSH_HOME = $DSH_HOME"

# 1) copy preset sources (backup on conflict)
New-Item -ItemType Directory -Force -Path $AgentPresets | Out-Null
Get-ChildItem -Directory $PresetsSrc | ForEach-Object {
    $target = Join-Path $AgentPresets $_.Name
    if (Test-Path $target) {
        Copy-Item $target "$target.bak-$(Get-Date -Format yyyyMMdd-HHmmss)" -Recurse -Force
    }
    Copy-Item $_.FullName $target -Recurse -Force
    Info "preset source ready: $($_.Name)"
}

# 2) fix legacy package references (defensive; also fixes presets already present)
Get-ChildItem -Path $AgentPresets -Recurse -Filter "agent.cordis.yml" -File | ForEach-Object {
    $c = [System.IO.File]::ReadAllText($_.FullName)
    if ($c.Contains($LegacyPkg)) {
        Copy-Item $_.FullName "$($_.FullName).bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
        $c = $c.Replace($LegacyPkg, $FixedPkg)
        $c = [regex]::Replace($c, "(?m)^[ \t]*-\s*id:\s*workflow-worker-thread", "- id: workflow-ptc")
        [System.IO.File]::WriteAllText($_.FullName, $c, (New-Object System.Text.UTF8Encoding($false)))
        Info "legacy package fixed: $($_.Directory.Name)"
    }
}

# 3) wire the managed block into cordis.patch.yml (append/replace only)
New-Item -ItemType Directory -Force -Path $ProfileWebDir | Out-Null
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$existedBefore = Test-Path $Patch
if (-not $existedBefore) {
    $header = @(
        "# Your patch layer for this dsh profile, applied after every bundle layer:",
        "# a top-level YAML array of loader patch entries (id-targeted config",
        "# overrides, disables, and insert lists; ``!!js`` expressions allowed)."
    ) -join "`r`n"
    [System.IO.File]::WriteAllText($Patch, $header + "`r`n", $utf8NoBom)
    Info "created $Patch"
}

$raw = [System.IO.File]::ReadAllText($Patch)
$wiringText = ([System.IO.File]::ReadAllText($Wiring)).TrimEnd("`r", "`n") + "`r`n"

$modified = $false
if ($raw.Contains($BeginMarker)) {
    $pattern = "(?s)" + [regex]::Escape($WiringHeader) + ".*" + [regex]::Escape($EndMarker)
    $raw = [regex]::Replace($raw, $pattern, "")
    $modified = $true
} elseif ($raw.Contains($OldStyle)) {
    $pattern = "(?s)" + [regex]::Escape($OldStyle) + ".*"
    $raw = [regex]::Replace($raw, $pattern, "")
    $modified = $true
}

# dsh seeds a fresh cordis.patch.yml as an empty document "[]", which is itself a
# complete YAML document; appending after it would produce two documents and fail
# to parse ("end of the stream or a document separator is expected"). Drop it.
$rx = [regex]"(?m)^[ \t]*\[\][ \t]*(\r?\n)?"
if ($rx.IsMatch($raw)) {
    $raw = $rx.Replace($raw, "", 1)
}

if ($modified -or -not $raw.Contains($BeginMarker)) {
    $content = $raw.TrimEnd("`r", "`n") + "`r`n" + $wiringText
    if ($existedBefore) {
        Copy-Item $Patch "$Patch.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
    }
    [System.IO.File]::WriteAllText($Patch, $content, $utf8NoBom)
    if ($modified) { Info "replaced old declaration block (backup made)" }
    Info "managed block wired -> $Patch"
} else {
    Info "managed block already present, skip"
}

Info "DONE. Restart the desktop app (it relaunches dsh --profile web) to apply."
