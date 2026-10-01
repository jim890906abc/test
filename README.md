# Agent Hub：所有電腦上的 Kimi Code，集中在一個網頁

用瀏覽器（電腦或手機）看、操作你每一台電腦上的 Kimi Code，體驗參考 Claude Code 網頁版。Kimi 留在你自己的電腦上，用那台電腦登入的 Kimi 帳號（訂閱制可用）。

## 功能

- **所有對話集中在左邊**：每台電腦上的 Kimi 對話都會列出來，包含**終端機裡正在跑的**。狀態（執行中、等你核准）、標題、內容都即時同步。
- **即時對話**：回覆逐字串流；工具呼叫是精簡的一列，點開看指令輸出或 diff；思考過程可收合。
- **子代理**：子代理的每一步顯示在呼叫它的卡片裡，跑完附上它的回報。
- **核准與提問**：在卡片上允許、這個對話都允許、拒絕（可以附上要 Kimi 改怎麼做）；Kimi 的提問用表單回答；計畫模式的計畫可以直接同意。
- **Kimi 忙碌時也能送出**：訊息會在 Kimi 的下一步插入目前的回合（跟 CLI 一樣），等待時顯示在輸入框上方，可以取消。
- **待辦清單與 context**：TodoList 顯示成核取清單，進行中的進度釘在輸入框上方；右下角顯示 context 用量（例如 35% · 89.3k/256k），點一下可以壓縮。
- **/ 指令**：輸入 `/` 跳出指令選單（/compact、/undo、/btw、/goal、/init、/fork、/title、/plan…，加上 Kimi 的 skills），方向鍵選、Tab 補完、Enter 執行。
- **模型、思考強度、權限模式、計畫模式**：輸入框下方直接切換。
- **圖片**：貼上、拖放或選檔，送給 Kimi。
- **Artifact**：Kimi 寫的 HTML 頁面會在右邊面板**邊寫邊顯示**，可以切換版本、下載；拖曳面板左緣調整寬度（按兩下還原）。左上角的「Artifacts」列出所有對話做過的頁面。頁面裡呼叫 `agentHub.send('…')` 就能把訊息送回對話，適合進度頁、方案選擇、報表。連接器會幫 Kimi 裝好 `/artifact` skill，Kimi 會知道怎麼用。
- **檔案變更**：右邊面板看目前資料夾的 git diff。
- **側欄右鍵**：重新命名、釘選、刪除、在新分頁開啟。
- 淺色是 Oatmeal 米色 Mac 風格，深色照 Claude 的深色配色；手機版面；中文輸入法選字時按 Enter 不會誤送出。

## 運作方式

```
手機 / 電腦瀏覽器 ──HTTPS──▶ 中控台（Hub）
                                ▲ 連接器主動連出（不用開 port，NAT 後面也行）
              ┌─────────────────┴─────────────────┐
        [筆電] 連接器                         [公司桌機] 連接器
          ├ 讀 Kimi 的對話紀錄檔（即時）          …
          ├ kimi web（從中控台開的對話）
          └ 終端機裡的 Kimi
```

- **中控台不需要登入 Kimi。** 每台電腦執行一個「連接器」，它從那台電腦讀取 Kimi 的對話、把你的操作交給 Kimi。
- **看**：Kimi 會把每個對話即時寫進 `~/.kimi-code/sessions/` 的紀錄檔。連接器直接讀這些檔案，所以不管 Kimi 在終端機、`kimi web` 或 Kimi 自己的網頁裡跑，中控台都能即時看到，也能快速載入歷史訊息。
- **操作**：
  - 從中控台開的新對話，或沒有在別處執行的舊對話：連接器透過 Kimi 官方的 Server API（`kimi web`）操作。需要時連接器會自動在背景啟動 `kimi web`。
  - 終端機裡正在跑的對話：Kimi 的終端機程式和伺服器是兩個獨立的程式，不能同時操作同一個對話（會互相覆蓋紀錄）。所以：
    - 一般用 `kimi` 開的：中控台**即時同步、唯讀**。要從中控台接手，在那個 Kimi 裡輸入 `/web`。
    - 用 **`kimi-hub`**（見下方）開的：中控台可以**直接操作**——你的訊息會打進那個終端機（Kimi 在忙時用 Ctrl-S 插入），核准、拒絕、Esc 停止也一樣。終端機照常可以用，兩邊同步，等於 Kimi 版的 Claude Code `/rc`。

## 架到公網

### 方式一：在你自己的電腦上一鍵啟動（免費、不用帳號）

