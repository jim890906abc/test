# Agent Hub

在瀏覽器（電腦或手機）統一操作你每台電腦上的 **Kimi Code**、**Claude**（Claude API）與 **DeepSeek** 對話。

Agent Hub 由兩個部分組成：**中控台**（Hub，一個 Node.js 小服務，提供網頁介面）和各電腦上的**連接器**（bridge，主動連回中控台）。agent 與它的工具（讀寫檔案、執行指令）都在你自己的電腦上跑；中控台負責轉送、顯示、排程，讓你在同一個介面看到、接手與切換這些對話，關掉網頁也不會中斷它們。

![對話：側邊欄的「聊天室」與「子session」、工具步驟、子代理卡與統一的模型選單](docs/conversation.png)

| Artifact 即時預覽 | 手機・深色 |
| --- | --- |
| ![Artifact 即時預覽面板](docs/artifact.png) | ![手機版深色配色的對話畫面](docs/mobile-dark.png) |

> 截圖內容全是虛構的示範資料，由 `node scripts/take-screenshots.mjs` 用真實的前端自動拍成（介面改版後可以重拍）。

## 快速開始

需要 [Node.js 22 以上](https://nodejs.org) 與 Git（完整需求見「[需求](#需求)」）。

**Linux / macOS**

```bash
git clone https://github.com/jim890906abc/test.git agent-hub
cd agent-hub && npm run public
```

**Windows（PowerShell）**

```powershell
git clone https://github.com/jim890906abc/test.git agent-hub
cd agent-hub; powershell -ExecutionPolicy Bypass -File scripts\start-public.ps1
```

啟動腳本會依序：檢查 Node 版本 → 第一次（或 `package-lock.json` 改變時）執行 `npm ci --omit=dev` 安裝相依套件 → 找 `cloudflared`（見下方「[cloudflared 怎麼來的](#cloudflared-怎麼來的)」）→ 在 `127.0.0.1:8787` 啟動中控台 → 開一條 Cloudflare 公網通道 → 如果這台電腦裝了 `kimi`，順便把它連上中控台。最後印出**公網網址、登入密碼**，以及給其他電腦用的**連接指令**；`Ctrl+C` 會把這些一起關掉。腳本一開始就會拒絕 `AGENT_HUB_TOKEN=none`：公網上沒有登入，等於把整台電腦交出去。

> **注意**：這個啟動方式會把中控台放上公網，此時**登入權杖是唯一的保護**（見「[資安與信任模型](#資安與信任模型)」）。只想在本機用，請看下一節。

可用的環境變數（Windows 的 `npm run public` 需要 bash，請直接用上面的 PowerShell 腳本；PowerShell 設環境變數的寫法是 `$env:PORT = '8788'`）：

| 環境變數 | 作用 |
| --- | --- |
| `PORT` | 中控台的埠，預設 `8787`。 |
| `AGENT_HUB_TOKEN` | 自訂登入密碼。不設就自動產生，存在 `data/hub.json`。**不可以是 `none`**，腳本會直接拒絕。 |
| `NO_BRIDGE` | 略過「把這台電腦的 Kimi 連上中控台」那一步（見下方「連接器會動到倉庫以外的位置」）。不設、空字串、`0`、`false`、`no`、`off`（不分大小寫）才會連接；**其他任何值**（例如 `1`、`true`、`yes`、`on`）都略過。其他電腦照樣可以連上來。 |
| `AGENT_HUB_CLOUDFLARED_VERSION`、`AGENT_HUB_CLOUDFLARED_SHA256` | 改用其他版本的 `cloudflared`；**兩個必須同時設**，只設一個腳本會拒絕。 |
| `AGENT_HUB_CLOUDFLARED_BASE_URL` | 改從鏡像下載（預設是 `https://github.com/cloudflare/cloudflared/releases/download`）。 |

> **連接器會動到倉庫以外的位置**：偵測到 `kimi` 時，啟動腳本會順便啟動本機的連接器。它在你的家目錄寫入 `~/.agent-hub/`（連接器狀態，`0700`／`0600`）和 `~/agent-hub-workspaces/`（Hub 替你建立的對話工作資料夾），並在 Kimi 的資料夾（預設 `~/.kimi-code/`）安裝 `/artifact`、`/github` skill 與子代理 broker（MCP 與 hook）設定；使用 DeepSeek 時還會調整 Kimi 的 `config.toml`（只動 `agent-hub-deepseek` 相關內容，先備份）。完全不想碰這些就設 `NO_BRIDGE=1`；連接器本身另有 `--no-skill`、`--no-broker` 可略過前兩項。

**只在本機使用（不開公網）**

```bash
npm ci --omit=dev
npm start
```

`npm start` 只聽 `127.0.0.1:8787`，並印出含登入密碼的網址。要把這台電腦的 Kimi 連進來，開啟網頁後在左下角「連接電腦…」複製那台電腦要執行的連接指令。

**更新**：在 `agent-hub` 資料夾裡執行 `git pull`，再執行一次啟動指令（相依套件有變動時啟動腳本會自動重裝）。

**在伺服器上跑**：用 Docker，見下一節「[用 Docker 跑在伺服器上](#用-docker-跑在伺服器上)」。

### cloudflared 怎麼來的

1. 這台電腦已經裝了 `cloudflared`（在 `PATH` 上）就直接用，**什麼都不下載**。
2. 否則下載**固定版本 2026.10.0**（不是 `latest`）到 `bin/`，而且**在解開、設為可執行、執行之前**先核對內建的 SHA-256；不符就刪掉下載的檔案、停止，不會執行。核對通過後，`bin/cloudflared.verified` 記下「版本 與 程式的雜湊」，之後只在這筆紀錄還對得上時才沿用 `bin/` 裡的程式（舊版腳本留下、沒核對過的程式，或核對後被改過的程式，都會重新下載並核對）。
3. 下載支援 Linux（amd64、arm64、arm）、macOS（amd64、arm64）、Windows（amd64）；其他組合會說明原因，請自行安裝 `cloudflared`（例如 macOS：`brew install cloudflared`）。
4. 要換版本，`AGENT_HUB_CLOUDFLARED_VERSION` 與 `AGENT_HUB_CLOUDFLARED_SHA256` 一起設（雜湊是**這台電腦要下載的那個檔案**的 SHA-256：Linux／Windows 是執行檔本身，macOS 是 `.tgz`）；用鏡像時再加 `AGENT_HUB_CLOUDFLARED_BASE_URL`，雜湊照樣核對。

Linux／macOS 的腳本下載時需要 `curl`，以及 `sha256sum`、`shasum`、`openssl` 其中之一（核對雜湊用；macOS 內建 `shasum`），三樣都找不到就不會執行下載的檔案。

### macOS 與 Windows 的實測範圍

- **macOS**：內建的 bash 是 3.2。腳本不用 bash 4 以上才有的語法，`wait -n` 只有在 bash 4.3 以上才用，否則改成每 0.2 秒輪詢。這些**只在 Linux 的 bash 5 上驗證過**：測試用「讓 `wait -n` 立刻失敗」的方式模擬 3.2 的行為，並逐項檢查腳本沒有用到較新的語法；**沒有在真正的 macOS 或 bash 3.2 上實測**。
- **Windows**：PowerShell 腳本只下載 amd64 版的 `cloudflared`。測試是在 Linux 的 PowerShell 7（`pwsh`）上搭配替身程式跑的，**沒有在真正的 Windows 上實測**。

## 用 Docker 跑在伺服器上

倉庫附有 `Dockerfile`（`node:22-alpine`），只跑中控台；Kimi 與 Claude 的工作仍在你的電腦上，用連接器連回來。最小可用的啟動方式：

```bash
docker build -t agent-hub .
docker run -d --name agent-hub -p 127.0.0.1:8787:8787 -v agent-hub-data:/data \
  -e AGENT_HUB_TOKEN="$(openssl rand -hex 16)" agent-hub
docker logs agent-hub    # 啟動訊息裡有登入密碼
```

然後在同一台機器上開 `http://127.0.0.1:8787/`，貼上登入密碼。注意 `docker logs` 印出的網址是 `http://0.0.0.0:8787/#token=…`，`0.0.0.0` 要換成你實際連的位址（上面的例子是 `127.0.0.1`）。

- **不用 root**：映像以專用使用者 `agenthub`（uid `10001`）執行。
- **資料都在 `/data` 卷**：登入權杖與連接金鑰（`hub.json`）、對話、設定、API key，以及 Hub 替你建立的工作資料夾（`/data/workspaces`）。`/data` 的權限是 `0700`，屬於 `agenthub`。這個卷等於你整個 Hub，請備份、也別讓別人讀到。用 bind mount 掛載時，**先把那個資料夾交給 uid 10001**：`chown 10001:10001 <資料夾> && chmod 700 <資料夾>`；否則 Hub 一啟動就會因為寫不進去（`EACCES`）而失敗。
- **一定要設密碼**：容器必須監聽 `0.0.0.0`，埠才發佈得出去，而有登入的人等於能在每台連上來的電腦上執行指令。所以沒設 `AGENT_HUB_TOKEN`、或設成 `none` 時，映像的入口腳本不會啟動；Hub 本身遇到 `none` 搭配非回環位址也會拒絕啟動。密碼可以用 `openssl rand -hex 16` 產生（只用英數字，才能用 `#token=…` 網址登入）。
- **映像只講明文 HTTP**：登入權杖會在網路上以明文傳送。例子裡的 `-p 127.0.0.1:8787:8787` 只把埠發佈在本機；要從外面連，請放在 TLS 反向代理之後（或走通道），不要把 8787 直接開到網際網路。反向代理若改寫 `Host`，要讓它帶 `X-Forwarded-Host`，或設 `AGENT_HUB_ALLOWED_ORIGINS`（見「[資安與信任模型](#資安與信任模型)」），否則瀏覽器的 WebSocket 會被 403 擋下。
- **有健康檢查**：`HEALTHCHECK` 每 30 秒用 `wget` 讀一次首頁（啟動後 20 秒內的失敗不算，連續失敗 3 次才算 `unhealthy`），`docker ps` 會顯示 `healthy`／`unhealthy`。
- **`.dockerignore` 的作用**：`COPY . .` 會把資料夾裡的東西永久燒進映像，所以 `.dockerignore` 把本機狀態與祕密擋在外面：`.git`、`data/`、`workspaces/`、`node_modules`、`bin/`、`.env*`、`*.pem`／`*.key`、日誌與備份檔；`public/` 也只放行網頁本體（`index.html`、`css/*.css`、`js/*.js`）。

以上在 Docker 29 上實際建置並跑過（密碼擋下未授權的 API、資料夾與檔案權限、非 root、健康檢查、沒設密碼與 `none` 的拒絕、bind mount 先 `chown` 與沒 `chown` 的差別）。`AGENT_HUB_TEST_DOCKER=1 node --test test/docker-hardening.test.mjs` 會用一個塞滿誘餌檔的資料夾真的建置一次映像並檢查它們沒進去（需要 Docker，會下載基底映像與相依套件）。

## 需求

| 項目 | 說明 |
| --- | --- |
| Node.js **22 以上** | `package.json` 的 `engines.node` 是 `>=22`；啟動腳本、連接器、Docker 映像與 Claude 背景程式都以 22 為準（用到內建的 `fetch` 與 `WebSocket`），版本太舊會直接停下並說明。 |
| Git | 取得與更新原始碼。 |
| 作業系統 | Linux、macOS（`scripts/start-public.sh`）、Windows（`scripts/start-public.ps1`，PowerShell）。Linux 是開發與測試的環境；macOS 與 Windows 的實測範圍見「[macOS 與 Windows 的實測範圍](#macos-與-windows-的實測範圍)」。 |
| 瀏覽器 | 現代瀏覽器，電腦或手機皆可（介面的自動化測試在 Chromium 上跑）。 |
| 至少一家 AI 的帳號 | **Kimi**：要用 Kimi 對話的電腦上裝好 [Kimi Code](https://github.com/MoonshotAI/kimi-code) 並登入（`kimi login`）。**Claude**：[Claude Console](https://console.anthropic.com/settings/keys) 的 API key（`sk-ant-…`，不是 Pro／Max 訂閱）；不需要 Kimi。**DeepSeek**：OpenCode Go、OpenCode 或 Command Code 的 API key，並且那台電腦要有 Kimi Code 與在線的連接器。三家都是選用。 |
| 選用工具 | `cloudflared`（公網通道；沒有就下載固定版本並核對 SHA-256，見「[cloudflared 怎麼來的](#cloudflared-怎麼來的)」）；`gh`（GitHub 功能，在要用的電腦上）；`rclone`（Google Drive 備份）；`python3`（只有 `kimi-hub` 包裝指令需要）。 |

## 功能一覽

- **統一模型選單**：只有一個首頁與一個對話清單；輸入框旁的選單依 Kimi／Claude／DeepSeek 分組，新舊對話都能改選，不需要切「模式」。所選的供應商、模型或 key 不可用時明確報錯，不會偷偷改用另一家。
- **接續鏈**：在 Kimi ↔ Claude 之間切換時，Hub 建立接續節點並帶上可讀歷史，側欄仍是同一個聊天室；原本的原生對話不會被刪除或改寫。
- **子代理預設與 broker**：每個對話可指定新子代理的供應商、模型與思考強度（預設 DeepSeek V4.1 Flash + max）；Kimi／DeepSeek 用原生 `Agent`／`AgentSwarm`，跨供應商的組合走 Hub 的 broker，卡片顯示實際模型與進度。
- **DeepSeek 號池**：支援三個閘道（OpenCode Go、OpenCode、Command Code），所有閘道的 key 放在同一份清單、依序使用；目前這把額度真的用完就自動換下一把，不論是哪一家，換家時網址、模型 id 與標頭一起換，對話看不到錯誤。用盡的 key 只在閘道明說的時間或之後的真實請求確認時才回來，不靠猜。
- **長對話不卡**：打開對話只送最新一段視窗（預設最近 6 個回合、300 KB、500 個事件），往上捲再載入更早的；過長的欄位先給預覽，要看再取全文。視窗外的東西照樣看得到：Artifact 面板列出整個對話做過的所有頁面，「目前問題」置頂與忙碌計時不受視窗影響，視窗之前開始的子代理卡也還在（見「[開啟長對話：視窗與分頁](#開啟長對話視窗與分頁)」）。
- **損壞對話檔救援**：對話檔因當機損壞時，原檔先原封不動備份到 `data/sessions-damaged/`；能修的修好再載入，側欄與對話頂部有「曾損壞並已修復」徽章；不能修的列在 `GET /api/damaged-sessions`，並在側欄頂端以橫幅提醒，不會靜默略過（見「[對話檔損壞時](#對話檔損壞時)」）。
- **設定檔損壞不默默重來**：登入權杖與連接金鑰（`hub.json`）、已登記電腦清單（`machines.json`）、已刪除的 Claude 對話清單（`claude-deleted.json`）、Claude 與 DeepSeek 的 API key／金鑰池（`claude.json`、`deepseek.json`）、agents 與設定（`agents.json`、`settings.json`）讀不進來時，原檔備份到 `data/damaged-config/`、啟動日誌警告，不再悄悄產生新的權杖或把金鑰檔改寫成空的（見「[設定檔損壞時](#設定檔損壞時)」）。
- **模型飄移提示**：Hub 記錄的模型和原生對話實際在用的不同時（例如在終端機或全域設定改過），輸入框改顯示「實際：…」並提供「改回」。
- **終端機並存**：終端機裡的 Kimi 與 Hub 可以同時操作同一個對話，不需要 `/web` 或 `kimi-hub`；兩邊同時寫入可能互相覆蓋，這是已接受的取捨。
- **自動暫停與定時送出**：Kimi 的 5 小時額度用到設定的 % 時自動「優雅暫停」，額度恢復後「繼續」；另有 `/later` 定時送出與 `/bg` 移到背景。（DeepSeek 對話沒有 5 小時額度，不適用自動暫停。）
- **Swarm 模式**（Kimi 與 DeepSeek 對話）：主模型呼叫 AgentSwarm 一次派出一群子代理，Kimi 只在使用者開啟 swarm 模式時才讓它跑（沒開時回「Swarm mode is off」）。輸入 `/swarm` 切換、`/swarm on`／`/swarm off`，或在「權限」選單勾選「Swarm 模式」；開啟時輸入框旁有「Swarm」標籤，點一下關閉。`/swarm <任務>` 會先開啟再送出任務，之後**保持開啟**直到你關掉（Hub 沒辦法要求 Kimi 做終端機那種「任務結束自動關閉」）。Swarm 用量可能是一般對話的好幾倍；在「每次詢問」權限下子代理可能停下來等核准。終端機裡由中控台操作的 Kimi 會收到 Kimi 自己的 `/swarm`，Hub 不會替你把權限改成「全部自動」。Claude 沒有 swarm 模式。
- **Artifact 即時預覽**：agent 寫出的 HTML 頁面在側邊面板的沙盒 iframe 裡即時顯示。
- **GitHub 與 Google Drive**：Claude／Kimi 對話可綁定 GitHub repo（獨立分支，每輪結束檢查未 commit／push 的變更）；`/backup` 用 rclone 把專案資料夾備份到你的 Google Drive。
- **多台電腦**：連接器從各電腦主動連回中控台（不用開埠、可在 NAT 後面），那台電腦的 Kimi 與 Claude 對話自動出現。
- **側邊欄與外觀**：聊天室／子session 兩個分類；手機與深色可用，窄的畫面（手機，或側邊欄與面板都開著）裡輸入框下方的晶片會換行而不是被切掉；配色（Kimi 米色、Claude 近黑、DeepSeek 藍白）與模型無關，可自行固定，切換時整個畫面交叉淡入（見「[統一模型、接續對話與外觀](#統一模型接續對話與外觀)」）。
- **安全預設**：預設只聽本機；回應帶安全標頭；REST 只收標頭裡的權杖；WebSocket 會檢查來源；沒有登入而位址又不是本機時 Hub 拒絕啟動；`data/` 新建時只有你自己讀得到（見「[資安與信任模型](#資安與信任模型)」）。

各功能的細節在後面的章節，完整設計與驗收規格在 [`docs/unified-models-spec.md`](docs/unified-models-spec.md)（開發記錄，寫給貢獻者看，一般使用者不需要讀）。

## 資安與信任模型

先講最重要的一點：**agent 會在你的電腦上執行指令。能登入中控台的人，等於能以你的帳號權限，在每一台連上來的電腦上讀寫檔案、執行指令。** 請把登入密碼當成 SSH 私鑰對待。

- **預設只聽本機**：中控台預設綁在 `127.0.0.1:8787`（環境變數 `HOST`、`PORT` 可改）；`npm start` 與 `npm run public` 都是如此。把 `HOST` 設成 `0.0.0.0` 等於對整個網路開放，請自己放在 HTTPS 反向代理與防火牆後面。Docker 映像一定要綁 `0.0.0.0`，所以它的入口腳本強制要設密碼（見「[用 Docker 跑在伺服器上](#用-docker-跑在伺服器上)」）。
- **登入權杖與連接金鑰**：第一次啟動時隨機產生 128 位元的登入權杖，以及另一把給連接器用的連接金鑰（`bk_…`），存在 `data/hub.json`（權限 `0600`；`data/` 已被 `.gitignore` 排除）。`/api` 與 `/ws` 需要登入權杖，連接器的 `/bridge` 需要連接金鑰，比對都用定時安全的方式。可用 `AGENT_HUB_TOKEN`、`AGENT_HUB_BRIDGE_KEY` 覆寫（環境變數有指定的就不產生，也不寫進 `hub.json`）。
  - **`AGENT_HUB_TOKEN=none` 只限純本機**：它會關掉登入。`HOST` 不是只有這台電腦連得到的位址（`127.0.0.1`、`::1`、`localhost`）時，Hub 直接**拒絕啟動**；在這幾個位址上也會印出警告，因為這台電腦上的任何程式與網頁都能使用這個 Hub（含執行指令）。沒有登入時，REST API 也會拒絕帶著其他網站 `Origin` 的請求（403），避免你瀏覽器裡開著的別的網頁去打你本機的 Hub。`npm run public`、`start-public.ps1` 與 Docker 的入口腳本遇到 `none` 也各自直接拒絕。
  - 網址裡的 `#token=…` 位於 `#` 之後，不會送到伺服器；網頁載入後立刻把它從網址列移除，改存在該瀏覽器的 `localStorage`。也可以在登入畫面貼上密碼。
  - **權杖怎麼帶**：REST API 只收 `x-hub-token` 標頭；放在網址的 `?token=…` 會得到 401。瀏覽器的 WebSocket 沒辦法帶自訂標頭，所以只有 `/ws` 的連線升級還是用查詢字串（`/ws?token=…`），連接器的 `/bridge` 也是（`/bridge?key=…`）。因此不要把中控台放在會完整記錄 URL 的代理或日誌之後。
  - **WebSocket 只接受自己人的來源**：`/ws` 與 `/bridge` 的連線若帶 `Origin`（瀏覽器一定會帶，而且網頁改不了它），必須與 `Host` 同源，或列在 `AGENT_HUB_ALLOWED_ORIGINS`（逗號分隔的來源，例如 `https://hub.example.com, https://other.example:8443`），否則 403。沒有 `Origin` 的客戶端（連接器、腳本）照舊放行，但仍然需要權杖或金鑰。如果前面的代理會改寫 `Host`，請讓它帶 `X-Forwarded-Host`，或把對外的來源列進 `AGENT_HUB_ALLOWED_ORIGINS`，不然你自己的瀏覽器也會被擋。
  - **先驗證，再讀請求，而且有上限**：沒帶對權杖的請求，內容根本不會被讀取或解壓。JSON 請求上限 1 MB，只有「建立對話」（`POST /api/sessions`）與「送訊息」（`POST /api/sessions/:id/messages`）兩個要帶附件與圖片的路由放寬到 80 MB，超過回 413。`/ws` 單一訊息上限 1 MiB；`/bridge` 單一訊框上限預設 64 MiB（`AGENT_HUB_BRIDGE_MAX_FRAME_MB` 可調），超過只會關掉那一條連線。
  - **錯誤回應**：格式不對的 JSON、請求太大、不支援的編碼、找不到的 API 路徑，一律回固定的繁體中文 `{ "error": "…" }`，不帶堆疊與檔案路徑，完整錯誤只寫在 Hub 自己的日誌。各個 API 動作失敗時回報的是那個動作自己的說明文字，只有已登入的人看得到；其中某些內部錯誤（例如讀不到資料夾）會把底層的錯誤訊息原樣帶出，可能含這台電腦上的路徑。
  - **安全標頭**：每個一般 HTTP 回應都帶 `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`，以及預設的內容安全政策 `Content-Security-Policy: frame-ancestors 'none'; base-uri 'self'; object-src 'none'`（不能被別的網站用 frame 框起來、不能用 `<base>` 改寫網址、不載外掛）；`X-Powered-By` 已關掉。預設政策**刻意不限制 script、style、圖片與連線**：Artifact 預覽是 `srcdoc` 的 iframe，會繼承父頁的 CSP，而模型寫出來的頁面常有行內腳本，也常從 CDN 載入函式庫、字型與圖片，限制了預覽就壞了。
  - **嚴格版 CSP**：設 `AGENT_HUB_CSP=strict` 改用嚴格的政策：腳本只准本站，加上 `index.html` 唯一的那段行內腳本（以雜湊白名單）；連線只准本站與它的 WebSocket；圖片、字型與媒體只准本站與 `data:`／`blob:` 這類內嵌來源（樣式仍允許行內）；注入頁面的行內腳本不會執行。**代價**：Artifact 預覽不能執行行內腳本，也載不到外部的函式庫與圖片；對話裡 Markdown 的遠端圖片同樣不會載入（也就關掉了下面提到的圖片外洩途徑）。適合放在公網、而且不用 Artifact 的人。
  - **資料夾權限**：`data/` 新建時是 `0700`，對話檔與設定檔（`hub.json`、`agents.json`、`settings.json`…）新建時是 `0600`。已經存在的資料夾或 `hub.json` 權限過寬（同機器的其他使用者讀得到）時，啟動日誌會警告並給出 `chmod` 指令；Hub 不會自己改既有的權限。
  - **仍然沒有登入失敗次數限制**：權杖靠長度保護（128 位元隨機值）。要長期對外，請在前面加上你自己的反向代理，並在那裡做限流。
  - 不用登入就能取得的只有：首頁與 `public/` 裡的 `css/`、`js/`（以白名單提供，其他檔案一律 404）、連接器腳本（`/bridge/*.mjs`）與兩個前端函式庫（`/vendor/`）；這些都不含祕密。
- **相依套件**：`npm audit` 目前回報 0 個漏洞（2026-10-27 檢查）。`dompurify`（前端清理 Markdown 的唯一防線）鎖在 3.4.17 以上，`body-parser` 鎖在 2.4.0 以上，都由 `package-lock.json` 固定，`test/dependency-security.test.mjs` 守著版本下限。`package.json` 標為 `private`，不會被 `npm publish` 誤發佈到 npm。
- **public 模式會開公網**：`npm run public`／`start-public.ps1` 會啟動 Cloudflare quick tunnel（免帳號）。任何知道那串隨機網址的人都連得到你的登入頁，**登入權杖就是唯一的保護**（沒有帳號系統、沒有登入失敗限流）；流量會經過 Cloudflare 的伺服器；網址每次啟動或重連都可能改變，舊網址隨即失效。啟動時印出的網址與連接指令**含有權杖與連接金鑰**，不要貼到公開的地方或日誌裡（通道自動重連時，腳本只印新網址，不會再印一次密碼）。腳本的暫存日誌裡有登入密碼，結束時會刪除。
  - **關閉**：按 `Ctrl+C`，中控台、通道與本機連接器一起停止。只想在本機使用就改用 `npm start`（不會開通道）。
- **API key 只存在你自己的機器上，不傳回瀏覽器**：Claude Console key 存在 `data/claude.json`，DeepSeek 閘道 key 存在 `data/deepseek.json`，權限都是 `0600`，寫入是原子的；檔案損壞時會備份並提示你重新輸入，不會無聲消失（見「[設定檔損壞時](#設定檔損壞時)」）。API 與畫面只會回傳尾碼，完整 key 不會傳回瀏覽器；對話事件、交接文字與錯誤訊息在輸出前會把已知的祕密（權杖、連接金鑰、各把 API key）遮罩。key 要被用到，所以也會經過已認證的連線交給需要它的連接器，存在那台電腦上（Claude：`~/.agent-hub/claude/claude.json`；DeepSeek：連接器的狀態檔 `~/.agent-hub/bridge.json`，同樣是 `0600`）。
- **連接器與連接金鑰的信任模型**：連接器只對外連線、不開任何埠；它把中控台位址與連接金鑰存在那台電腦的 `~/.agent-hub/bridge.json`（`0600`）。**連接金鑰要當密碼保管，只給你自己的電腦**：持有它的人可以連上 `/bridge`，用任意電腦 ID 登記新電腦、甚至取代已登記的電腦（中控台不把電腦 ID 綁定到金鑰上）；當連上來的電腦回報它有 Kimi 時，中控台會自動把**所有 DeepSeek 閘道的 API key**（號池）推給它，並隨後下發工作與 key。所以連接金鑰洩漏的後果，包含 DeepSeek 號池被讀走。反過來，**中控台（和持有登入權杖的人）**可以要求連接器在那台電腦上讀寫檔案、執行指令（權限模式「每次詢問／需要時詢問／全部自動」決定要不要先問你）。所以：只把連接金鑰給你自己的電腦，只把連接器連到你信任的中控台——連到別人的中控台，等於把那台電腦交給對方。連接器只讀 Kimi 的登入憑證（查用量），不會改它，也不會把它傳給中控台。
- **對話裡的 Markdown 圖片會載入遠端網址**（內容先經 DOMPurify 清理，但預設不擋外部圖片網址）：被提示注入的模型輸出可以藉由 `![](https://…)` 把對話片段帶到外部。處理來路不明的內容時要留意；設 `AGENT_HUB_CSP=strict`（見上）可以讓瀏覽器根本不載入遠端圖片。
- **Artifact 預覽**在沙盒 iframe 裡執行（沒有 `allow-same-origin`），頁面裡的腳本讀不到中控台的權杖。但頁面可以用 `window.agentHub.send()` 以你的名義對這個對話送出訊息（讓 agent 動作；有頻率與長度限制），或用 `fill()` 填入輸入框；它終究是 agent 產生的程式碼，不要在裡面輸入你的密碼，也不要預覽來路不明的頁面。

## 統一模型、接續對話與外觀

新對話只有一個首頁。輸入框旁的模型選單依 **Kimi／Claude／DeepSeek** 分組；新舊對話都能改選，不需要另外切「模式」。「設定」保存新對話預設使用的供應商、模型、思考強度與權限，三家各自的預設不會互相覆蓋。

- Kimi 使用那台電腦已登入的 Kimi Code；DeepSeek 使用原閘道 API key，也在 Kimi Code 裡執行；Claude 使用 Claude Console API key 與獨立背景程式。
- Kimi ↔ DeepSeek 在同一個 Kimi 原生對話裡切模型。切到 Claude、或從 Claude 切到 Kimi／DeepSeek 時，Agent Hub 建立接續節點並攜帶可讀歷史；側欄與對話頁仍是同一個聊天室。再切回來也會包含中間的新歷史，不會回到舊 context。
- 回合中改選不會改寫本回合；跨 runtime 的選擇會在這輪結束後生效，Hub 重啟也會保留待切換設定。模型或 key 不可用時明確報錯，不會偷偷改用另一家。

配色跟模型無關：左下角「⋯」選單的「外觀配色」可固定使用原本的 **Kimi 米色、Claude 近黑、DeepSeek 藍白**（Kimi 配色另有淺色、深色、跟系統一樣）。切對話、切模型、重新整理或開 Artifact 都不會自動變色。你自己切換配色或淺色／深色時，整個畫面會用瀏覽器的 View Transitions 交叉淡入，而不是一個個元素各自轉場，所以耗時不會隨對話變長而增加；瀏覽器不支援 View Transitions、系統設了「減少動態效果」、或分頁在背景時，就直接換過去，不做動畫。

畫面很窄的時候（手機，或側邊欄與面板都開著，聊天欄只剩 300～450 px），輸入框下方的晶片列（權限、模型、思考、子代理…）會換行，而不是橫向捲動把最後一顆切掉；太長的文字用刪節號縮短，完整內容在滑鼠停留的提示裡。模型名稱和供應商只講一次，例如「DeepSeek V4.1 Flash」，不會寫成「DeepSeek · DeepSeek V4.1 Flash」。

## 每對話的子代理預設

輸入框旁的「子代理」可指定這個對話之後新建子代理的供應商、模型與思考強度；已在跑的不切換。未明確自訂的新舊聊天室都預設 **DeepSeek V4.1 Flash + max**，不受主模型影響。卡片與「子代理」面板顯示實際模型、目前工具、步驟數、進度與完成／中斷／失敗狀態，不顯示內部工具或 broker 名稱。

Kimi／DeepSeek 主對話的 DeepSeek 子代理走 **Kimi 原生 `Agent`／`AgentSwarm`**：不注入 delegation token、不停用原生工具，也不另開主聊天室。機器上線或 key 更新時，connector 會配置 DeepSeek provider；若 Kimi 尚無 `[secondary_model]`，會寫入 V4.1 Flash 與 `default_effort=max`（不設 `force`）。這是該台 Kimi 的原生全域子代理預設，不是每對話獨立儲存。既有模型、思考強度、force 與描述都保留；換閘道時只修復失效的 DeepSeek alias，並確保預設模型在 pool 中可解析。Kimi 主模型、`default_provider` 與 `[thinking]` 不受影響。

Claude→Claude 使用原生 Task。其餘明確指定的跨供應商組合保留可選 broker，子對話沿用工作目錄與權限模式，工具、權限卡與結果都在 Hub 可見；不可用時明確報錯，不會偷偷改用主模型。broker 預設同步等待；`background: true` 可真正平行執行，完成結果送回父對話，忙碌時排隊，中斷後不自動喚醒。停止主對話也會停止 Hub 接管的 broker 子代理。

## 側邊欄

側邊欄只有兩個顯示分類；分類只影響顯示，不會刪除、複製、改寫或停止任何 session。

- **聊天室**：你在 Agent Hub 主動建立的對話（Kimi、Claude、DeepSeek、Hub 內 fork 與其跨 runtime 接續鏈）都在這裡，預設展開，整類依最後更新時間新到舊排序；同一條接續鏈只佔一列。
- **子session**：從終端機、`kimi web` 或其他 CLI／runtime 發現、且沒有 `parentId` 的外部 session 放這裡，預設摺疊並顯示數量；展開狀態會保存，搜尋時可暫時展開有結果的分類，不會改掉保存的設定。
- 真正的 `parentId` 子代理不會出現在側邊欄（包括「子session」），只存在父對話的「子代理」面板，顯示自己的工具步驟、權限、狀態與回報。直接開子代理的網址會標明這是子代理對話，並提供「開啟父對話」的導向（會對到父卡片），不會留下空白的子代理面板。

日期或釘選不再產生第三種同層分類；舊釘選資料不會被清空，但列表以「聊天室／子session」與更新時間為準。

**叢集的工作者不列在側邊欄**：一個叢集會開十幾個工作者對話，沒有人會在側邊欄找它們。側邊欄只留一列「叢集工作者 N 個」（連到叢集總覽；有工作者在等你核准時，這一列會亮「需要你」，頁面也照常跳通知）；要找某個工作者，在側邊欄搜尋它的名稱，搜尋結果會列出它；正在開著的工作者像任何開著的對話一樣列出來。工作者本身沒有少：從叢集頁點進去、用網址開，都跟以前一樣，打開時才載入它完整的內容。

**側邊欄的清單怎麼取**（2026-10-30 的效能修正）：頁面第一次要的清單是 `GET /api/sessions?for=sidebar`（不帶參數的 `GET /api/sessions` 完全沒變，每個對話照舊整份回）與 `GET /api/machines?for=sidebar`；側邊欄清單裡的對話摘要不帶那台電腦的模型清單、技能清單、訊息佇列與待辦清單（這幾樣是摘要裡最大的部分，打開對話時隨快照給），叢集的工作者只帶幾個欄位（`stub: true`），電腦的清單也不含工作者的 Kimi 對話。量測：`test/perf-sidebar-list.test.mjs`（100 個對話其中 60 個工作者的清單大小）、`test/perf-speed-over.test.mjs`（5 萬筆請求紀錄下算工作者速度與叢集總產出的耗時）。

**頁面只開著、什麼都沒看時，WebSocket 送什麼**：頁面在 `watch` 訊息帶 `slim: 1` 表示它看得懂精簡形式：電腦第一次整份送，之後只送變動的欄位與清單項目（`machine.patch`；線上電腦的 `lastSeen` 單獨變動不算變動）、叢集只送與上次相差的部分（`cluster.patch`，格式見 `public/js/json-patch.js`）、什麼都沒變就不送；叢集工作者的摘要只送給正開著那個工作者的頁面，其他對話的摘要送精簡版，只有開著的那個對話才收到整份。沒帶 `slim` 的頁面（舊頁面、工具）照舊每則整份。量測：`test/perf-idle-page.test.mjs`（15 秒內一個什麼都沒看的頁面收到的位元組數，精簡頁面與舊式頁面並排比較）。

完整設計與驗收規格在 [`docs/unified-models-spec.md`](docs/unified-models-spec.md)（開發記錄，寫給貢獻者看，一般使用者不需要讀）。

## Claude API

在統一模型選單選 Claude 就能直接對話。中控台用 Anthropic 官方 SDK 呼叫 Claude API（api.anthropic.com），**只用 Claude Console 的 API key**（`sk-ant-…`），依 token 從 Console 帳戶的額度扣款；不經過 Claude Code，也不會用 Claude Pro／Max 訂閱，訂閱帳號的登入 token（`sk-ant-oat…`）會被拒絕。

1. 到 [Claude Console → API Keys](https://console.anthropic.com/settings/keys) 建立一把 key。
2. 左下角「⋯」→「Claude API…」貼上 key 後儲存（中控台會先向 Anthropic 確認 key 有效；key 只存在 `data/claude.json`，不會傳回瀏覽器）。也可以改用環境變數 `ANTHROPIC_API_KEY`。

Claude 的對話由一個獨立的 **Claude 背景程式** 執行（跟 Kimi 的 `kimi web` 一樣）：在中控台這台電腦上由中控台啟動，在已連接的電腦上由那台的連接器啟動（連接器要 0.5 以上，舊的請在那台電腦重新執行連接指令）。中控台只是看和操控它的介面：關掉中控台、甚至關掉連接器，Claude 都照常做完，中控台再開時會補上這段時間的進度。工具（Bash、Read、Write、Edit、Glob、Grep、網路搜尋）在那台電腦上你選的資料夾裡跑。為了在中控台關掉時也能呼叫 API，API key 也會存一份在執行 Claude 的那台電腦上（中控台這台電腦在 `data/claude-daemon/`，已連接的電腦在 `~/.agent-hub/claude/`；檔案 `0600`、資料夾 `0700`，只有你的帳號能讀）。權限有「每次詢問／自動接受編輯／全部自動」和計畫模式。也支援待辦、提問、子代理、插隊、/compact、/undo、/fork、定時送出；輸入框旁顯示這個對話的估計花費與每次回應實際的模型，`/cost` 看明細與速率限制，`/budget 5` 設定花費上限（花到就先停）。預設模型 Claude Opus 5.5。只用你選的模型：如果回覆來自別的模型（例如被降級），或模型拒絕回答，這一輪會立刻停下、不執行它要的工具，對話裡寫明原因並跳出通知。背景程式本身重新啟動（例如更新）時，被中斷的那一輪會自動接著做。連接器 0.11.0 起會讀背景程式 `/health` 的 `capabilities`（`handoff`、`broker`、`subagent_config`）：已連接的電腦上若還在跑舊版背景程式（缺少這些能力）而且有對話正在執行，不會換掉它（會中斷對話），但電腦狀態會標示 `daemonStale` 與原因，用到子代理預設或接續歷史的新操作會被拒絕而不是被悄悄略過（停止、回答權限、讀取等不受影響）；等它閒置就自動換成中控台的版本。

## DeepSeek

在統一模型選單選 DeepSeek，對話就用 DeepSeek 模型，費用算在你的 DeepSeek 閘道 API key 上，**不用 Kimi 訂閱**。它不是另一套 agent：DeepSeek 對話就是那台電腦上 Kimi Code 裡的一般 Kimi 對話，只是模型換成 DeepSeek，所以 Kimi 的自動壓縮（用到約 85% 的 context 時）、reasoning 回放、子代理、計畫模式、插隊、待辦都照常運作。側欄有「DeepSeek」標籤；是否使用藍白外觀由使用者自己決定。

1. 左下角「⋯」→「DeepSeek…」加入 API key（選這把屬於哪個閘道）。所有閘道的 key 在同一份清單、依加入的順序使用：可以加入多把、刪除、重新啟用已用盡的 key；同一把重複貼上只保留一筆。「模型名稱來源」只決定新對話的模型清單取自哪個閘道。中控台加入前會先用該把 key 向閘道讀模型清單確認有效（只保留 DeepSeek 的模型；讀不到清單時用內建清單）。畫面只顯示尾碼；key 保存在中控台與需要它的受控 connector，完整 key 不會回傳瀏覽器。
2. 閘道：**OpenCode Go**（訂閱）、**OpenCode**（按量計費，原本的 Zen）、**Command Code**（要有含 API 存取的方案；Go 方案會被拒絕，`upgrade_required`）。預設模型是各閘道的 DeepSeek V4.1 Flash（沒有的話用清單裡的第一個），思考強度 low／high／max，預設 max；每個模型 1M context、最多 384k 輸出。
3. 在首頁選電腦和資料夾，和 Kimi 一樣；開第一個 DeepSeek 對話時，連接器（0.11.0 以上，舊的請重新執行連接指令）會在那台電腦的 Kimi 裡新增一個叫 `agent-hub-deepseek` 的模型來源，之後的對話直接用。中控台也會在連接器連上、Kimi 伺服器之後才啟動、或換 key 時補做這件事；失敗會以退避（5 秒、30 秒、2 分、10 分）重試，最近一次的結果與原因記在該電腦的狀態上（`provision`）。連接器會在該電腦開一個只聽 loopback 的 OpenAI 相容 proxy，Kimi 的模型來源指向它，Kimi 設定裡只放隨機的本機憑證、不放上游 key。因此使用這個號池 proxy 的 DeepSeek 對話需要那台電腦的連接器在線，proxy 才存在；Kimi 與 Claude 對話不依賴它。

**多把 key 與自動輪替**

- **key 怎麼分給對話：預設「平均分配」，可改回「接力」**（用戶 2026-10-29 裁示，因為多個叢集同時跑時 tok/s 變慢）：設定「DeepSeek…」→「key 分配方式」。**平均分配**＝每個對話（Kimi 每個請求的 `prompt_cache_key`，主代理與它的原生子代理是同一個）固定用一把 key；新對話分給「目前固定對話數最少」的那一把，同數時照清單順序。這樣每把 key 的負擔差不多，也保得住 DeepSeek 的前綴快取（快取綁帳號，請求在 key 之間跳來跳去就吃不到）。某把額度用完或被拒絕（401）時，只有固定在它身上的對話改分給下一把最少的可用 key（照原本的換家邏輯換網址、模型 id、標頭，還沒送出位元組就透明重送），其他對話不動；同一個對話同時在飛的幾個請求會一起跟到同一把新 key。沒有 `prompt_cache_key` 的請求照接力用「使用中」的 key。對應表只放在連接器記憶體：對話閒置超過 6 小時就忘掉（`AGENT_HUB_DEEPSEEK_STICKY_IDLE_MS` 供測試調整），連接器重啟後重新分配，只損失一次快取，對話 id 不寫進磁碟。**接力**＝原本的做法：所有對話共用「使用中」那一把，用完才換下一把。設定頁每把 key 顯示「目前 N 個對話」（各台電腦加起來，連接器回報；沒人回報過就不顯示，不顯示 0）；對話面板的「耗時」分頁顯示這個對話最近一個請求用的是哪一把（家別加尾碼，`GET /api/sessions/:id/timing` 的 `currentKey`）。連接器用 hello 的 `pool_sticky` 宣告做得到，中控台只對有宣告的連接器送分配方式；舊連接器一律接力，畫面寫「這台電腦的連接器太舊，只能接力」，重新執行連接指令更新後才會平均分配。沒有寫分配方式的號池（舊中控台）一律當接力。
- 目前這把 key 遇到額度用盡時，連接器會自動改用清單裡的下一把可用 key，不論它在 OpenCode Go、OpenCode 或 Command Code（用戶 2026-10-28 裁示）；換家時請求的網址、模型 id（OpenCode Go 的 `deepseek-v4.1-flash`、Command Code 的 `deepseek/deepseek-v4.1-flash`）與 session 標頭名稱（`x-opencode-session`／`x-session-id`，同一個值）一起換，Kimi 看到的仍是同一個模型來源與模型名稱。不會切到 Kimi、Claude 或另一個模型；這把 key 所在的閘道沒有這次要求的模型時，該把 key 直接跳過（不算用盡）。
- 只有在上游還沒送出任何回覆、且錯誤明確是額度／點數／餘額／用量上限用盡（HTTP 400、402、403、429，並由錯誤物件自己的 code／type／message 欄位明說：例如 400 `You have insufficient credits to make this request`、Command Code 的 `usage limit … resets at …`、`Monthly limit reached`、`CreditsError`；不是對整個回應內容找關鍵字）時才輪替。400／403 還要求訊息是在說帳戶（不是上游回聲你的請求內容，例如「Your request mentioned insufficient credits」），403 `upgrade_required`、`reasoning_content must be passed back` 這類 400、404、409、422、短暫 429 限流（每秒／每分鐘）、網路錯誤、逾時與 5xx 不會換 key。已經開始串流的請求不會重跑，避免重複文字、工具或檔案副作用。
- **閘道回 401（key 被拒絕）也會跳下一把，但它不是「額度用盡」**（用戶 2026-10-29 裁示：任何一把 key 收到 401 就跳到順序上的下一把）：上游回 401 而且還沒有送出任何位元組時，連接器把同一個請求用清單裡的下一把重送（跨家時同樣換網址、模型 id、標頭），對話看不到錯誤。這把 key 的狀態是獨立的「認證失敗（HTTP 401）」（`authFailedAt`、`authFailures`、`authRetryAt`），不是用盡、沒有重置時間，也不去讀 401 回應的文字。401 不會告訴我們何時恢復，所以不猜：距上次失敗 1 分鐘後，若沒有健康的 key 可用，由下一個真實請求去試它；再失敗一次間隔加倍（1、2、4……分鐘），最長 60 分鐘（`AGENT_HUB_DEEPSEEK_AUTH_RETRY_MS`、`AGENT_HUB_DEEPSEEK_AUTH_RETRY_MAX_MS` 供測試調整）。這只是探測的間隔，不是供應商給的重置時間。真實請求成功就清除並回報證據；設定頁「清除標記」或「重新啟用」可立即恢復。全部 key 都不能用時，錯誤訊息分開列出「認證失敗（HTTP 401）」「額度用完」「手動標記已滿」各幾把；只剩認證失敗時回 401 `upstream_auth_failed`，其餘仍是 402 `insufficient_quota`。連接器用 hello 的 `pool_auth` 宣告看得懂這組欄位，沒宣告的舊連接器不會被送這些欄位、中控台畫面照舊。
- 連接器對閘道有逾時：從送出請求到收到第一個內容位元組預設 120 秒（`AGENT_HUB_DEEPSEEK_FIRST_BYTE_MS`），串流開始後兩段資料間最久靜默 300 秒（`AGENT_HUB_DEEPSEEK_IDLE_MS`）；逾時回 504 `upstream_timeout`，不換 key。
- 同一台電腦的並行請求共用 key 狀態，但用失敗的 key id 比對，避免多個失敗請求一次跳過好幾把。不同電腦可以有各自實際使用中的 key，中控台顯示各機最近回報，不會強行把它們改成同一把。
- 全部 key 都用盡時會明確報錯：逐把列出家別與尾碼（不顯示 key）和狀態、最早已知的重置時間，以及現在要怎麼恢復，不會無限循環或假稱成功；加入、刪除與重新啟用都會更新並推到 online Kimi，讓原生 DeepSeek 子代理也能使用。
- **用盡的 key 會自己回來，但時間只採閘道明說的**：重置時間只來自 `Retry-After`、回應的重置欄位，或訊息明寫的時間（`resets at 2026-10-21T12:25:07.170Z` 要帶時區，小數秒也認得；`resets in 2 hours 15 minutes`；有多處取最後一處讀得出來的）。沒寫、沒帶時區、已過或離譜（超過 35 天）就記「到期未知」，不自己猜、不套固定窗口、不用用量估算；到期未知的 key 在沒有健康 key 可用時，由距上次標記至少 `AGENT_HUB_DEEPSEEK_RETRY_MS`（預設 30 秒，只是兩次探測的間隔，不是回升時間的推測）之後的真實請求去試。已知重置時間的 key 到時間後同樣由下一個真正的請求試它，這個請求本身就是探測（不另外送測試流量）。成功才清除標記，並向中控台回報「在用盡時間之後成功過」的證據；又遇到額度錯誤就重新計時。中控台只在三種情況清除用盡標記：連接器送來這個證據、較新 revision 的明確重置、設定頁「重新啟用」成功（會真的送一次很小的請求確認，不是只讀 `/models`）。另一台電腦的報告沒提到這把 key，不等於它健康，不會清除。
- **過了重置時間的 key 立刻回到輪替；限流（429）先借別把、再冷卻；中斷的回合 key 恢復後自動「繼續」**（2026-10-30 事故：三把 OpenCode Go 的重置時間早已過，卻因為一把一直被限流的 Command Code key 仍算「健康」而閒置一個多小時，十七個對話黏在那把上，被 429 打斷的工作者停在 error 沒人接）。
  - **重置時間一到就算可用**：供應商**明說**的重置時間（`retryAt`）一過，這把 key 就照一般 key 參與輪替（平均分配時算進「固定對話數最少」，接力時照清單順序），不必等其他 key 全掛；第一個真實請求就是確認（成功＝清除標記並回報證據，又收到額度錯誤＝用供應商這次給的新時間重新標記）。到期未知的 key 維持原本的探測規則，手動標記已滿的永遠不用。設定頁在這個時間點之後顯示「已到重置時間，待下一個請求確認」，不再顯示「已滿」。連接器以 hello 的 `pool_reset_due` 宣告；沒宣告的舊連接器在畫面該台電腦旁註明「過了重置時間的 key 要等其他 key 都用完才會被試」。
  - **選 key 的優先序**：①有額度且能用（含已過重置時間的）②不在限流冷卻中 ③在這些裡固定對話數最少 ④清單順序。
  - **限流（HTTP 429，不是額度類）**：請求收到 429 且還沒送出任何位元組給 Kimi，連接器立刻用依上述優先序挑出的另一把 key 透明重送同一個請求（跨家照舊換網址／模型 id／標頭）；對話仍固定在原本那把（保前綴快取、快取鍵不動），這只是「借用」。每把健康 key 最多各借一次，全都 429 才把最後那個 429（含它的 `Retry-After`）回給 Kimi。額度類 429 仍走「用盡」流程，不當限流。
  - **限流冷卻**：某把 key 最近 30 秒內限流類 429 ≥3 次（或 ≥5 個請求中比例 ≥20% 且至少 2 次）→ 冷卻 60 秒：固定在它身上的對話暫時借用別把健康 key、新對話不分給它，到期自動回來。冷卻結束後又立刻（一個窗長內）觸發，冷卻加倍，上限 10 分鐘；連續冷卻（中間沒有喘息）超過 5 分鐘，才把它身上一半最近最活躍的對話正式改分給別把（各在下個請求時，之後每滿 5 分鐘再來一次）。所有 key 都在冷卻或不能用時，照常用對話原本的 key（不能讓對話沒 key 可用），讓 Kimi 自己的退避處理。所有門檻都是連接器檔頭的常數（`AGENT_HUB_DEEPSEEK_RATE_*`，測試與調校用），只用實際計數，不估算。設定頁顯示「限流冷卻中（到 HH:MM:SS，最近 30 秒 N 次 429）」與每把 key 的借用／冷卻／重送成功失敗次數（連接器啟動以來、各台加總）；連接器的請求紀錄（`deepseek.requests`）多了 `borrowedFrom`、`borrowReason`。連接器以 hello 的 `pool_rate` 宣告。
  - **中斷的回合自動「繼續」**（設定「DeepSeek…」可關，預設開；`server/key-recover.js`）：DeepSeek 對話的回合因額度用完或限流而結束（看 Kimi 自己的錯誤碼 `provider.rate_limit`，以及額度錯誤的字樣；認證失敗、過載、斷線、一般失敗都不算），之後出現「結束當下還不可用」的 key（供應商給的重置時間到、清除標記、新增 key、冷卻結束、真實請求證明可用），Hub 就對那個對話送一次「繼續」並留一則說明「已在 key 恢復後自動繼續」。每個中斷的回合只送一次；它啟動的回合再失敗就不再自動送，直到有一個回合順利完成；只處理最近 2 小時內中斷的；叢集工作者與一般對話都適用，子代理、Kimi 訂閱與 Claude 對話不處理；有人先在該對話送了訊息就視為接手。狀態存在對話本身（`keyRecover`），Hub 重啟後接得回來。
- 舊 connector 只有一把 key 時可沿用原本的直連模式；同一個閘道加入第二把時會明確要求更新連接器（0.10.0 以上才有號池），不會靜默只使用第一把。連接器從 0.11.0 起在 hello 的 `capabilities` 宣告自己真的支援的能力（`pool`、`pool_cross`、`secondary_model`、`broker`、`handoff`、`pool_auth`、`pool_sticky`、`pool_reset_due`、`pool_rate`）；宣告 `pool_cross` 的連接器拿到整份跨家的清單，舊的 `pool` 連接器仍只拿「模型名稱來源」那個閘道的 key、只在那一家裡換；中控台只看這個欄位，不用版本字串猜，舊連接器沒有這個欄位就視為沒有。
- **耗時只記真的量到的（用戶 2026-10-21 裁示：不要自己模擬、計算）**：連接器的 proxy 對每個送往閘道的請求寫一筆紀錄（收到、送出的時刻，之後第幾毫秒收到標頭、第一個位元組、結束；狀態碼；用哪把 key 的 id；有沒有換 key；同一把 key 同時在跑幾個；串流結尾的 `completion_tokens`；Kimi 自己的重試次數；請求本文裡 `prompt_cache_key` 的 Kimi session id，Kimi 2.3.3 的子代理送的是同一個），回報給中控台，重連後整份再送，中控台用紀錄 id 去重；紀錄裡沒有 key。`GET /api/sessions/:id/timing` 把 Kimi 自己給的時間加起來（已結束回合的長度、每個步驟的首 token 延遲加串流時間、工具呼叫從發出到結果、壓縮、子代理因限流被重新排隊的等待），加上這個對話經 proxy 送出的請求數與 429 數；量不到的欄位是 `null`，原因寫在 `unmeasured`（進行中的回合、沒有計時的步驟、沒帶對話識別的請求、太舊的連接器都不會被猜），`since`／`requestsSince` 說明這些數字涵蓋從何時開始。`GET /api/deepseek/keys/timing` 給每把 key 的請求數、429 數、同時進行峰值、首位元組時間 p50／p95、tokens/s。連接器宣告 `pool_timing`（寫紀錄）、`pool_measure`（量並行上限）、`event_timing`（日誌的步驟事件帶計時）；舊連接器會得到 409「連接器太舊，重新執行連接指令更新」。
- **量並行上限只在你按鈕時才做**：DeepSeek 設定裡每把 key 有「量並行上限」，先問你並寫明會送出共 31 個極小請求、花少量額度；同意後中控台只告訴連接器 key 的 id（`POST /api/deepseek/keys/:keyId/measure`，必須帶和各級並行數總和相同的 `confirmedRequests`），由那台電腦依序以 1、2、4、8、16 個並行對這把 key 送請求，回每一級的成功數、429 數、其他失敗與延遲 p50／p95；key 值不離開那台電腦，量測不會把任何 key 標成用盡，第一級就被整個拒絕（401／402／403）會停下不送後面的。結果顯示在該 key 下，中控台記著最近一次。

**不會動到你的 Kimi 訂閱**

- 主模型仍是每個對話自己的 `agent_config.model`；切換或設定失敗不會把 DeepSeek 對話送到 Kimi 訂閱模型。
- 連接器只建立／替換／移除 `agent-hub-deepseek`，不碰 `managed:kimi-code`、`default_provider`、`[thinking]` 或主模型。原生子代理的 `[secondary_model]` 整張表不存在時才寫入 DeepSeek V4.1 Flash + max；表已存在（即使只有 `default_effort`）就是你的，不補、不覆蓋，只回報原因。設定子代理預設失敗只是警告，DeepSeek 主對話照常可用；既有模型、effort、force 與描述保留。修改 `config.toml` 時，無法確切讀懂或編輯的寫法（inline table、dotted key、array of tables）一律不動檔案並說明原因。換閘道只修復失效的 Hub alias 與 pool 引用，不改成其他模型。
- Kimi 在沒有全域主模型時，建立模型來源可能誤設新預設；connector 會先釘住訂閱模型，建立後再檢查並還原，找不到可保留的主模型就不建立。
- DeepSeek 對話不會自動暫停，也沒有「額度恢復後送出」（它們看的是 Kimi 訂閱的 5 小時額度）；定時送出照常可用。

**要知道的事**
- OpenCode 把 Kimi Code 列為沒有送 session 標頭、可能被限流的用戶端。連接器會請 Kimi 在 `agent-hub-deepseek` 這個模型來源加上固定的 `x-opencode-session`（Command Code 是 `x-session-id`）標頭，同一台電腦上都是同一個值；加不上時設定視窗會警告。
- key 會保存在中控台（`data/deepseek.json`，權限 `0600`）與受控 connector（bridge state，`0600`），只經已認證的 Hub→bridge 連線傳送；瀏覽器、提示詞、子代理 token、URL、log 與錯誤訊息都不含完整 key。新 connector 的 loopback proxy 只把目前上游 key 換進請求，Kimi 的 `config.toml` 只放隨機本機憑證，不再放整組上游 key；舊 connector 的單 key 直連模式仍可能把該把 key 放進 Kimi 的模型來源設定。移除 key 時中控台會一併從連到的電腦上移除。換閘道之後，舊的 DeepSeek 對話可在統一選單重新選模型。

## GitHub

Claude 和 Kimi 都用 git 與 GitHub CLI（`gh`）操作 GitHub：clone、開分支、push、開 Pull Request、看 Issue 和 Actions。每台電腦登入一次就好：左下角「⋯」→「GitHub…」，選「用瀏覽器登入」（顯示一組代碼，到 github.com/login/device 輸入），或貼上一個 token。登入資料只存在那台電腦的 `gh` 裡，中控台不保存；登入後 git 也會用這個帳號 push（`gh auth setup-git`），commit 沒有設定署名的話會用帳號名稱與 GitHub 的 noreply 信箱。

那台電腦要先裝好 `gh`（Kali／Debian／Ubuntu：中控台「GitHub…」裡會顯示加入 GitHub 官方 apt 套件庫再安裝的指令（Kali 的套件庫沒有 gh），macOS：`brew install gh`，Windows：`winget install --id GitHub.cli`），連接器要 0.6 以上。連接器也會幫 Kimi 裝一個 `/github` skill；Claude 的系統提示裡有同樣的規則：會改到 GitHub 的動作（push、開 PR、留言）沒被要求就先問你，在新分支上工作，不 force push，也不在對話裡要 token。

### Claude 開出的其他對話

叫 Claude「再開兩個對話跟你對抗」之類的，它會用 `StartConversation` 在 Agent Hub 裡開新的 Claude 對話（可以指定模型與思考強度），一樣用 Claude API key 計費、出現在側邊欄，你可以點進去看或直接跟它講話；Claude 用 `ReadConversation` 讀它們的回覆、`MessageConversation` 傳話給它們。Claude 不能從 Bash 啟動 Claude Code（`claude` 指令）或其他 AI 工具，這種指令會被擋下。側邊欄會列出每台連線電腦上所有的 Claude API 對話（包括 Claude 自己開的、中控台關著時開出的），跟 Kimi 一樣：中控台啟動時會叫起這台電腦有對話的 Claude 背景程式，連接器連上時也會回報那台電腦有幾個 Claude 對話，中控台不知道的就接過來。在中控台刪掉的對話不會再被接回來（那台電腦離線時刪的，等它連上再刪掉）。

### Claude 對話綁定 GitHub repo

在 Claude 首頁的資料夾選單選「綁定一個 GitHub repo…」，挑一個 repo（列出這台電腦的 GitHub 帳號能 push 的 repo，也可以直接輸入 `owner/repo`），再選「開一個新分支」（`claude/日期-編號`，跟 Claude Code 網頁版一樣）或指定分支（例如 `main`）。新對話開始時會把 repo clone 到那台電腦上的新資料夾、切到那個分支，之後：

- 綁定存在對話裡，也寫在 Claude 的系統提示裡，壓縮對話或重新啟動都不會忘記；對話上方和輸入框會顯示 `owner/repo · 分支`。
- 系統提示要求高度紀律：小而清楚的 commit、push 前跑測試、不 commit 機密、不改寫已 push 的歷史。
- 每一輪結束時 Agent Hub 都會檢查：還有沒 commit 或沒 push 的變更，就提醒 Claude 處理（最多兩次）；它還是沒處理，Agent Hub 自己 commit 並 push 到那個分支。
- push 到其他分支、force push、刪除遠端分支、改 remote 的指令會直接被擋下。

已經開著的 Claude 對話也能綁定：對話右上「⋯」→「綁定 GitHub repo…」。資料夾本來就是那個 repo 的 clone 的話留在原地、切到選的分支；不是的話把 repo clone 到新資料夾，對話改到那裡工作（舊資料夾不動），下一輪 Claude 會先把屬於這個專案的檔案搬進 repo、commit 並 push。綁定規則會寫進 Claude 的系統提示（下一輪要重新讀一次整段對話，一次性多花一些 token），綁定後不能再換。

綁定的 repo 會記在首頁，之後在同一台電腦開的 Claude 新對話也會綁定它（每次一個新分支），直到你在選單裡選「不綁定」。私人 repo 和 push 都需要那台電腦先在「GitHub…」登入。

### Kimi 對話綁定 GitHub repo

Kimi 也一樣：Kimi 首頁的資料夾選單選「綁定一個 GitHub repo…」，或已經開著的 Kimi 對話右上「⋯」→「綁定 GitHub repo…」。跟 Claude 不同的地方（Kimi 的 agent 是 Kimi Code 自己在跑，Agent Hub 改不了它的系統提示、也攔不到它自己執行的指令）：

- 規則跟著第一則訊息一起給 Kimi，之後每次提醒也會附上；Kimi 壓縮對話後忘了也沒關係，每一輪結束的檢查（提醒兩次、再不行 Agent Hub 自動 commit 並 push）照樣有效。
- 已經開著的對話：資料夾不是那個 repo 的話，repo 會 clone 到對話資料夾裡的子資料夾（Kimi 的對話不能換資料夾），綁定後馬上傳一則訊息請 Kimi 把檔案搬進去並 push（會用掉一輪）。
- 推到其他分支、force push、改 remote 的指令：Kimi 先問你要不要執行時會自動拒絕；全部自動（yolo）模式下 Kimi 不會先問，這一項就擋不了。

## Google Drive 備份（/backup）

在 Claude 或 Kimi 對話裡輸入 `/backup`（或對話右上「⋯」→「備份到 Google Drive」），中控台就用 [rclone](https://rclone.org) 把那個對話的專案資料夾備份到你的 Google Drive：

- `Agent Hub 備份/<電腦>/<資料夾>/最新/`：跟本機一樣的一份（本機刪掉的檔案這裡也會刪）；
- `Agent Hub 備份/<電腦>/<資料夾>/每日快照/<日期>.tar.gz`：每天一個壓縮檔，保留最近 30 天。

.gitignore 排除的檔案、`.git`、`node_modules`、虛擬環境和快取不會備份。備份是中控台自己在那台電腦上執行的，不經過 Claude 或 Kimi，不花 token。

每台電腦要先裝 rclone（Kali／Debian：`sudo apt install rclone`），再到左下角「⋯」→「Google Drive 備份…」登入 Google 一次：「用瀏覽器登入」的網址要在那台電腦上的瀏覽器打開；不在那台電腦前面的話，在任何有瀏覽器的電腦執行 `rclone authorize "drive"`，把印出的 token 貼進去。登入資料只存在那台電腦的 rclone 設定裡。

## 連接其他電腦

在那台電腦執行中控台印出的連接指令（左下角「連接電腦…」也看得到）。之後那台電腦的 Kimi 對話會自動出現；從終端機或外部 CLI 開的對話會放在「子session」。

**連接金鑰怎麼傳**：啟動腳本印出的「其他電腦要連上」指令，是用環境變數把連接金鑰交給連接器，所以金鑰不會出現在那台電腦的行程列表（`ps`）裡。Linux／macOS：

```bash
curl -fsSL https://xxxx.trycloudflare.com/bridge/agent-hub-bridge.mjs -o agent-hub-bridge.mjs && AGENT_HUB_BRIDGE_KEY=bk_你的連接金鑰 node agent-hub-bridge.mjs --hub https://xxxx.trycloudflare.com
```

Windows（PowerShell）：

```powershell
Invoke-WebRequest -UseBasicParsing https://xxxx.trycloudflare.com/bridge/agent-hub-bridge.mjs -OutFile agent-hub-bridge.mjs; $env:AGENT_HUB_BRIDGE_KEY = 'bk_你的連接金鑰'; node agent-hub-bridge.mjs --hub https://xxxx.trycloudflare.com
```

金鑰仍會留在那個終端機的指令歷史裡，用完可以清掉。有兩個地方不是這樣，要知道：網頁「連接電腦…」視窗給的指令**仍把金鑰寫在 `--key` 參數上**，那台電腦上的其他使用者用 `ps` 看得到，共用的電腦請改用上面的寫法；另外，用下面的 `kimi-hub` 啟動 Kimi 時，如果背景的連接器沒在跑，包裝指令會用 `--key` 參數把它拉起來。

終端機裡的 Kimi 和 Hub 可以同時操作同一個對話，不需要先輸入 `/web`、解除唯讀或改用 `kimi-hub`。Hub 會依操作當下的 terminal 狀態選路：對話確實在 terminal 且可控時，輸入走既有的 TUI；不可控或狀態不明時，送出、改模型／思考強度／權限、停止、回答權限與問題、指令與移到背景都走 Kimi Server API，不會偷偷打進終端機；畫面也不再顯示唯讀標籤或解鎖按鈕。兩種方式可能互相覆蓋狀態或寫入，這是你已接受的雙寫風險；Hub 不會每次操作再跳確認。

`kimi-hub` 仍保留，但不是從 Hub 操作終端機對話的前提：

```bash
echo "alias kimi-hub='node ~/.agent-hub/agent-hub-bridge.mjs kimi'" >> ~/.zshrc && source ~/.zshrc
```

## 開啟長對話：視窗與分頁

打開對話時，Hub 只送這個對話**最新的一段視窗**，不是整份歷史：最近 6 個回合、至多 300 KB、至多 500 個事件，哪個先到算哪個（最新一個回合會盡量完整，上限 1 MB／800 事件）。快照帶 `window: { total, firstIndex, hasEarlier }`（序號沿整條接續鏈計算）；更早的事件用 `GET /api/sessions/:id/events?before=<firstIndex>&limit=<n>` 一頁一頁取（`beforeId=<事件 id>` 可在歷史有移位時代替序號）。視窗內單一欄位超過 16 KB（工具輸出、思考、Write 的內容…）送出時改成 4 KB 預覽並標 `truncated: { bytes, field }`，完整內容用 `GET /api/sessions/:id/events/:eventId?full=1` 取；只有送出時截斷，存檔不動，也不截仍在進行中（running／pending）的事件與寫給 Artifact 面板的 `.html`。`GET /api/sessions/:id?window=all`、WebSocket `watch` 帶 `window: 'all'` 仍給整份歷史（工具用）。API 的大 JSON 回應與頁面的 WebSocket 都會壓縮（gzip／permessage-deflate，1 KB 以下不壓）。

視窗只含最近的事件，但 **Artifact 面板要列出這個對話做過的所有頁面**：`GET /api/sessions/:id/artifacts` 回傳整條接續鏈上每一次寫／改 `.html` 的事件清單 `{ artifacts: [{ path, eventId, ts, kind, status, append?, title? }], total }`（`total` 是整條接續鏈的事件總數，不是頁面數；只有索引，沒有頁面內容；判斷哪些事件算 Artifact 的規則與頁面共用同一份 `public/js/artifact-rules.js`，不是兩份拷貝）；某個版本的內容用 `GET /api/sessions/:id/artifacts/:eventId` 取（Hub 依整條歷史重放，`{ path, eventId, html }`，無法推得時 `html` 為 `null`，頁面再退回讀磁碟上的檔案）。

視窗外還有頁面自己算不出來的東西，所以快照另帶 `outside`（只有視窗不是從頭開始時才有；`window` 本身的欄位不變）：`question` 是視窗之前最近一則使用者訊息（`id`、`ts`、前 600 位元組的文字，用來讓「目前問題置頂」在問題不在視窗內時仍指得出問題、讓忙碌計時從那則訊息起算），`ancestors` 是視窗內事件所屬、卻比視窗更早的卡片（子代理的步驟在視窗內、卡片在視窗外），對話忙碌時還會帶上每一張仍在工作的子代理卡（不論它的步驟在不在視窗內），依事件順序、最多 50 張，每張帶 `stepsBefore`（它有幾個工具呼叫落在視窗之前）。沒有這些，子代理的步驟無處可放、「N 個在工作」少算、卡片上的步驟數也只算已載入的。

數字可用環境變數調整：`AGENT_HUB_WINDOW_TURNS`、`AGENT_HUB_WINDOW_BYTES`、`AGENT_HUB_WINDOW_EVENTS`、`AGENT_HUB_WINDOW_LATEST_BYTES`、`AGENT_HUB_WINDOW_LATEST_EVENTS`、`AGENT_HUB_PAGE_EVENTS`、`AGENT_HUB_PAGE_MAX_EVENTS`、`AGENT_HUB_PAGE_BYTES`、`AGENT_HUB_WINDOW_ANCESTORS`、`AGENT_HUB_QUESTION_BYTES`、`AGENT_HUB_FIELD_LIMIT`、`AGENT_HUB_PREVIEW_BYTES`、`AGENT_HUB_LIVE_TAIL`。

## 對話檔損壞時

對話檔寫到一半當機（磁碟區塊被零填滿、檔案被截斷）時，Hub 不會悄悄丟掉它：原檔先原封不動備份到 Hub 資料夾的 `sessions-damaged/`，能修的移除損壞區段後載入（對話標 `meta.salvaged`，裡面有 `reason`、`removedBytes`、`backup`、`unsaved`…），修不了的列在 `GET /api/damaged-sessions`（`salvaged: false`）。網頁上：被修復的對話在側欄與對話頂部有「曾損壞並已修復」徽章，滑過去看原因與約損失多少；原檔備份或把修復結果寫回原檔沒成功時，另標「尚未寫回原檔」（原檔這時沒被改動，下次存檔才會寫成乾淨的版本）；完全載不進來的檔案在側欄頂出現「N 個對話檔損壞無法載入」橫幅，展開看檔名、原因與備份位置（備份在跑 Hub 的那台機器上），可按 × 暫時關閉，之後只有清單變了（出現不同的損壞檔）才會再提醒。

## 設定檔損壞時

Hub 啟動時讀進來的三個小檔案，現在不會在讀不進來時悄悄重來：

| 檔案（都在 `data/`） | 裡面是什麼 | 損壞時的後果 |
| --- | --- | --- |
| `hub.json` | 登入權杖與連接金鑰 | 重新產生這兩把（環境變數指定的不重產），**所有已連接的電腦要用新的連接指令重新連接**（網頁左下角「連接電腦…」），登入也要改用新的權杖。 |
| `machines.json` | 已登記的電腦清單 | 這次清單是空的；各台電腦的連接器連上來時會再登記一次。 |
| `claude-deleted.json` | 已在 Hub 刪除的 Claude 對話清單 | 這次清單是空的；以前刪掉的對話，如果 Claude 背景程式那邊還留著，可能重新出現在側欄，需要再刪一次。 |

「損壞」指檔案是空的、被截斷、全是 0 位元組（內容沒真的寫到磁碟）、不是合法的 JSON，或最外層的型別不對。遇到時 Hub 會：

1. 把原檔**原封不動**備份到 `data/damaged-config/<檔名>.<毫秒時間戳>`（資料夾 `0700`、檔案 `0600`；同樣的內容不會重複備份，也不會蓋掉先前的備份）；
2. 在啟動日誌用中文警告：哪個檔案、為什麼、備份在哪裡、接下來會發生什麼；
3. 才繼續用新的內容啟動。環境變數 `AGENT_HUB_TOKEN`、`AGENT_HUB_BRIDGE_KEY` 都指定了的話，`hub.json` 根本用不到，Hub 不產生新的，也不改寫它。

檔案「讀不到」（權限不對、它其實是個資料夾…）和「損壞」不一樣：Hub 不知道裡面是什麼，可能還好好的，所以不動它。`hub.json` 讀不到、或損壞卻沒能先備份，而環境變數又沒把兩把都指定時，Hub **拒絕啟動**並說明原因，不會產生新的權杖蓋掉它。`machines.json` 與 `claude-deleted.json` 遇到同樣的情形時，這次只是不寫入它們，原檔留在原處。

**金鑰與其他設定檔**（`claude.json`、`deepseek.json`、`agents.json`、`settings.json`）同樣是「寫到一半被中斷也不會留下半截檔」的原子寫入，損壞時同樣先備份到 `data/damaged-config/`、在啟動日誌警告，而且**在你明確重新輸入之前，不會把損壞的檔案改寫成空的**：

- Claude API key 或 DeepSeek 金鑰池讀不進來時，對應的設定對話框頂端會出現紅色提示，說明檔案損壞與備份位置，請你重新貼上 key 或從備份還原；這期間相關功能會回報「檔案損壞」，而不是假裝「還沒有設定 key」。`GET /api/claude`、`/api/deepseek`、`/api/config` 的回應會多一個 `damaged` 欄位。
- 與金鑰無關的設定變更，在金鑰檔還沒處理之前會回 409，不會順手把壞檔蓋掉。只有「你明確重新輸入／儲存」才會取代它，而且前提是備份已經存在、磁碟上的檔案還是當時備份的那一份。
- 「讀不到」的檔案（權限不對、它其實是個資料夾…）在任何情況下都不會被改寫。
- 連接器自己的狀態檔（`bridge.json`，含 DeepSeek 閘道 key 與這台電腦在中控台的代號）也是原子寫入、權限 `0600`；損壞時先複製成同資料夾下的 `bridge.json.damaged-<內容雜湊>`（同樣的損壞只存一份）再重新產生。重新產生後，中控台會把這台電腦當成新電腦：要保留舊代號，請從備份抄回 `ids`。

## 自動暫停與定時送出

都由中控台執行，關掉網頁也照常運作，重開中控台也會保留。

- **自動暫停**（對話右上角「…」→「自動暫停…」，或 `/autopause 90`）：Kimi 工作時，5 小時額度用到設定的 % 就在對話裡插隊送出「優雅暫停」；5 小時額度恢復後送出「繼續」。每個 5 小時視窗最多暫停一次；暫停期間如果有人又讓 Kimi 開始工作，就不會自動送「繼續」。Kimi 自己開的那一輪（例如背景子代理做完後它接著處理）Kimi 不接受插隊，這時「優雅暫停」會顯示「等待插隊」：中控台每 2 秒再試一次，有新的一輪開始也立刻再試，最晚在這一輪結束時第一個被 Kimi 讀到；不會中斷 Kimi 正在做的事。Kimi 接受插隊後，要等目前這一步做完才會讀到；如果這一步是在等前景的子代理或跑很久的指令，「優雅暫停」被接受 10 秒後還沒被讀到，中控台會把主對話在前景等的工作移到背景（跟 Kimi 的 Ctrl+B 一樣，工作會繼續跑），讓 Kimi 馬上讀到。只對「優雅暫停」這樣做，平常的子代理不會被移動；終端機裡的 Kimi 也適用，不會因為對話在 terminal 而停用自動暫停。
- **移到背景**（Kimi 在等前景的子代理或指令時，輸入框旁的「移到背景」按鈕、輸入框裡按 Ctrl+B，或 `/bg`）：跟 Kimi 的 Ctrl+B 一樣，把前景的子代理和指令改到背景繼續跑，Kimi 不用再等它。終端機裡的 Kimi 也可以（不可控時走 Server API）。
- **額度恢復後送出**（點輸入框旁的 context 圓圈 →「額度恢復後送出「繼續」」，或 `/later reset 繼續`）：你已經自己讓 Kimi 停下時用。等 Kimi 停下、5 小時額度確實恢復後送出。
- **定時送出**（「…」→「定時送出…」，或 `/later 30 繼續`、`/later 15:30 繼續`）：幾分鐘後或指定時間送出一則訊息。Kimi 正在工作時，會排在這一輪之後。

### 方案用量一直是 0%

Kimi 的用量回應裡同時有百分比（`usages.limit_5h.used_ratio`…）和已用次數（週額度的 `usage`、5 小時視窗的 `limits[]`）。Kimi Code 只看百分比，而這個百分比常卡在 0（[kimi-code#3817](https://github.com/MoonshotAI/kimi-code/issues/3817)、[#3908](https://github.com/MoonshotAI/kimi-code/issues/3908)、[#3951](https://github.com/MoonshotAI/kimi-code/issues/3951)、[#4133](https://github.com/MoonshotAI/kimi-code/issues/4133)），所以 Kimi 終端機的 `/usage` 和網頁版也顯示 0%。中控台會另外讀同一份回應裡的次數：同一個視窗（重置時間相同）兩者不一致時取較高的那個（滑鼠移到用量條上會顯示 Kimi 原本回報的百分比和次數）；自動暫停也照這個數字判斷。

讀法：連接器用 Kimi 存在 `~/.kimi-code/credentials/` 的登入，向 Kimi 自己用的網址（`api.kimi.com` 或 `api.kimi.ai`）要同一份用量。只讀不寫、不換發登入，登入資料不會送到 Kimi 以外的地方，也不會傳給中控台；回應的重置時間和 Kimi 剛回報的對不上（不是同一個帳號）就不採用。如果 Kimi 沒附次數，畫面會照 Kimi 的數字顯示，這時請以 Kimi 網站會員頁為準。

## 疑難排解

- **`Node.js 版本太舊`**：安裝 Node.js 22 以上再重跑。
- **`listen EADDRINUSE`（埠被占用）**：8787 已被別的程式使用。換一個埠：`PORT=8788 npm run public`（或 `PORT=8788 npm start`）；Windows 先執行 `$env:PORT = '8788'` 再跑腳本。
- **公網通道建不起來或中斷**：中控台不受影響，腳本會以 1 → 30 秒的退避自動重連，重連後的新網址印在終端機（舊網址已失效）。`cloudflared` 下載失敗，或訊息說 **SHA-256 不符**（下載的檔案已被刪除、沒有執行；可能是下載被竄改或網路被攔截）時，自行安裝（例如 macOS：`brew install cloudflared`）並放進 `PATH`，腳本會優先使用它；詳見「[cloudflared 怎麼來的](#cloudflared-怎麼來的)」。
- **Hub 一啟動就停下，說 `AGENT_HUB_TOKEN=none` 不能搭配這個位址**：`none` 關掉登入，只允許 `HOST` 是 `127.0.0.1`、`::1`、`localhost`。拿掉 `AGENT_HUB_TOKEN=none`（Hub 會自己產生密碼），或把 `HOST` 設回 `127.0.0.1`。
- **從反向代理、自訂網域或另一個位址開網頁，頁面載得出來，即時更新卻一直沒有**：`/ws` 被來源檢查擋成 403。讓代理帶 `X-Forwarded-Host`，或把你實際開網頁的來源列進 `AGENT_HUB_ALLOWED_ORIGINS`（例如 `AGENT_HUB_ALLOWED_ORIGINS=https://hub.example.com`），見「[資安與信任模型](#資安與信任模型)」。
- **啟動時警告「資料夾權限過寬」**：`data/`（或 `data/hub.json`）的權限讓同一台電腦的其他使用者讀得到對話紀錄與登入權杖。Hub 不會自己改既有的權限；照警告裡的指令 `chmod 700 "<data 資料夾>"`（`hub.json` 是 `chmod 600`）收緊。
- **啟動日誌說某個設定檔損壞**：`hub.json`、`machines.json` 或 `claude-deleted.json` 讀不進來，原檔已備份在 `data/damaged-config/`；後果與處理見「[設定檔損壞時](#設定檔損壞時)」。
- **Docker 一啟動就 `EACCES: permission denied, mkdir '/data/sessions'`**：bind mount 的資料夾不屬於 uid 10001。`chown 10001:10001` 那個資料夾再啟動。
- **Artifact 預覽沒有反應（頁面的腳本不執行）**：你設了 `AGENT_HUB_CSP=strict`，嚴格版政策不讓 Artifact 的行內腳本執行；拿掉這個環境變數就恢復。
- **忘了登入密碼／畫面要求登入**：密碼印在啟動時的終端機（Docker 用 `docker logs`）；沒有用 `AGENT_HUB_TOKEN` 自己指定的話，也在 `data/hub.json` 的 `token`。用含 `#token=…` 的網址開啟，或在登入畫面貼上。
- **「連接器太舊」或電腦狀態出現 `daemonStale`**：那台電腦的連接器或 Claude 背景程式比中控台舊。在那台電腦重新執行左下角「連接電腦…」顯示的指令（會重新下載連接器）。0.11.0 以上的連接器才會宣告號池、子代理預設、接續歷史等能力；舊的背景程式在有對話執行時不會被換掉，閒置後自動更新。
- **對話檔損壞**：中控台啟動時會在輸出裡警告無法載入或已修復的對話檔（用 `npm start` 直接看得到；`npm run public` 把輸出存在暫存日誌裡）。能備份的原檔都會原封不動放在 `data/sessions-damaged/`；修復成功的對話裡會有一則說明移除了多少位元組。完整清單：`GET /api/damaged-sessions`（需要登入權杖）。
- **Kimi 未登入或登入失效**：對話裡會出現「Kimi 還沒有設定模型或登入」、「登入憑證不見了／被拒絕」之類的訊息，在**那台電腦**執行 `kimi login`。`kimi` 不在 `PATH` 時，用連接器的 `--kimi-bin <路徑>`（或環境變數 `AGENT_HUB_KIMI_BIN`）指定。
- **本機的 Kimi 對話沒有出現**：啟動腳本在找不到 `kimi` 時會印「略過本機連接」，或你把 `NO_BRIDGE` 設成了 `0`／`false`／`no`／`off`／空字串以外的值（例如 `1`）；安裝並登入 Kimi Code 後重跑，或在「連接電腦…」複製連接指令手動連接。
- **輸入框顯示「實際：…」與你選的模型不同**：原生對話實際在用的模型被別處改過（模型飄移）；按「改回」即可，進行中的回合不受影響，下一回合生效。
- **DeepSeek key 顯示已用盡**：用盡的 key 會在等待時間後由下一個真實請求自動探測；也可以在設定頁「重新啟用」。
- **`npm run check` 說找不到 `esbuild`**：`npm run public` 只安裝執行所需的套件（`--omit=dev`），而且在你用完整的 `npm ci` 裝過之後再執行它，會把開發相依套件拿掉。要開發或跑檢查請先 `npm ci`。

## 開發與測試

```bash
npm ci                  # 完整安裝（含 esbuild 等開發相依套件）
npm run check           # 逐檔語法檢查 + 連接器內建的 Claude 背景程式（bridge/claude-daemon.mjs）是否與原始碼同步
npm test                # node --test，同時跑 2 個測試檔
node --test test/store.test.mjs   # 只跑一個測試檔
```

- **`npm run build:daemon`**：改了 `server/claude-daemon.js` 或它 import 的檔案之後，用 esbuild 重建 `bridge/claude-daemon.mjs`（連接器下載來執行 Claude 的單一檔案），並**一併提交**；這是生成物，不要手改。`npm run check:bundle`（`npm run check` 也會跑）會在重建結果與已提交的檔案不同時失敗。
- **`node scripts/sync-bridge-github.mjs`**：改了 `server/github.js` 之後，把它同步到連接器裡的副本（`--check` 只檢查不改）。
- **測試環境**：測試會在 `127.0.0.1` 開本機埠，並使用假的 AI 閘道、假的 Kimi 與假的 `cloudflared`；不需要真實的 API key、帳號或外網。
- **需要真 Kimi CLI 的測試**（`e2e-kimi-bridge`、`e2e-unified-broker`、`bridge-real-kimi-deepseek`）：用 `KIMI_BIN` 指定，沒設就找 `PATH` 上的 `kimi`；找不到時這些測試**略過**並在 stderr 說明原因。這三組測試把 `HOME` 與 `KIMI_CODE_HOME` 指到暫存資料夾，不會讀寫你自己的 Kimi 登入與設定，但仍會啟動真的 `kimi`。`REQUIRE_KIMI=1` 會把「找不到」改成失敗。例如：`KIMI_BIN=/path/to/kimi npm test`。其中使用 `AgentSwarm` 的幾個測試在部分 Kimi 版本或環境下會逾時（已知）。
- **瀏覽器測試**需要 Chromium：`PATH` 上找 `chromium`／`chromium-browser`／`google-chrome`，或用 `CHROMIUM_BIN`（`CHROME_BIN` 亦可）指定；沒有就略過。**Windows 啟動腳本的測試**需要 `pwsh`（PowerShell 7），沒有就略過。**Docker 映像的真實建置測試**預設略過：`AGENT_HUB_TEST_DOCKER=1 node --test test/docker-hardening.test.mjs`（需要執行中的 Docker，會下載基底映像與相依套件）。
- **相依套件**：`npm audit` 應該是 0 個漏洞；`test/dependency-security.test.mjs` 守著 `dompurify`、`body-parser` 的版本下限，並在真實瀏覽器裡確認 Markdown 清理仍然擋得住注入。`package.json` 的 `engines.node` 是 `>=22`、`private` 是 `true`（避免誤發佈到 npm），`test/package-metadata.test.mjs` 守著這兩項與各處寫的 Node 版本一致。
- **效能量測**：`node scripts/perf-ui.mjs`（真實 Chromium 裡量切換、拖曳、捲動）、`scripts/measure-payload.mjs`、`scripts/measure-save.mjs`；用法見各檔開頭的說明。
- **重拍 README 截圖**：`node scripts/take-screenshots.mjs`（用拋棄式 Hub 與完全虛構的示範資料，在真實 Chromium 裡拍；頁面上若出現本機路徑、權杖或非保留網域的信箱會整個中止、不寫任何檔；`--out DIR` 指定輸出資料夾）。
- **測試不該留下行程**：測試會啟動 Hub、假的 `node`／`cloudflared`、瀏覽器；沒收乾淨的話它們會在你的電腦上一直跑（Claude 背景程式本來就設計成比 Hub 活得久，所以只關 Hub 不夠）。`npm test` 結束時會檢查，並在有殘留時印出警告與處理指令；平常也可以隨時看：`node scripts/check-leaks.mjs`（只讀，不殺行程）。要清掉殘留：`node scripts/check-leaks.mjs --kill-mine` 只結束上一次 `npm test` 期間產生、確定屬於它的行程；`--kill-stale` 結束暫存資料夾已被刪除的殘留；來源不確定的一律不動。寫新測試時，啟動 Hub 就用 `test/browser-harness.mjs` 或 `test/fixtures/real-hub.mjs` 的 `stop()`（已處理好順序），自己 `spawn` 的話在 `after` 裡呼叫 `test/fixtures/stop-daemons.mjs` 的 `stopHubAndDaemons()`／`stopDaemons()`（依 `--dir` 找行程，不用 `pkill -f`），並用 `test/fixtures/leak-guard.mjs` 的 `assertNoLeaks()` 斷言沒有殘留。

## 授權

[MIT](LICENSE)
