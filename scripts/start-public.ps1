# One command to put Agent Hub on the public internet from this Windows PC:
# starts the hub, opens a Cloudflare quick tunnel (free, no account) and
# connects this PC's Kimi Code. Prints the public URL, the login password and
# the command for other machines.
#
#   powershell -ExecutionPolicy Bypass -File scripts\start-public.ps1
#
# The hub keeps running when a quick tunnel drops: the tunnel is restarted with
# backoff and the new public URL is printed (the password and the bridge key
# are printed once, at startup, not again at every reconnect). Only the hub
# exiting ends the script.
#
# Env:
#   PORT (default 8787)
#   AGENT_HUB_TOKEN  your own login password. Never "none": that turns the login
#                    off, and this script puts the hub on the public internet.
#   NO_BRIDGE=1      do not connect this PC's Kimi to the hub. That step writes
#                    ~\.agent-hub and ~\.kimi-code (state, skills, MCP entry, and
#                    the Kimi config when DeepSeek is used); with NO_BRIDGE=1 none
#                    of that is touched. Other computers can still connect.
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
$Port = if ($env:PORT) { $env:PORT } else { '8787' }

# Public mode and no login would hand this whole PC to anyone who finds the
# address: refuse before anything is started or created.
if ("$env:AGENT_HUB_TOKEN".Trim() -eq 'none') {
  Write-Host 'AGENT_HUB_TOKEN 設成 none 代表關掉登入，而這支腳本會把中控台放上公網：任何人拿到網址就能在你的電腦上建立對話、執行指令、讀寫檔案，等於把整台電腦交出去。請不要設 none；不設的話會自動產生密碼（存在 data\hub.json），要自訂就設成別的值。只在本機使用請改跑 npm start，不要用公網模式。' -ForegroundColor Red
  exit 1
}
New-Item -ItemType Directory -Force -Path bin, data | Out-Null

function Say($m) { Write-Host "▸ $m" -ForegroundColor DarkYellow }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw '需要 Node.js 22 以上：https://nodejs.org' }
$major = [int]((node -v).TrimStart('v').Split('.')[0])
if ($major -lt 22) { throw "Node.js 版本太舊（$(node -v)），需要 22 以上" }
# Installed again whenever package-lock.json changed (an update added a package).
$lockStamp = 'node_modules\.agent-hub-lock.json'
if (-not (Test-Path node_modules) -or -not (Test-Path $lockStamp) -or ((Get-FileHash package-lock.json).Hash -ne (Get-FileHash $lockStamp).Hash)) {
  Say '安裝相依套件（npm ci）…'; npm ci --omit=dev --no-audit --no-fund | Out-Null
  Copy-Item package-lock.json $lockStamp
}

