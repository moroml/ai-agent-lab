# このPCの ai-agent-lab (ポート 8765) を別PCから使えるよう、Windows ファイアウォールの受信許可を入れる / 外す。
# 既定は Tailscale の範囲だけを通す。同じ LAN から使うなら -RemoteAddress 192.168.11.0/24 のように指定する。
#   入れる: .\remote-access.ps1        外す: .\remote-access.ps1 -Remove
param([string]$RemoteAddress = '100.64.0.0/10', [switch]$Remove)
$name = 'ai-agent-lab 8765'
$ErrorActionPreference = 'Stop'   # 規則の追加・削除に失敗したら成功の表示まで進めない

$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  # 管理者で開き直す (結果を読めるよう窓は閉じない)
  $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-File', "`"$PSCommandPath`"", '-RemoteAddress', $RemoteAddress)
  if ($Remove) { $argv += '-Remove' }
  Start-Process powershell -Verb RunAs -ArgumentList $argv
  return
}

Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
if ($Remove) { '受信の許可を外しました'; return }
New-NetFirewallRule -DisplayName $name -Direction Inbound -Protocol TCP -LocalPort 8765 -RemoteAddress $RemoteAddress -Action Allow | Out-Null

$ips = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -in 'Tailscale', 'Wi-Fi', 'Ethernet', 'イーサネット' }).IPAddress
"受信を許可しました (接続元 $RemoteAddress)"
"このPCのアドレス: $($ips -join ' / ')"
'別PCの接続先: http://<このPCのアドレス>:8765/v1  (キーは api_settings.json の api_key)'
