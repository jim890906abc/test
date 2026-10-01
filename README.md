# Agent Hub：多家 coding agent 的網頁中控台

在瀏覽器裡用同一個介面操控各家 coding agent，版面參考 Claude Code 網頁版。主打功能：**在公網的中控台裡，接管你每一台電腦上的 Kimi Code 對話**（訂閱制可用）。

- 介面預覽（模擬資料）：https://claude.ai/artifact/3TnExCg1NUnBjz43psKJ1U
- 預覽頁可以用 `npm run preview` 重新產生

![權限請求](docs/screenshots/permission.png)

## 運作方式

```
手機 / 電腦瀏覽器 ──HTTPS──▶ 公網中控台（Hub）
                                  ▲ 連接器主動連出（不用開 port，NAT 後面也行）
              ┌───────────────────┴───────────────────┐
         [筆電] 連接器 ⇄ kimi web            [公司桌機] 連接器 ⇄ kimi web
         （用這台的 Kimi 帳號）               （用這台的 Kimi 帳號）
```

- **中控台不需要登入 Kimi。** Kimi 只登入在你自己的電腦上（`kimi login`，可以用訂閱帳號）。中控台透過每台電腦上的「連接器」，呼叫 Kimi Code 官方的 Server API，也就是 `kimi web` 使用的同一套 API。
- **綁定機器**：在那台電腦執行一行連接指令（含連接金鑰），只需要做一次。
- **綁定對話**：在那台電腦的 Kimi 裡輸入 **`/web`**（Kimi 內建指令），或執行 `kimi web`，那台電腦的 Kimi 對話就會出現在中控台側欄的「我的機器」，點一下就能接管。
- 接管後會載入 Kimi 的歷史訊息，之後逐字即時同步：回覆、思考過程、工具呼叫、指令輸出，以及權限請求（允許 / 本次對話一律允許 / 拒絕）。在 Kimi 自己的網頁或終端機送出的訊息也會同步過來，並標註「在 Kimi 端送出」。
- 也可以直接在中控台選「Kimi Code · 某台機器」開新對話，資料夾可以瀏覽那台電腦上的目錄，或在 `~/agent-hub-workspaces` 新建。
- 某台機器上的 Kimi 等你核准時，就算還沒接管，中控台也會跳出通知。

## 架到公網

### 方式一：在你自己的電腦上一鍵啟動（免費、不用帳號）

```bash
npm run public                      # macOS / Linux，等同於 bash scripts/start-public.sh
```

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-public.ps1   # Windows
```

這個腳本會依序：

1. 安裝相依套件
2. 下載 Cloudflare 官方的 `cloudflared`
3. 啟動中控台
4. 開一條 Cloudflare 通道
5. 如果這台電腦有安裝 kimi，也會把它連上中控台

完成後會印出：

```
公網網址：  https://xxxx.trycloudflare.com/#token=...
登入密碼：  ...
其他電腦要連上（在那台電腦執行）：
  curl -fsSL https://xxxx.trycloudflare.com/bridge/agent-hub-bridge.mjs -o agent-hub-bridge.mjs && node agent-hub-bridge.mjs --hub https://xxxx.trycloudflare.com --key ...
```

注意：免費通道的網址每次啟動都會不同。要固定網址，可以用自己的網域建立 [Cloudflare named tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)，或使用方式二。

### 方式二：VPS / 雲端主機（Docker）

中控台本身只負責轉送，不需要在主機上安裝任何 agent。

```bash
docker build -t agent-hub .
docker run -d -p 8787:8787 -v agent-hub-data:/app/data --name agent-hub agent-hub
docker logs agent-hub        # 這裡會印出登入密碼
```

請在前面加上 HTTPS，例如 Caddy、nginx，或 Cloudflare Tunnel。

## 連接你的電腦

1. 那台電腦需要準備：
   - Node.js 22 以上
   - [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code)，並執行 `kimi login` 登入你的 Kimi 帳號
2. 在中控台側欄按 **「連接機器」**，複製指令，到那台電腦執行。指令會從中控台下載單一檔案的連接器 `agent-hub-bridge.mjs`，這個檔案不需要任何套件。
3. 在那台電腦的 Kimi 裡輸入 `/web`，或執行 `kimi web`。如果希望連接器自動啟動 Kimi 伺服器，可以在指令後面加 `--start-kimi`。

連接器參數：

| 參數 | 說明 |
| --- | --- |
| `--hub <url>` | 中控台網址 |
| `--key <金鑰>` | 連接金鑰，在「連接機器」裡取得 |
| `--name <名稱>` | 在中控台顯示的機器名稱，預設是電腦名稱 |
| `--start-kimi` | 沒有偵測到 Kimi 伺服器時，自動執行 `kimi web --no-open` |
| `--kimi-home <dir>` | Kimi 資料夾，預設 `~/.kimi-code` |

### 安全性

- 中控台**一律需要登入密碼**。密碼第一次啟動時自動產生，存在 `data/hub.json`；也可以用 `AGENT_HUB_TOKEN` 自訂。
- 機器用**另一把連接金鑰**連線，金鑰錯誤會被直接拒絕。
- 連接器用本機的 `~/.kimi-code/server.token` 跟 Kimi 溝通，**這個 token 不會傳到中控台**。連接器只允許有限的 Kimi API：
  - 允許：對話、送訊息、權限與提問、對話資料夾內的檔案與 diff
  - 拒絕：讀取任意檔案、修改 Kimi 設定或 provider、開啟桌面程式、關閉伺服器
- 請注意：持有中控台密碼的人，可以透過 Kimi 在你連接的電腦上執行指令。請保管好密碼，也不要分享公網網址加 `#token` 的完整連結。