# cloudflared: use the installed one, or download the official binary once.
#
# The download is a fixed release, never "latest", and is checked against the
# SHA-256 built in below before it is moved into place or run. A file that does
# not match is deleted and the script stops. Source of the hash: the "digest"
# field GitHub computes for the release asset, which agrees with the checksum
# list in Cloudflare's release notes and with Get-FileHash / sha256sum of the
# downloaded bytes (checked for 2026.10.0).
# To use another release, set both AGENT_HUB_CLOUDFLARED_VERSION and
# AGENT_HUB_CLOUDFLARED_SHA256; to download from a mirror, set
# AGENT_HUB_CLOUDFLARED_BASE_URL. The hash is still checked either way. Or
# install cloudflared yourself: an installed one is used as it is.
$CfVersion = '2026.10.0'
$CfSha256 = '86aee4017b26625cee8484c113558f48effa4cd47f7aa05fcf425604e5d2b23c'   # cloudflared-windows-amd64.exe
$CfBase = if ($env:AGENT_HUB_CLOUDFLARED_BASE_URL) { $env:AGENT_HUB_CLOUDFLARED_BASE_URL.TrimEnd('/') } else { 'https://github.com/cloudflare/cloudflared/releases/download' }
if ($env:AGENT_HUB_CLOUDFLARED_VERSION -or $env:AGENT_HUB_CLOUDFLARED_SHA256) {
  if (-not ($env:AGENT_HUB_CLOUDFLARED_VERSION -and $env:AGENT_HUB_CLOUDFLARED_SHA256)) { throw '要改用其他版本的 cloudflared，必須同時設定 AGENT_HUB_CLOUDFLARED_VERSION 與 AGENT_HUB_CLOUDFLARED_SHA256' }
  if ($env:AGENT_HUB_CLOUDFLARED_VERSION -notmatch '^[0-9A-Za-z._-]+$') { throw 'AGENT_HUB_CLOUDFLARED_VERSION 只能包含英數字與 . _ -' }
  if ($env:AGENT_HUB_CLOUDFLARED_SHA256 -notmatch '^[0-9A-Fa-f]{64}$') { throw 'AGENT_HUB_CLOUDFLARED_SHA256 必須是 64 個十六進位字元' }
  $CfVersion = $env:AGENT_HUB_CLOUDFLARED_VERSION
  $CfSha256 = $env:AGENT_HUB_CLOUDFLARED_SHA256
}
$cf = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $cf) {
  $cf = Join-Path (Get-Location) 'bin\cloudflared.exe'
  # bin\cloudflared.exe is trusted only when this script put it there after
  # checking it: bin\cloudflared.exe.verified holds "<version> <sha256 of the
  # program>". A program from an older copy of this script (downloaded from
  # "latest", never checked) has no such record and is downloaded again, checked.
  $cfStamp = "$cf.verified"
  $cfOk = $false
  if ((Test-Path $cf) -and (Test-Path $cfStamp)) {
    $cfOk = ((Get-Content $cfStamp -Raw).Trim() -eq "$CfVersion $((Get-FileHash $cf -Algorithm SHA256).Hash.ToLower())")
  }
  if (-not $cfOk) {
    $url = "$CfBase/$CfVersion/cloudflared-windows-amd64.exe"
    Say "下載 cloudflared $CfVersion（Cloudflare 官方，會先核對 SHA-256）…"
    $part = "$cf.download"
    Remove-Item -Force -ErrorAction SilentlyContinue $part
    $oldProgress = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'   # the progress bar makes Windows PowerShell 5.1 download very slowly
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $part
    } catch {
      Remove-Item -Force -ErrorAction SilentlyContinue $part
      throw "下載 cloudflared 失敗（$url）。可自行安裝 cloudflared，腳本會優先使用"
    } finally {
      $ProgressPreference = $oldProgress
    }
    $got = (Get-FileHash $part -Algorithm SHA256).Hash.ToLower()
    if ($got -ne $CfSha256.ToLower()) {
      Remove-Item -Force -ErrorAction SilentlyContinue $part
      throw "cloudflared 下載檔的 SHA-256 不符，已刪除、未執行。預期 $($CfSha256.ToLower())，實際 $got（$url）。可能是下載被竄改或網路被攔截；可自行安裝 cloudflared，腳本會優先使用"
    }
    Remove-Item -Force -ErrorAction SilentlyContinue $cf, $cfStamp
    Move-Item $part $cf
    Set-Content -Path $cfStamp -Value "$CfVersion $got" -Encoding ascii
  }
}

$procs = @()      # hub and bridge
$tunnels = @()    # the current tunnel and every earlier one, stopped on exit
$bridgeStarted = $false

# Stop one tunnel and do not return until it is really gone, so a reconnect
# can never run two cloudflared processes at the same time.
function Stop-Tunnel($t) {
  if (-not $t) { return }
  try { if (-not $t.HasExited) { Stop-Process -Id $t.Id -ErrorAction SilentlyContinue; [void]$t.WaitForExit(5000) } } catch {}
  try { if (-not $t.HasExited) { Stop-Process -Id $t.Id -Force -ErrorAction SilentlyContinue; [void]$t.WaitForExit(2000) } } catch {}
}

# Sleep before a reconnect, but stop as soon as the hub itself is gone.
function Wait-Backoff($seconds) {
  $until = [DateTime]::UtcNow.AddSeconds($seconds)
  while ([DateTime]::UtcNow -lt $until) {
    if ($hub.HasExited) { Say '中控台已結束'; exit 1 }
    Start-Sleep -Milliseconds 200
  }
}

