# スマホのアプリから ai-agent-lab を起動できるよう、起動係 (launcher.py) をこのPCに常駐させる / 外す。
# ログオン時に自動で立ち上がるようスタートアップにショートカットを置き、Tailscale の中だけに https://<このPC>:8766 を出す。
#   入れる: .\install-launcher.ps1        外す: .\install-launcher.ps1 -Remove
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$LinkPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'ai-agent-lab launcher.lnk'

function Get-Launcher {
  Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'python*' -and $_.CommandLine -match '(^|[\s"\/])launcher\.py\s*$' }
}

if ($Remove) {
  Remove-Item $LinkPath -ErrorAction SilentlyContinue
  Get-Launcher | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  & tailscale serve --https=8766 off | Out-Null
  '起動係を外しました'
  return
}

$pythonw = (Get-Command pythonw -ErrorAction SilentlyContinue).Source
if (-not $pythonw) { throw 'pythonw が見つかりません (Python を PATH に入れてください)' }

$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($LinkPath)
$sc.TargetPath = $pythonw
$sc.Arguments = 'launcher.py'
$sc.WorkingDirectory = $Root
$sc.Description = 'ai-agent-lab をスマホから起動するための常駐'
$sc.Save()

if (-not (Get-Launcher)) { Start-Process $pythonw -ArgumentList 'launcher.py' -WorkingDirectory $Root }
& tailscale serve --bg --https 8766 http://127.0.0.1:8766 | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'tailscale serve の設定に失敗しました' }

"起動係を入れました (ログオン時に自動で立ち上がります): $LinkPath"
'スマホのアプリからの接続先: https://<このPCのマシン名>.<tailnet名>.ts.net:8766'
