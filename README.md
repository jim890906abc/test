# Agent Hub

在瀏覽器（電腦或手機）操作你每台電腦上的 Kimi Code。

![對話](docs/conversation.png)

| Artifact 即時預覽 | 手機・深色 |
| --- | --- |
| ![Artifact](docs/artifact.png) | ![手機](docs/mobile-dark.png) |

## 安裝

需要 [Node.js 22+](https://nodejs.org)、Git，以及登入好的 [Kimi Code](https://github.com/MoonshotAI/kimi-code)（`kimi login`）。

**Linux / macOS**

```bash
git clone -b claude/hopeful-newton-kqqnmj https://github.com/jim890906abc/test.git agent-hub
cd agent-hub && npm run public
```

**Windows（PowerShell）**

```powershell
git clone -b claude/hopeful-newton-kqqnmj https://github.com/jim890906abc/test.git agent-hub
cd agent-hub; powershell -ExecutionPolicy Bypass -File scripts\start-public.ps1
```

跑完會印出網址、登入密碼，以及給其他電腦的連接指令。

**更新**：在 `agent-hub` 資料夾裡執行 `git pull`，再執行一次上面的啟動指令。

## Claude API

首頁上方切到「Claude API」，就能直接和 Claude 對話。中控台用 Anthropic 官方 SDK 呼叫 Claude API（api.anthropic.com），**只用 Claude Console 的 API key**（`sk-ant-…`），依 token 從 Console 帳戶的額度扣款；不經過 Claude Code，也不會用 Claude Pro／Max 訂閱，訂閱帳號的登入 token（`sk-ant-oat…`）會被拒絕。

1. 到 [Claude Console → API Keys](https://console.anthropic.com/settings/keys) 建立一把 key。
2. 左下角「⋯」→「Claude API…」貼上 key 後儲存（中控台會先向 Anthropic 確認 key 有效；key 只存在 `data/claude.json`，不會傳回瀏覽器）。也可以改用環境變數 `ANTHROPIC_API_KEY`。

Claude 的對話由一個獨立的 **Claude 背景程式** 執行（跟 Kimi 的 `kimi web` 一樣）：在中控台這台電腦上由中控台啟動，在已連接的電腦上由那台的連接器啟動（連接器要 0.5 以上，舊的請在那台電腦重新執行連接指令）。中控台只是看和操控它的介面：關掉中控台、甚至關掉連接器，Claude 都照常做完，中控台再開時會補上這段時間的進度。工具（Bash、Read、Write、Edit、Glob、Grep、網路搜尋）在那台電腦上你選的資料夾裡跑。為了在中控台關掉時也能呼叫 API，API key 也會存一份在執行 Claude 的那台電腦上（`~/.agent-hub/claude/`，只有你的帳號能讀）。權限有「每次詢問／自動接受編輯／全部自動」和計畫模式。也支援待辦、提問、子代理、插隊、/compact、/undo、/fork、定時送出；輸入框旁顯示這個對話的估計花費與每次回應實際的模型，`/cost` 看明細與速率限制，`/budget 5` 設定花費上限（花到就先停）。預設模型 Claude Opus 5.5。只用你選的模型：如果回覆來自別的模型（例如被降級），或模型拒絕回答，這一輪會立刻停下、不執行它要的工具，對話裡寫明原因並跳出通知。背景程式本身重新啟動（例如更新）時，被中斷的那一輪會自動接著做。

## GitHub

Claude 和 Kimi 都用 git 與 GitHub CLI（`gh`）操作 GitHub：clone、開分支、push、開 Pull Request、看 Issue 和 Actions。每台電腦登入一次就好：左下角「⋯」→「GitHub…」，選「用瀏覽器登入」（顯示一組代碼，到 github.com/login/device 輸入），或貼上一個 token。登入資料只存在那台電腦的 `gh` 裡，中控台不保存；登入後 git 也會用這個帳號 push（`gh auth setup-git`），commit 沒有設定署名的話會用帳號名稱與 GitHub 的 noreply 信箱。

那台電腦要先裝好 `gh`（Kali／Debian／Ubuntu：`sudo apt install gh`，macOS：`brew install gh`，Windows：`winget install --id GitHub.cli`），連接器要 0.6 以上。連接器也會幫 Kimi 裝一個 `/github` skill；Claude 的系統提示裡有同樣的規則：會改到 GitHub 的動作（push、開 PR、留言）沒被要求就先問你，在新分支上工作，不 force push，也不在對話裡要 token。

## 連接其他電腦

在那台電腦執行中控台印出的連接指令（左下角「連接電腦…」也看得到）。之後那台電腦的 Kimi 對話會自動出現。

想讓終端機和網頁同時操作同一個對話，用 `kimi-hub` 取代 `kimi` 啟動：

```bash
echo "alias kimi-hub='node ~/.agent-hub/agent-hub-bridge.mjs kimi'" >> ~/.zshrc && source ~/.zshrc
```

## 自動暫停與定時送出

都由中控台執行，關掉網頁也照常運作，重開中控台也會保留。

- **自動暫停**（對話右上角「…」→「自動暫停…」，或 `/autopause 90`）：Kimi 工作時，5 小時額度用到設定的 % 就在對話裡插隊送出「優雅暫停」；5 小時額度恢復後送出「繼續」。每個 5 小時視窗最多暫停一次；暫停期間如果有人又讓 Kimi 開始工作，就不會自動送「繼續」。Kimi 自己開的那一輪（例如背景子代理做完後它接著處理）Kimi 不接受插隊，這時「優雅暫停」會顯示「等待插隊」：中控台每 2 秒再試一次，有新的一輪開始也立刻再試，最晚在這一輪結束時第一個被 Kimi 讀到；不會中斷 Kimi 正在做的事。Kimi 接受插隊後，要等目前這一步做完才會讀到；如果這一步是在等前景的子代理或跑很久的指令，「優雅暫停」被接受 10 秒後還沒被讀到，中控台會把主對話在前景等的工作移到背景（跟 Kimi 的 Ctrl+B 一樣，工作會繼續跑），讓 Kimi 馬上讀到。只對「優雅暫停」這樣做，平常的子代理不會被移動；終端機裡的 Kimi 不適用。
- **移到背景**（Kimi 在等前景的子代理或指令時，輸入框旁的「移到背景」按鈕、輸入框裡按 Ctrl+B，或 `/bg`）：跟 Kimi 的 Ctrl+B 一樣，把前景的子代理和指令改到背景繼續跑，Kimi 不用再等它。終端機裡用 kimi-hub 開的 Kimi 也可以。
- **額度恢復後送出**（點輸入框旁的 context 圓圈 →「額度恢復後送出「繼續」」，或 `/later reset 繼續`）：你已經自己讓 Kimi 停下時用。等 Kimi 停下、5 小時額度確實恢復後送出。
- **定時送出**（「…」→「定時送出…」，或 `/later 30 繼續`、`/later 15:30 繼續`）：幾分鐘後或指定時間送出一則訊息。Kimi 正在工作時，會排在這一輪之後。

### 方案用量一直是 0%

Kimi 的用量回應裡同時有百分比（`usages.limit_5h.used_ratio`…）和已用次數（週額度的 `usage`、5 小時視窗的 `limits[]`）。Kimi Code 只看百分比，而這個百分比常卡在 0（[kimi-code#3817](https://github.com/MoonshotAI/kimi-code/issues/3817)、[#3908](https://github.com/MoonshotAI/kimi-code/issues/3908)、[#3951](https://github.com/MoonshotAI/kimi-code/issues/3951)、[#4133](https://github.com/MoonshotAI/kimi-code/issues/4133)），所以 Kimi 終端機的 `/usage` 和網頁版也顯示 0%。中控台會另外讀同一份回應裡的次數：同一個視窗（重置時間相同）兩者不一致時取較高的那個（滑鼠移到用量條上會顯示 Kimi 原本回報的百分比和次數）；自動暫停也照這個數字判斷。

讀法：連接器用 Kimi 存在 `~/.kimi-code/credentials/` 的登入，向 Kimi 自己用的網址（`api.kimi.com` 或 `api.kimi.ai`）要同一份用量。只讀不寫、不換發登入，登入資料不會送到 Kimi 以外的地方，也不會傳給中控台；回應的重置時間和 Kimi 剛回報的對不上（不是同一個帳號）就不採用。如果 Kimi 沒附次數，畫面會照 Kimi 的數字顯示，這時請以 Kimi 網站會員頁為準。