```bash
npm run public                      # macOS / Linux，等同於 bash scripts/start-public.sh
```

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-public.ps1   # Windows
```

這個腳本會安裝相依套件、下載 Cloudflare 官方的 `cloudflared`、啟動中控台、開一條 Cloudflare 通道；如果這台電腦有安裝 kimi，也會把它連上中控台。完成後會印出公網網址、登入密碼，以及其他電腦的連接指令。

免費通道的網址每次啟動都會不同。要固定網址，可以用自己的網域建立 [Cloudflare named tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)，或用方式二。

### 方式二：VPS / 雲端主機（Docker）

中控台本身只負責轉送，不需要在主機上安裝 Kimi。

```bash
docker build -t agent-hub .
docker run -d -p 8787:8787 -v agent-hub-data:/app/data --name agent-hub agent-hub
docker logs agent-hub        # 這裡會印出登入密碼
```

請在前面加上 HTTPS，例如 Caddy、nginx，或 Cloudflare Tunnel。

## 連接你的電腦

1. 那台電腦需要：Node.js 22 以上、[Kimi Code CLI](https://github.com/MoonshotAI/kimi-code)，並執行 `kimi login` 登入你的 Kimi 帳號。
2. 在中控台左下角按電腦名稱（或「連接電腦…」），複製指令，到那台電腦執行。指令會下載單一檔案的連接器 `agent-hub-bridge.mjs`，不需要任何套件。
3. 完成。那台電腦的 Kimi 對話會出現在左邊。

### 從中控台操作終端機裡的 Kimi（kimi-hub）

連接器第一次執行時會把自己複製到 `~/.agent-hub/agent-hub-bridge.mjs`。之後用這個指令代替 `kimi` 啟動 Kimi（參數跟 `kimi` 一樣，例如 `-c`、`--auto`）：

```bash
node ~/.agent-hub/agent-hub-bridge.mjs kimi
```

建議加進 `~/.bashrc` 或 `~/.zshrc`：

```bash
alias kimi-hub='node ~/.agent-hub/agent-hub-bridge.mjs kimi'
```

需要 python3（用來建立虛擬終端機，macOS 與 Linux 通常都有）。如果連接器沒在執行，kimi-hub 會用上次的設定在背景啟動它。

### 連接器參數

| 參數 | 說明 |
| --- | --- |
| `--hub <url>` | 中控台網址 |
| `--key <金鑰>` | 連接金鑰，在「連接電腦」裡取得 |
| `--name <名稱>` | 在中控台顯示的電腦名稱，預設是電腦名稱 |
| `--start-kimi` | 一啟動就在背景執行 `kimi web --no-open`（不加的話，需要時才啟動） |
| `--kimi-bin <path>` | Kimi Code CLI 的路徑，預設 `kimi` |
| `--kimi-home <dir>` | Kimi 資料夾，預設 `~/.kimi-code` |
| `--no-skill` | 不要把 `/artifact` skill 裝進 Kimi |

## 安全性

- 中控台**一律需要登入密碼**。密碼第一次啟動時自動產生，存在 `data/hub.json`；也可以用 `AGENT_HUB_TOKEN` 自訂。
- 電腦用**另一把連接金鑰**連線，金鑰錯誤會被直接拒絕。連接器把中控台網址與金鑰存在 `~/.agent-hub/bridge.json`（權限 600），給 kimi-hub 使用。
- 連接器用本機的 `~/.kimi-code/server.token` 跟 Kimi 溝通，**這個 token 不會傳到中控台**。連接器只允許有限的 Kimi API：
  - 允許：對話、送訊息、權限與提問、對話資料夾內的檔案與 diff
  - 拒絕：讀取任意檔案、修改 Kimi 設定或 provider、開啟桌面程式、關閉伺服器
  - 終端機裡正在跑的對話，連接器不會讓 Kimi 伺服器去動它
- 連接器讀取的紀錄檔只有 Kimi 的對話紀錄（`~/.kimi-code/sessions/`）。
- Artifact 頁面在沙箱 iframe 裡執行，拿不到中控台的登入資訊。
- 請注意：持有中控台密碼的人，可以透過 Kimi 在你連接的電腦上執行指令。請保管好密碼，也不要分享「公網網址 + #token」的完整連結。

## 本機使用

```bash
npm install
npm start          # http://127.0.0.1:8787，登入密碼會印在終端機
```

## 測試

```bash
npm test                                   # 執行流程、權限、中斷、續接等
KIMI_BIN=$(which kimi) npm test            # 再加上真正的 Kimi Code CLI 端到端測試
```

`test/e2e-kimi-bridge.test.mjs` 會啟動真正的 Kimi（`kimi web` 與終端機版），並讓它連到本機的假模型，所以不需要 Kimi 帳號，也不需要網路。驗證的流程是「中控台 + 連接器 + Kimi」：

- 登入密碼與連接金鑰
- 接管 Kimi 端開始、正在等待核准的對話；核准與附說明的拒絕
- 從中控台開新對話；子代理掛在 Agent 卡片底下；從紀錄檔重建對話
- 待辦清單；Kimi 忙碌時送出的訊息插入目前的回合
- 終端機裡的 Kimi：即時同步、唯讀；用 `agent-hub-bridge.mjs kimi` 啟動時可以從中控台送訊息與核准

已用 **Kimi Code CLI 2.1.1** 驗證。Kimi 的 Server API 與紀錄檔格式未來版本可能會改動，遇到差異歡迎回報。

## 專案結構

```
server/
  index.js            HTTP API、WebSocket、登入、連接器端點
  runner.js           回合執行、權限、中斷
  machines.js         已連接的電腦、轉送給連接器的請求
  adapters/
    kimi-remote.js    Kimi 對話同步（紀錄檔與 Server API 事件 → 中控台）
    acp.js / openai.js / cli.js / demo.js   其他 agent（介面目前只顯示 Kimi）
bridge/
  agent-hub-bridge.mjs   每台電腦上的連接器與 kimi-hub（單一檔案、零相依）
public/                  前端（原生 ES modules，不需要建置）
  css/oatmeal.css        Oatmeal 設計系統（tokens 與元件）
scripts/
  start-public.sh / .ps1 一鍵公網（Cloudflare Tunnel）
test/                    端到端測試
```
