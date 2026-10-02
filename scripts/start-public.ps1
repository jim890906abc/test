# One command to put Agent Hub on the public internet from this Windows PC:
# starts the hub, opens a Cloudflare quick tunnel (free, no account) and
# connects this PC's Kimi Code. Prints the public URL, the login password and
# the command for other machines.
#
#   powershell -ExecutionPolicy Bypass -File scripts\start-public.ps1
#
# Env: PORT (default 8787), NO_BRIDGE=1 to skip connecting this PC.
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
$Port = if ($env:PORT) { $env:PORT } else { '8787' }
New-Item -ItemType Directory -Force -Path bin, data | Out-Null
$Logs = Join-Path $env:TEMP ("agent-hub-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $Logs | Out-Null

function Say($m) { Write-Host "▸ $m" -ForegroundColor DarkYellow }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw '需要 Node.js 22 以上：https://nodejs.org' }
$major = [int]((node -v).TrimStart('v').Split('.')[0])
if ($major -lt 22) { throw "Node.js 版本太舊（$(node -v)），需要 22 以上" }
if (-not (Test-Path node_modules)) { Say '安裝相依套件（npm install）…'; npm install --omit=dev --no-audit --no-fund | Out-Null }

$cf = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $cf) {
  $cf = Join-Path (Get-Location) 'bin\cloudflared.exe'
  if (-not (Test-Path $cf)) {
    Say '下載 cloudflared（Cloudflare 官方）…'
    Invoke-WebRequest 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $cf
  }
}

$procs = @()
try {
  Say "啟動中控台（port $Port）…"
  $env:HOST = '127.0.0.1'; $env:PORT = $Port
  $procs += Start-Process node -ArgumentList 'server/index.js' -RedirectStandardOutput "$Logs\hub.log" -RedirectStandardError "$Logs\hub.err" -PassThru -NoNewWindow
  $up = $false
  for ($i = 0; $i -lt 100 -and -not $up; $i++) {
    Start-Sleep -Milliseconds 200
    try { Invoke-WebRequest "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 2 | Out-Null; $up = $true } catch {}
  }
  if (-not $up) { Get-Content "$Logs\hub.log", "$Logs\hub.err" -Tail 20 -ErrorAction SilentlyContinue; throw '中控台沒有啟動起來' }

  $secrets = Get-Content data\hub.json -Raw | ConvertFrom-Json
  $token = if ($env:AGENT_HUB_TOKEN) { $env:AGENT_HUB_TOKEN } else { $secrets.token }
  $key = if ($env:AGENT_HUB_BRIDGE_KEY) { $env:AGENT_HUB_BRIDGE_KEY } else { $secrets.bridgeKey }

  Say '開啟 Cloudflare 公網通道…'
  $procs += Start-Process $cf -ArgumentList "tunnel --no-autoupdate --url http://127.0.0.1:$Port" -RedirectStandardOutput "$Logs\cf.out" -RedirectStandardError "$Logs\cf.log" -PassThru -NoNewWindow
  $url = $null
  for ($i = 0; $i -lt 150 -and -not $url; $i++) {
    Start-Sleep -Milliseconds 200
    $m = Select-String -Path "$Logs\cf.log" -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($m) { $url = $m.Matches[0].Value }
  }
  if (-not $url) { Get-Content "$Logs\cf.log" -Tail 20; throw 'Cloudflare 通道沒有建立起來（請檢查網路或防火牆）' }

  if (-not $env:NO_BRIDGE -and (Get-Command kimi -ErrorAction SilentlyContinue)) {
    Say '把這台電腦的 Kimi 連上中控台…'
    $procs += Start-Process node -ArgumentList "bridge/agent-hub-bridge.mjs --hub http://127.0.0.1:$Port --key $key" -RedirectStandardOutput "$Logs\bridge.log" -RedirectStandardError "$Logs\bridge.err" -PassThru -NoNewWindow
  }

  Write-Host ""
  Write-Host "  Agent Hub 已上線" -ForegroundColor Green
  Write-Host "  公網網址：  $url/#token=$token"
  Write-Host "  登入密碼：  $token"
  Write-Host ""
  Write-Host "  其他電腦要連上（在那台電腦執行）："
  Write-Host "    curl -fsSL $url/bridge/agent-hub-bridge.mjs -o agent-hub-bridge.mjs && node agent-hub-bridge.mjs --hub $url --key $key"
  Write-Host ""
  Write-Host "  那台電腦的 Kimi 對話會自動出現在中控台。按 Ctrl+C 停止。"
  Wait-Process -Id ($procs | ForEach-Object { $_.Id })
} finally {
  $procs | ForEach-Object { Stop-Process -Id $_.Id -ErrorAction SilentlyContinue }
}