### 和 Kimi 官方 `/rc` 的差別

Kimi 自己也有 Remote Control（`kimi rc` 或在 Kimi 裡輸入 `/rc`），需要付費會員，透過 Kimi 的中繼伺服器使用，最多約 3 台裝置。如果你只用 Kimi，那個功能就很夠。

Agent Hub 適合以下需求：
- 用同一個中控台管理多台電腦
- 混用其他 agent，例如 Gemini CLI、OpenAI 相容 API
- 讓多個 agent 並排比較
- 把工作交接給另一個 agent
- 自己架設，資料不經過第三方

## 其他 agent

除了遠端機器上的 Kimi，中控台所在的電腦也可以直接執行這些 agent：

| 類型 | 範例 | 說明 |
| --- | --- | --- |
| ACP | Kimi Code（`kimi acp`）、Gemini CLI、Qwen Code、Goose、OpenCode、Codex ACP | 透過 [Agent Client Protocol](https://agentclientprotocol.com) 即時串流，沿用 agent 自己的登入 |
| CLI | Aider、自訂指令 | 每回合執行一次，解析輸出 |
| OpenAI 相容 API | OpenAI、DeepSeek、OpenRouter、Ollama、Kimi API | 需要 API key，中控台提供工具讓模型讀寫檔案、執行指令 |
| Demo | Demo Agent | 不需要帳號，可以用來體驗介面 |

其他功能：
- 權限模式：每次詢問 / 自動接受編輯 / 全部自動。Kimi 對話對應到 Kimi 的 manual / yolo / auto。
- 多 agent 比較
- 交接給另一個 agent
- 工作區面板：git diff 與檔案瀏覽
- 深色模式、手機版面
- 中文輸入法選字時按 Enter 不會誤送出

## 本機使用

```bash
npm install
npm start          # http://127.0.0.1:8787，登入密碼會印在終端機
```

## 測試

```bash
npm test                                   # ACP、OpenAI 相容 API、權限、續接等
KIMI_BIN=$(which kimi) npm test            # 再加上真正的 Kimi Code CLI 端到端測試
```

`test/e2e-kimi-bridge.test.mjs` 會啟動真正的 `kimi web`，並讓它連到本機的假模型，所以不需要 Kimi 帳號，也不需要網路。它驗證的流程是「中控台 + 連接器 + Kimi」：

- 登入密碼與連接金鑰的檢查
- 偵測 Kimi 端發起、正在等待核准的對話，並接管
- 從中控台核准或拒絕權限
- 從中控台送訊息
- 讀取對話資料夾的檔案
- 在機器上開新對話

### 驗證範圍

- 已用 **Kimi Code CLI 2.1.1** 驗證：真正的 Kimi 伺服器、事件格式、權限流程，以及接管與同步。
- 開發環境的網路封鎖了 Kimi 與 Cloudflare 的網址，所以**還沒有用真實的 Kimi 帳號，透過 Cloudflare 公網跑過**。如果實際使用時遇到任何差異，歡迎回報。
- Kimi 的 Server API 官方標示為實驗性質，未來版本可能會改動。

## 專案結構

```
server/
  index.js            HTTP API、WebSocket、登入、連接器端點
  runner.js           回合執行、權限、中斷、交接、比較、即時對話（遠端 Kimi）
  machines.js         已連接的機器、轉送給連接器的請求
  adapters/
    kimi-remote.js    遠端 Kimi 對話同步（Kimi Server API 事件 → 中控台）
    acp.js            ACP 客戶端（本機 agent）
    openai.js         OpenAI 相容 API
    cli.js / demo.js  一般 CLI、示範 agent
bridge/
  agent-hub-bridge.mjs   每台電腦上執行的連接器（單一檔案、零相依）
public/                  前端（原生 ES modules，不需要建置）
scripts/
  start-public.sh / .ps1 一鍵公網（Cloudflare Tunnel）
  build-preview.mjs      產生介面預覽頁
preview/mock-backend.js  預覽頁用的模擬後端
test/                    端到端測試
```
