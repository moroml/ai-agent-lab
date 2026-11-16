# ACE-Step watchdog (scheduled task AceStep-Watchdog, every 5 min). Restarts the
# API server when port 8001 is down. It does nothing while:
#   - NO_AUTOSTART exists in this folder (create it to keep ACE-Step stopped on purpose)
#   - ComfyUI (8188) or sd-server (7861) listens: ACE-Step needs 15-16 GB VRAM, never run both
#   - an api_server.py process is still starting up
#   - it already restarted 3 times within the last hour
# A skip identical to the last log line is written at most once per $SkipRepeatMinutes,
# so a long ComfyUI session does not add a line every 5 minutes (the task still runs every 5 minutes).
param(
    [int]$Port = 8001,
    [int[]]$GpuPorts = @(8188, 7861),
    [string]$ProcessPattern = 'acestep\\api_server\.py',
    [string]$StartScript = 'C:\project\ace-step\start-ace-detached.ps1',
    [string]$Dir = 'C:\project\ace-step',
    [int]$SkipRepeatMinutes = 60
)
$ProgressPreference = 'SilentlyContinue'
$log = Join-Path $Dir 'watchdog.log'
function Write-Log($msg) { "$(Get-Date -Format o) $msg" | Out-File $log -Append -Encoding UTF8 }
function Write-Skip($msg) {
    $last = Get-Content $log -Tail 1 -ErrorAction SilentlyContinue
    if ($last -match '^(\S+) (.*)$' -and $matches[2] -eq $msg) {
        try {
            $t = [datetime]$matches[1]; $now = Get-Date
            if ($t -gt $now.AddMinutes(-$SkipRepeatMinutes) -and $t -le $now) { return }  # a future stamp (clock moved back) does not suppress
        } catch { }
    }
    Write-Log $msg
}
function Test-Listen($p) { [bool](Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue) }

if (Test-Listen $Port) { exit 0 }
if (Test-Path (Join-Path $Dir 'NO_AUTOSTART')) { Write-Skip "skip: port $Port down, NO_AUTOSTART present"; exit 0 }
$busy = @($GpuPorts | Where-Object { Test-Listen $_ })
if ($busy) { Write-Skip "skip: port $Port down, GPU in use by port $($busy -join ',')"; exit 0 }
if (Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match $ProcessPattern }) { Write-Skip "skip: port $Port down, server process still starting"; exit 0 }
$recent = @(Get-Content $log -ErrorAction SilentlyContinue | Where-Object { $_ -match '^(\S+) restart:' -and [datetime]$matches[1] -gt (Get-Date).AddHours(-1) }).Count
if ($recent -ge 3) { Write-Skip "skip: port $Port down, $recent restarts in the last hour (giving up until they age out)"; exit 0 }
try {
    $out = & $StartScript 2>&1
    Write-Log "restart: port $Port was down -> $out"
} catch {
    Write-Log "restart failed: $_"
    exit 1
}