# The logs hold the login password (the hub prints it), so they are removed on exit.
$Logs = Join-Path $env:TEMP ("agent-hub-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $Logs | Out-Null

try {
  Say "啟動中控台（port $Port）…"
  $env:HOST = '127.0.0.1'; $env:PORT = $Port
  $hub = Start-Process node -ArgumentList 'server/index.js' -RedirectStandardOutput "$Logs\hub.log" -RedirectStandardError "$Logs\hub.err" -PassThru -NoNewWindow
  $procs += $hub
  # Wait for the port to open (a plain TCP check: no proxy settings involved).
  $up = $false
  for ($i = 0; $i -lt 75 -and -not $up -and -not $hub.HasExited; $i++) {
    Start-Sleep -Milliseconds 200
    $tcp = New-Object Net.Sockets.TcpClient
    try { $up = $tcp.ConnectAsync('127.0.0.1', [int]$Port).Wait(300) -and $tcp.Connected } catch {} finally { $tcp.Close() }
  }
  if (-not $up) {
    Write-Host '--- 中控台的錯誤訊息 ---' -ForegroundColor Red
    Get-Content "$Logs\hub.log", "$Logs\hub.err" -Tail 30 -ErrorAction SilentlyContinue
    throw '中控台沒有啟動起來（上面是它的錯誤訊息）。也可以在這個資料夾直接執行 node server/index.js 看錯誤'

  }
  Say "中控台已啟動：http://127.0.0.1:$Port"

  # A value from the environment wins; data\hub.json is read only for what the
  # environment does not give. (With both variables set on a fresh folder the
  # hub does not write hub.json at all, so it must not be required.)
  $token = $env:AGENT_HUB_TOKEN
  $key = $env:AGENT_HUB_BRIDGE_KEY
  if (-not $token -or -not $key) {
    $secrets = $null
    try { $secrets = Get-Content data\hub.json -Raw -ErrorAction Stop | ConvertFrom-Json } catch {}
    if (-not $token) { $token = $secrets.token }
    if (-not $key) { $key = $secrets.bridgeKey }
    if (-not $token -or -not $key) {
      throw '讀不到登入密碼或連接金鑰：環境變數 AGENT_HUB_TOKEN 與 AGENT_HUB_BRIDGE_KEY 沒有都設定，而且 data\hub.json 不存在、不是有效的 JSON，或缺少 token／bridgeKey。請把兩個環境變數都設好，或先讓中控台自己產生 data\hub.json（不設環境變數啟動一次）。'
    }
  }

  Say '開啟 Cloudflare 公網通道…'
  $backoff = 1
  $maxBackoff = 30
  $attempt = 0
  while ($true) {
    if ($hub.HasExited) { Say '中控台已結束'; exit 1 }

    $attempt++
    $cfLog = "$Logs\cf-$attempt.log"
    $tunnel = Start-Process $cf -ArgumentList "tunnel --no-autoupdate --url http://127.0.0.1:$Port" -RedirectStandardOutput "$Logs\cf-$attempt.out" -RedirectStandardError $cfLog -PassThru -NoNewWindow
    $tunnels += $tunnel
    $url = $null
    for ($i = 0; $i -lt 150 -and -not $url; $i++) {
      Start-Sleep -Milliseconds 200
      $m = Select-String -Path $cfLog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($m) { $url = $m.Matches[0].Value }
      if ($tunnel.HasExited -or $hub.HasExited) { break }
    }
    if ($hub.HasExited) { Say '中控台已結束'; exit 1 }

    if ($url -and -not $tunnel.HasExited) {
      $connectedAt = [DateTime]::UtcNow
      if ($attempt -gt 1) {
        # Only the new address: the password and the bridge key were printed
        # once, at startup, and must not be written again at every reconnect.
        Write-Host ""
        Say '公網通道已重新建立（quick tunnel 的網址可能改變，舊網址已失效）'
        Say "新的公網網址：$url"
        Say '登入密碼與連接金鑰沒有改變（啟動時印過一次，也在 data\hub.json）；其他電腦的連接指令把網址換成上面這個。'
      } else {
        Write-Host ""
        Write-Host "  Agent Hub 已上線" -ForegroundColor Green
        Write-Host "  公網網址：  $url/#token=$token"
        Write-Host "  登入密碼：  $token"
        Write-Host ""
        Write-Host "  其他電腦要連上（在那台電腦執行）："
        Write-Host "    Invoke-WebRequest -UseBasicParsing $url/bridge/agent-hub-bridge.mjs -OutFile agent-hub-bridge.mjs; `$env:AGENT_HUB_BRIDGE_KEY = '$key'; node agent-hub-bridge.mjs --hub $url"
        Write-Host "    （金鑰用環境變數傳入，不會出現在那台電腦的行程列表；但會留在該終端機的指令歷史，不用時可清掉。"
        Write-Host "      macOS／Linux 的終端機：把 `$env:AGENT_HUB_BRIDGE_KEY = '…' 改成 AGENT_HUB_BRIDGE_KEY=… 放在 node 前面）"
        Write-Host ""
        Write-Host "  那台電腦的 Kimi 對話會自動出現在中控台。"
        Write-Host "  注意：quick tunnel 每次啟動或重連的網址都可能不同，"
        Write-Host "        舊網址不會一直有效；請以最新印出的網址為準。"
        Write-Host "  按 Ctrl+C 停止。"
        Write-Host ""
      }
      # The bridge is started once; it reaches the hub on localhost, so a new
      # tunnel address does not concern it.
      if (-not $bridgeStarted) {
        $bridgeStarted = $true
        if ("$env:NO_BRIDGE".Trim().ToLower() -notin @('', '0', 'false', 'no', 'off')) {
          Say '已設定 NO_BRIDGE，略過本機 Kimi 連接（不會寫入 ~\.agent-hub 與 ~\.kimi-code）'
        }
        elseif (Get-Command kimi -ErrorAction SilentlyContinue) {
          Say '把這台電腦的 Kimi 連上中控台…'
          # The key goes in the environment, not on the command line, where any
          # other user of this PC could read it in the process list.
          $prevKey = $env:AGENT_HUB_BRIDGE_KEY
          $env:AGENT_HUB_BRIDGE_KEY = $key
          try {
            $procs += Start-Process node -ArgumentList "bridge/agent-hub-bridge.mjs --hub http://127.0.0.1:$Port" -RedirectStandardOutput "$Logs\bridge.log" -RedirectStandardError "$Logs\bridge.err" -PassThru -NoNewWindow
          } finally {
            $env:AGENT_HUB_BRIDGE_KEY = $prevKey
          }
        } else {
          Say '這台電腦沒有安裝 kimi，略過本機連接'
        }
      }
    } else {
      # The hub is alive, so this is only this tunnel attempt failing.
      Get-Content $cfLog -Tail 10 -ErrorAction SilentlyContinue
      Say "Cloudflare 通道沒有建立起來（第 $attempt 次），$backoff 秒後重試…（Hub 仍在執行）"
      Stop-Tunnel $tunnel
      Wait-Backoff $backoff
      $backoff = [Math]::Min($backoff * 2, $maxBackoff)
      continue
    }

    # Wait for either the hub or this tunnel to exit. The bridge is
    # deliberately not in this set: another connector may already be serving
    # this PC.
    while (-not $hub.HasExited -and -not $tunnel.HasExited) { Start-Sleep -Milliseconds 200 }
    if ($hub.HasExited) { Say '中控台已結束'; exit 1 }

    # The tunnel went away while the hub is still running: reconnect only it.
    if (([DateTime]::UtcNow - $connectedAt).TotalSeconds -ge 10) { $backoff = 1 }
    Get-Content $cfLog -Tail 5 -ErrorAction SilentlyContinue
    Say "公網通道中斷（Hub 仍在執行），$backoff 秒後自動重連…"
    Stop-Tunnel $tunnel
    Wait-Backoff $backoff
    $backoff = [Math]::Min($backoff * 2, $maxBackoff)
  }
} finally {
  foreach ($t in $tunnels) { Stop-Tunnel $t }
  $procs | ForEach-Object { Stop-Process -Id $_.Id -ErrorAction SilentlyContinue }
  # They keep their log files open until they have ended.
  $procs | ForEach-Object { try { [void]$_.WaitForExit(3000) } catch {} }
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Logs
}
