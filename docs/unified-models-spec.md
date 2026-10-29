# Agent Hub 三模型融合規格

日期：2026-10-24
狀態：實作依據；完成後須逐項驗收

## 1. 目標

把現有 Kimi、Claude API、DeepSeek 三個互相隔離的模式合成單一 Agent Hub 體驗：

- 只有一個新對話首頁與一個對話清單，不以供應商切成三個首頁。
- 任意新舊對話都能選 Kimi、Claude 或 DeepSeek 的可用模型；既有對話不需要重建，也不失去原本可見歷史。
- 保留原本的帳號與執行方式：Kimi 使用已登入的 Kimi Code；DeepSeek 使用原閘道 API key，經 Kimi Code 執行；Claude 使用 Claude Console API key，經現有 Claude daemon 執行。
- 每個對話可持久指定「新子代理」的預設供應商、模型與思考強度；原生預設與可選 broker 的適用範圍須明示，既有全域設定不得被覆蓋。
- 介面配色與模型選擇脫鉤；使用者可固定選原本 Kimi、Claude 或 DeepSeek 三套配色之一。

## 2. 不可妥協的行為

1. **不自動跨家 fallback**：所選供應商、模型或 key 不可用時，明確報錯並保留重試能力；不得暗中改用另一家公司或另一個計費帳號。
2. **不改寫進行中的回合**：模型、思考強度與子代理預設若在回合中變更，只影響下一回合或之後新建的子代理。畫面要區分「本回合實際使用」與「下一回合將使用」。
3. **不刪除舊原生對話**：跨 runtime 切換時保留原 Kimi／Claude 綁定與 Agent Hub 可見事件；不得覆寫原生 wire/session 檔。
4. **不偷改全域設定**：聊天室不得改 Kimi 的 `default_model`、`default_provider` 或 `[thinking]`。受控 provision 可在空缺的 `[secondary_model]` 建立 DeepSeek V4.1 Flash + max；既有模型、effort、force 與描述不得覆蓋，換閘道時只能修復失效的 Hub alias 與 pool 引用，不得把這個機器全域原生預設宣稱成 per-session 隔離。
5. **不洩漏秘密**：API key、OAuth token、bridge key 不進瀏覽器 API、對話事件、交接文字、log 或測試快照。
6. **設定必須有真實效果**：不得只在 UI 顯示子代理模型或思考強度，實際仍沿用主模型；子代理卡片須能看到實際模型，無法確認時不得假稱成功。

## 3. 統一對話與模型選擇

### 3.1 首頁與清單

- 新對話只有一個入口；電腦、資料夾、GitHub repo、權限、計畫模式等原有能力沿用。
- 模型選單依 Kimi、Claude、DeepSeek 分組，顯示模型名稱、可用狀態與各模型支援的思考強度。
- 全域「設定」只決定新對話的預設主模型與思考強度；既有對話保留自己的選擇。
- 側欄不再用三個模式過濾對話。每列以標籤顯示該對話目前／下一回合的供應商，不以外觀顏色推斷供應商。
- 舊資料升級時，從既有 `agent`、model alias 與 native state 還原正確供應商；不得把 DeepSeek 對話誤判成 Kimi。

### 3.2 舊對話切換

- 模型控制在新舊對話都可使用，而不是只能在新對話首頁選。
- 終端機中的 Kimi 對話同樣可以切換模型與從 Hub 操作，不再要求先用 `/web`／`kimi-hub` 解除唯讀；雙寫風險由使用者明確接受，路由規則見第 12 節。
- 選擇與目前相同的模型只更新必要設定，不重建原生對話。
- Kimi 與 DeepSeek 共用 Kimi runtime 時，沿用原原生對話直接切模型；先完成 key／provider／model 驗證與 `/profile` 更新，成功才提交 provider 狀態，失敗不得換到預設模型。
- 切換 runtime（Kimi runtime ↔ Claude daemon）時採用**接續鏈**：建立新的 Hub/native session 節點，以 `conversationId`、`continuedFrom`、`continuedTo` 與原節點連結；原節點及其 native binding 不修改、不刪除。
- 接續鏈在側欄、路由與歷史 API 中是同一個邏輯聊天室，永遠以 leaf 作為下一回合 runtime。這是內部實作，不是要求使用者另開聊天室。
- 不把舊節點的 events 複製進新 native session；各 native mirror 只能替換自己所屬節點的事件。歷史 API 依 `continuedFrom` 合併可見事件，因此舊 snapshot／journal 不可能洗掉其他 runtime 的歷史。
- `continuedFrom` 與子代理的 `parentId` 是不同的欄位，不得混用刪除級聯或子代理階層。
- A→B→A 會產生新的 A2 節點與 native id，並從整條鏈攜帶 B 期間的新歷史；不回用 A1，也不需要讓同一個 Hub id 對應多個 Claude daemon id。

### 3.3 跨 runtime 交接

- 以接續鏈所有節點的可見事件建立 portable transcript：依時間包含使用者與助手文字，並保留工具工作、檔案修改與重要結果的可讀摘要。
- 交接文字要明確標示來源供應商、工作目錄與「這是前段歷史，不是新的使用者要求」；真正的下一則使用者訊息與歷史必須分開。
- 不用另一家模型額外產生摘要，避免未預期費用。若為避免首輪 context overflow 必須省略舊內容，採确定性規則、保留完整原始事件，並在對話中明確標記；不得靜默截斷。
- 交接 prompt 不新增一則假的使用者訊息到 Agent Hub 可見歷史；改以系統資訊事件記錄成功、失敗與實際目標模型。Kimi 以下一次真實 prompt 的 hidden/system-reminder 內容交接；Claude 以 create config 的 handoff 注入內部 messages。
- 目標節點建立或設定失敗時可清掉尚未使用的新節點，但原 leaf 與原 native binding 必須保持可重試；不能把訊息送給未選的供應商，也不能留下半個正在執行的錯誤 runtime。


### 3.4 原生模型飄移（2026-10-27 補）

Hub 記錄的模型（`modelConfig`）與原生 Kimi 實際回報的模型（`meta.model`，來自 `agent.status.updated`／journal）可能不一致：別處（終端機、全域預設、其他用戶端）改了原生對話的模型時就會。實際案例：一個對話標示 DeepSeek、原生卻連續 144 次以 Kimi K3.1 Pro 執行，就是這個狀態，而且沒有任何提示。規則：

- **誠實顯示**：摘要有 `nativeModel`（原生最近一次回報，未知為 `null`）、`nativeProvider`（由該 alias 的形式推導，不是對話標籤）與 `modelDrift`（`null` 或 `{ kind: provider|model|effort, expected, actual, since }`）。原生沒回報時是「未知」，不算飄移。輸入框的模型標示在飄移時改寫成「實際：…」，並顯示「與你選的 … 不同」與「改回 …」按鈕；側欄標籤顯示實際供應商。
- **再選一次也要生效**：選與 Hub 記錄相同的模型，只有在原生也回報同一個模型時才算「不用動」；原生回報不同或未回報就送 `/profile`。「改回」按鈕帶 `force: true`，伺服器略過這個捷徑。送出的變更要等原生說它收下了什麼：原生回報另一個模型就是失敗（不宣稱成功）；沒有回報（Kimi 在下一回合才寫 journal）算已送出。
- **送出訊息之前**：Kimi runtime 的對話若偵測到飄移，且模型是使用者在 Hub 選的（`userSet.model`，或供應商本身不對），先把使用者的選擇改回原生（一次 `/profile`，成功才送），並在對話放一則說明。改回失敗就**不送**並說明原因：在不是使用者選的模型上跑一輪，可能是另一家的帳單，比訊息晚一點送出更糟（第 2 節第 1 條）。
- **終端機不覆寫**：對話在終端機的 Kimi 裡（`owner === 'tui'`，不論 Hub 能不能打字進去）時，使用者可能在終端機裡有意改了模型。Hub 不自動改回，只在對話裡說一次、輸入框顯示警告與按鈕，訊息照原生目前的模型送出。
- **全域預設永遠不蓋到已存在的對話**：原生沒說自己用哪個模型（journal 落後、狀態還沒讀到）不是「這個對話沒有模型」。`applyDefaults` 在這種情況下不套用模型與思考強度預設，只標記未確認；DeepSeek 對話用任何跡象判斷（`provider`、`mode`、`state.deepseek`、`modelConfig`、原生 alias），不再只看 `mode`。送出 prompt 時原生未回報模型，帶的是 Hub 記錄的模型，DeepSeek 對話沒有就拒絕，不退回 Kimi 的預設。
- **舊資料用原生狀態還原供應商**：沒有 `provider` 的舊紀錄先從它留下的欄位推導（並標 `providerInferred`），原生第一次回報的 alias 若是 DeepSeek 就更正為 DeepSeek；使用者或切換流程設的供應商不受影響。

## 4. 每對話子代理預設

每個對話都有獨立設定。未明確自訂的舊聊天室與新聊天室，子代理一律預設 **DeepSeek V4.1 Flash + max**，不受主模型影響；使用者明確選擇其他模型或「跟隨主模型／原生規則」時，才保留該選擇。子代理供應商、模型與思考強度可指定：

- 子代理供應商：Kimi、Claude、DeepSeek。
- 子代理模型：從該供應商已設定且可用的模型中選擇。
- 子代理思考強度：只列出該模型支援的值；也可選「模型預設」。

行為規則：

- 設定存在該對話，重新整理、重開 Hub 或換瀏覽器後仍在。
- 只影響設定生效後新建的子代理；已在跑的子代理不換模型。
- 主代理仍可在單次工具呼叫明確覆寫預設；沒有覆寫時必須套用對話預設。
- 三家主代理 × 三家子代理供應商的組合都要有真實執行路徑。原生 runtime 不支援的組合由 Agent Hub 橋接，不得把選項做成無效裝飾。
- 子代理沿用所選供應商原本的 key／CLI，不複製到提示詞，也不要求使用者另設一套重複帳號。
- 子代理工具與權限跟隨主對話的安全邊界與工作目錄；跨 runtime 不得變成無權限提示的隱藏通道。
- 若組合不可用，建立子代理前要回報具體原因；不得先以主模型執行再顯示所選模型。

### 4.1 原生優先，跨供應商 broker 可選

Kimi 沒有 per-session `secondary_model`／`default_effort`；原生 DeepSeek 子代理使用那台電腦的 Kimi `[secondary_model]`，不是把聊天室設定假裝成 per-session 原生欄位。`KIMI_SECONDARY_*` 是共享 process 覆寫，不得用來隔離聊天室。

- **Kimi／DeepSeek 主對話 × DeepSeek 子代理**：走 Kimi 原生 `Agent`／`AgentSwarm`。不得注入 delegation token、不得送 `disabled_tools` 停用原生工具、不得建立 Hub broker child 或另開主聊天室。舊對話若曾被 broker 停用工具，下一則 prompt 必須以空 `disabled_tools` 恢復；`subagent.spawned` 的實際 model／effort 與子代理工具事件要投影到原父子代理卡片。
- **原生 secondary 配置**：機器上線且有 key，以及新增／更換 key 時，Hub 對 online Kimi server best-effort 呼叫既有 `kimi.deepseek.provision`，不阻塞 hello 或設定保存，不在背景循環重試。空 `[secondary_model]` 才寫入目前閘道的 V4.1 Flash alias 與 `default_effort=max`，不設 `force`；既有模型、effort、force 與描述都保留並回報實際值。換閘道時只在 `config.toml` 修復失效的 Hub DeepSeek alias（同名模型優先對應，不猜測），移除找不到的舊 pool 項目並確保 default 也在 pool（單行與 nested table 都支援）；其他設定不可改。不得改主 `default_model`、`default_provider`、`[thinking]` 或其他 provider。這個值是該台 Kimi 的全域原生預設，不是 per-session 隔離欄位。
- **Claude→Claude**：由 daemon 原生 Task 套用每對話模型與 effort。
- **其他明確指定的跨供應商組合**：保留可選 broker。只有這些對話才注入短命 token 與 MCP 指示，並由 PreToolUse hook／prompt 工具政策導向 broker；DeepSeek 原生預設不得走這條路。MCP 工具描述必須以原生為預設，不得宣稱任何 Agent Hub 子代理預設都要取代原生工具。
- broker 內部介面為 `runner.delegateToProvider(parent, { provider, model, effort, task, parentEventId, background=false })`。它驗證模型選擇，以目標原生 `newSession` 建立 `parentId` 子對話，沿用工作目錄、權限模式與 allowedTools；一般 adapter 用 `runTurn`，live adapter 用原生 send／status 等回合完成。預設同步回傳 `{ childSessionId, provider, model, effort, text, error }`，權限不得自動核准。`background:true` 在 child 建立後立即回傳 running，完成結果送回父對話；父忙碌時排隊，interrupt 後不得再啟動父回合。
- Claude 跨供應商 Task 經現有 link 等待 broker；Kimi／DeepSeek 的跨供應商選擇經受控 MCP、bridge 本地通道與已認證 WebSocket。不得另造公開 HTTP endpoint，也不得在 MCP stdio process 保存 API key。token 只綁該 Kimi native session／Hub session／machine，過期或跨對話使用要拒絕。
- `runner.interrupt(parent.id)` 必須中斷 active broker child 並解除 tracking。舊 connector 不支援時回可理解的升級錯誤，不得 fallback 到主模型。
- 原生與 broker 卡片都只顯示「子代理」、任務摘要與實際供應商／模型／effort，不把 `delegate_to_provider`、broker 或 agent-hub 當使用者欄位。原生 `subagent.spawned` 與 broker child 的 emit／patch／delta／replaceEvents 都要即時投影目前工具、步驟數、文字進度、權限與最終狀態；穩定 id 去重，replay／restore 不得洗掉其他事件。
- 每次委派都要有獨立父卡片與正確 parentEventId／childSessionId；多個平行 child 不得共用卡或投影。原生 MCP late frame 只能依 parentEventId 或同一 task 合併；父傳輸等待與 child 自身狀態分開，不得把仍在工作假稱完成，或把後來完成的 child 誤標失敗。

## 5. 三套介面配色

- 全域外觀設定提供「Kimi／Claude／DeepSeek」三個色票，沿用原本三套完整背景、側欄與對比色。
- 預設沿用使用者最後一次的外觀；首次使用者預設 Kimi。
- 配色只由使用者選擇，開啟任何對話或切換模型都不得自動改變。
- 沿用現有 `localStorage` 偏好並做舊值遷移；重新整理與 artifact／聊天路由往返後仍一致。
- 配色樣式與實際 provider state 分開（例如 `data-look` 對比 `data-provider`），避免把主題 class 當成模型判斷。
- 保留原有 light／dark 能力於適用的 Kimi 配色；Claude 與 DeepSeek 維持原本各自的固定視覺。
- 三種配色都須維持文字、按鈕、選單、權限提示與錯誤狀態的可讀對比。

## 6. 資料與 API 原則

- 沿用現有 JSON store，新欄位採向後相容讀取；舊檔缺子代理設定時預設 DeepSeek V4.1 Flash + max，只有明確記錄原生規則或其他模型時才保留，主模型與其他資料不做破壞性改寫。
- 主模型選擇存 `modelConfig: { provider, model, effort }`；子代理預設存 `meta.subagent`；`conversationId`、`continuedFrom/To`、handoff metadata 與 UI theme preference 分開。`conversationId` 預設為舊 session id。
- `GET /api/models?session=<id>`（新對話用 `machine=<id>`）回傳三家分組模型、efforts、可用性與原因，供首頁、既有對話與子代理設定共用。
- 新對話沿用 `POST /api/sessions`，增加 `provider` 與 optional `subagent`。既有對話主模型用 `POST /api/sessions/:id/provider { provider, model, effort }`；同 provider／同 runtime 只做必要設定，跨 runtime 回傳新 leaf summary。
- 每對話子代理設定用 `POST /api/sessions/:id/config { subagent: null | { provider, model, effort } }`；null 表示原生規則。API 不回傳 delegation token。
- `GET /api/sessions` 只顯示各接續鏈 leaf；`GET /api/sessions/:id` 與串流 snapshot 依鏈合併歷史，summary 帶 `conversationId`、`continuedFrom/To` 與目前 provider。舊節點 URL 導向目前 leaf，但舊節點的後續 native replay 不得改寫成 leaf 新事件而重複插入。
- 刪除邏輯聊天室時，刪除整條接續鏈與各節點的子代理子對話，不得只刪 leaf 而讓舊節點復活。
- `PUT /api/settings` 以 `defaults.byProvider` 分別保存三家的 `{model,effort,permission,planMode}`，`defaults.provider` 是新對話預設供應商；原 top-level 欄位僅作 Kimi legacy，不得被 Claude／DeepSeek 模型或權限污染。
- 跨 runtime pending target 在 Hub 重啟後仍保留；清掉 stale pendingSwitching，等所需 machine online 後只嘗試一次，失敗明示而不是丟棄或無限重試。
- API 以伺服端白名單驗證 provider、model 與 effort，不能信任瀏覽器送的任意字串。明確選擇的設定失敗必須 fatal；不得沿用 `runner.js` 舊有非 DeepSeek configure 的 `.catch(warn)` 後繼續送 prompt。
- 設定回應只包含 key 是否已設定與可用模型，不回傳 key 本體或 delegation token。
- 回合開始時快照實際 provider／model／effort 與子代理預設，供 UI、重試與稽核使用。
- 送訊 API 要等 live adapter／daemon 收下訊息才回成功，不等整個回合完成。原生 `turn_end` 與其 seq 是完成依據；較舊的 running snapshot 不得覆蓋它，下一則 send 才開始新回合。
- 修改 daemon 原始碼後必須重新產生 `bridge/claude-daemon.mjs`；新增 daemon import graph 檔案也要加入 `claude-link.js` 的 `ENGINE` hash 清單；測試須證明 bundle 與來源同步。

## 7. 危害評估與緩解

| 可能危害 | 緩解設計 |
| --- | --- |
| 選錯供應商而使用另一家的額度 | 回合快照、實際模型標示、禁止自動 fallback、跨家切換資訊事件 |
| 舊對話切換後遺失上下文 | 保留全部可見事件與舊 native binding；portable transcript；A→B→A 測試；省略時明確標記 |
| 原生全域子代理預設影響其他聊天 | UI／文件明示機器全域範圍；只寫空缺的 `[secondary_model]`，既有值不覆蓋；broker 選項仍依對話隔離 |
| 主題重構造成三種模型 UI 互相污染 | palette 與 provider 狀態分離；三配色 × 三供應商瀏覽器檢查 |
| 遠端機器仍跑舊 bridge／daemon 而功能不一致 | 能力版本檢查、明確升級提示、更新生成 bundle；不可假稱支援 |
| 跨 runtime 子代理繞過權限 | 沿用主對話權限與工作目錄；權限事件可見；拒絕時不執行 |
| 交接或設定事件洩漏 key | 秘密欄位白名單、API/log/事件掃描、不得讀取或複製現有秘密檔做測試 |

## 8. 驗收矩陣

### 8.1 自動化

- 舊 Kimi、舊 Claude、舊 DeepSeek fixture 都能在不清空歷史下開啟並改選任一家。
- 六個有向切換：K→C、K→D、C→K、C→D、D→K、D→C；另測 K→C→K 與 C→K→C。
- 同模型重選不多建 binding；同 Kimi runtime 的 K↔D 保留原生上下文。
- 回合中變更不污染本回合；下一回合才生效。Hub 在 pending 期間重啟後仍能等機器上線並完成一次切換。
- 刪除整條接續鏈後無舊節點復活；舊 native replay 不在 leaf 重複出現。
- 三家全域預設分別保存且互不污染；Claude 的 edits 權限不被改成 Kimi 模式，DeepSeek id／alias 都正確解析。
- 無 key、離線、模型不存在、API 失敗時都沒有跨家 fallback，且原對話可重試。
- 主代理三家 × 子代理三家 × 支援 effort 的測試矩陣，驗證實際請求／CLI 參數，不只驗證儲存值。Kimi／DeepSeek→DeepSeek 必須是真正的原生 Agent，無 token、無 Hub child；其他組合的 broker 不得退化。
- 兩個並行原生卡片各自顯示正確子代理 id、工具進度與實際模型／effort；主模型與既有 `[secondary_model]` 不被設定流程覆蓋，機器全域預設的影響不冒充 per-session 隔離。
- 變更子代理預設後，舊子代理不中斷、新子代理才用新值。
- API 與持久化資料不回傳秘密；handoff 不含秘密欄位。
- `npm run check`、`npm test`（含真實 `KIMI_BIN`）、`npm run build:daemon` 全通過。

### 8.2 瀏覽器端對端

- 單一首頁可分別建立三家對話；舊對話不重建即可切換。
- 全域設定與每對話設定不互相覆蓋；重新整理後保留。
- 子代理預設與主模型控制清楚可分，實際子代理模型可見。
- 三套配色逐一套用到三家對話、首頁、設定、選單、權限與錯誤畫面；切模型不變色，reload 不變色。
- 桌面與手機寬度都能操作模型、子代理預設與外觀選擇。

## 9. 修改前基線

- `npm run check`：通過。
- 預設 `npm test`：132 passed / 0 failed / 23 skipped（缺少測試 PATH 中的 Kimi 與開發打包工具）。
- `KIMI_BIN=/path/to/kimi npm test`：154 passed / 0 failed / 1 skipped。
- 已依現有 lockfile 補齊開發相依套件；`npm run build:daemon` 已通過且生成物無差異，最終不得再略過 daemon bundle 同步檢查。
- Command Code 的真實最小呼叫已用 `agent-hub-deepseek/deepseek/deepseek-v4.1-flash` 成功；舊 OpenCode Go 額度錯誤不得再被當成 Command Code 的結果。

## 10. 平台能力參考

- [Kimi Code：Configuration files](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/config-files.html)：`[secondary_model]` 的模型池、default_effort、force 與 effort 解析順序。
- [Kimi Code：Providers and models](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/providers.html)：Kimi、Anthropic 與 OpenAI 相容供應商的原生協定。
- [Kimi Code：Agents and Sub-Agents](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/agents.html)：子代理 context、權限繼承與生命週期。
- [Kimi Code：Environment variables](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/env-vars.html)：process 級設定與 model override 的適用範圍。
- 文件只證明平台能力；Agent Hub 的 per-session API 與跨 runtime 行為仍以實際程式及本次測試為準。

## 11. DeepSeek V4.1 實作分工與邊界

沿用三個已完成盤點的 DS CLI session，不再增加探索代理；修正也 resume 原 session。禁止再派 Agent／AgentSwarm、禁止 git mutation、禁止讀取 `data/`、credentials 或秘密檔。

### DS1：統一後端、接續鏈與 broker

- 擁有：`server/store.js`、`server/runner.js`、`server/index.js`、`server/machines.js`、`server/deepseek-account.js`、`server/adapters/kimi-remote.js`、`server/handoff.js`（新）、`server/subagent-broker.js`（新）、`bridge/agent-hub-bridge.mjs`、bridge 的 MCP／hook 新檔，以及上述範圍的新測試。
- 完成：provider/model/effort 白名單、K↔D atomic switch、六向跨 runtime 接續鏈、chain history、portable transcript、3×3 broker、MCP/token/hook、權限與秘密防護。
- 不改 `server/adapters/claude*.js`、`server/claude-*.js`、`public/**`；需要 Claude 行為時依本規格介面呼叫，不得越區修改。

### DS2：Claude engine、daemon 與原生／broker Task

- 擁有：`server/adapters/claude.js`、`claude-mirror.js`、`claude-tools.js`、`server/claude-daemon.js`、`server/claude-link.js`、必要時同範圍測試；`bridge/claude-daemon.mjs` 只能由 `npm run build:daemon` 產生。
- 完成：handoff config 注入、每對話 Claude 子代理 model/effort、Claude→Kimi/DeepSeek broker request／response、實際模型事件、權限可見與 Hub offline 錯誤、daemon hash／bundle 同步。
- 使用 DS1 的 `runner.delegateToProvider` 契約，不改 runner/index/public；若介面不足，回報具體缺口，不自行越區。

### DS3：單一前端與三套配色

- 擁有：`public/index.html`、`public/js/**`、`public/css/**`。
- 完成：單一新對話首頁、三家分組模型、接續鏈單一聊天室與 leaf 導向、每對話子代理設定、實際模型顯示、三配色自由選且與 provider 解耦、舊 localStorage 遷移、桌面／手機可用。
- 只使用第 6 節 API，不改 server 或 tests；不得用 disabled／唯讀選項掩蓋 3×3 未完成。

### 主代理（本工作階段）

- 負責最終規格、跨區整合、code review、README、完整測試、真實 Kimi CLI／fake gateway／fake Anthropic 驗證、Chromium 桌面與手機端對端，以及正式服務部署前檢查。
- 所有子代理完成後逐項檢查第 2、8 節；任何紅測、無效選項、靜默 fallback、秘密外洩或生成物不同步都不得交付。

## 12. 終端機與 Hub 永遠允許並存操作

使用者明確接受終端機 Kimi 與 Hub 同時操作同一對話的風險，包括狀態或寫入互相覆蓋。自本變更起，不再以這個風險為由鎖定聊天室；這是永久產品行為，不是每次操作前確認的暫時解除。

### 12.1 操作路由

- `owner === 'tui'`、`controllable !== true` 或同資料夾的 `guess` 都不能成為 `cannotSend()` 拒絕送出的理由；新舊對話、一般訊息與 Hub 自動送出一律適用。
- 只有對話確實位於 terminal，且 `controllable === true` 時，才可使用既有 `kimi.tui.input` 路徑。不得把 `null` 或缺少狀態視為可控。
- 不可控 terminal 的送出、模型／思考／權限設定、停止、權限與問題回答、指令、移到背景，都使用原有 Kimi Server API。不得暗中嘗試 TUI，也不得要求關閉 terminal、輸入 `/web` 或改用 `kimi-hub` 才能操作。
- terminal 狀態在操作之間改變時，以當下狀態重新選路；舊的 terminal queue 不得讓後續 API 操作誤發 TUI 指令。
- `applyDefaults()` 原本對 terminal 的跳過維持不變；這是既有對話預設保護，不是唯讀鎖。舊 `/unlock` API 可為相容保留，但正常 UI 與操作流程不得依賴它。

### 12.2 介面與不變項目

- 不再隱藏輸入框，不顯示「唯讀」「只能看」「仍要從這裡操作」或自動暫停的 terminal 唯讀提示，也不因 terminal 全面禁止圖片附件。
- terminal 可保留為資訊標籤；說明必須區分「由 Hub 輸入到可控終端機」與「經 Kimi Server API 操作」，不得宣稱不可控 terminal 會收到 TUI 輸入。
- 不再承諾 Hub 能避免雙寫；也不新增每次確認或警告來阻擋操作。
- 本變更只移除 Kimi terminal 占用鎖，不改 Claude 的既有安全限制、模型融合、三套配色、DeepSeek V4.1 Flash + max 子代理預設、MCP 或 token 權限邊界。

### 12.3 驗收

- 真實 `owner=tui / controllable=false` 的 terminal 保持開著時，不呼叫 `/unlock`，Hub 仍能送出並收到模型回覆；同資料夾 `guess` 的舊對話也一樣。
- 不可控 terminal 的 send、configure、interrupt、respond、command 與 moveToBackground 均有測試證明走 API，且 TUI 呼叫為零；可控 terminal 的既有 TUI 測試不得退化。
- 瀏覽器在 terminal／guess 狀態仍有可用輸入框、附件、模型與子代理控制，沒有唯讀標籤或解鎖按鈕。
- `npm run check`、`npm run build:daemon` 與 `KIMI_BIN=/path/to/kimi npm test` 全通過後才部署；部署後再驗證本機、公網與實際 API 操作。

## 13. DeepSeek API key 號池與同閘道自動輪替

> **2026-10-28 用戶裁示（取代本節原本的「只在同閘道內輪替」）**：「直接輪替就好 自動切換下一把key 無論是否跨家」。所有閘道的 key 放在同一份有順序的清單，目前這把額度真的用完就換清單裡的下一把，不論哪一家；換家時網址、模型 id、session 標頭名稱一起換，且仍須在尚未向下游送出任何 byte 時才透明重送。判定「用完」只看閘道真的回的額度錯誤（HTTP 400／402／403／429 帶明確額度、點數、用量上限字樣）、用戶手動標記、真實請求的預檢失敗；回升時間只用閘道訊息寫明的時間（或 Retry-After），沒寫記「到期未知」並靠真實請求確認，不自己猜、不用用量估算。模型白名單不變。下文 13.1～13.3 凡寫「同閘道」處以此為準。舊連接器（只宣告 `pool`）仍只在 Hub 給它的那一個閘道內輪替；宣告 `pool_cross` 的連接器拿到整份清單。

每個 DeepSeek 閘道的 key 以一份有順序的清單使用（儲存上仍是各閘道一個 pool，另有 `order` 與 `epoch`）。目前 key 遇到額度用盡時，自動使用清單裡的下一把可用 key；不得切到 Kimi、Claude 或另一個模型。

### 13.1 儲存、遷移與 API

- `data/deepseek.json` 繼續以 `0600` 保存，改為每閘道 `{ revision, activeId, keys[] }`；每把 key 有隨機穩定 `id`、秘密本体、`addedAt`、`exhaustedAt` 與狀態。舊 `keys[gateway]` 單字串在載入時遷移成一把，不清空使用者的 key。
- 新增 key 前仍用該閘道 `/models` 驗證；同閘道重複貼同一把只保留一筆。加入、刪除、指定使用中、重新啟用都要更新 revision 並推到 online Kimi server（包括尚未開過 DeepSeek 主對話、但原生子代理需要 provider 的機器）；已 provision 的離線機器也要保留在同步清單。刪到一把不剩時，沿用既有 provider remove 防護。
- `GET /api/deepseek` 每個閘道回 `keys: [{ id, hint, addedAt, active, exhaustedAt }]`、`keyCount` 與相容的 `hasKey/keyHint`；任何 API、事件與 log 都不得回傳完整 key。`PUT /api/deepseek` 沿用 `apiKey` 作為新增，另以白名單 `activateKeyId/removeKeyId/retryKeyId/clearKey` 操作；`POST /api/deepseek/test` 接受可選 `keyId`。
- 帳號狀態改變（包括 connector 回報輪替）要即時 broadcast，讓已開啟的設定頁與其他瀏覽器看到目前 key 與已用盡狀態。重新啟用成功才清除 `exhaustedAt`。
- 秘密只經既有認證的 Hub→bridge RPC 傳給需要的電腦；bridge state 也是 `0600`。不得放入 URL、瀏覽器、prompt、子代理 token 或錯誤訊息。文件與 UI 必須如實說明 key 會保存在 Hub 與受控 connector，不得再宣稱只存在 Hub。

### 13.2 本機輪替 proxy

採 connector 內的 **loopback-only OpenAI 相容 proxy**，而不是在多個聊天室之間搶改 Kimi 的共享 provider key：

- 新 connector 對外能力為 `pool: 1`，版本至少 `0.10.0`。Hub 傳 `kimi.deepseek.provision { gateway, models, pool: { revision, activeId, keys: [{ id, apiKey, exhaustedAt? }] } }`。Kimi provider 仍叫 `agent-hub-deepseek`，模型 id、thinking 與 CLI 行為不變，但其 base URL 指向 `127.0.0.1` 的 proxy，Kimi config 只放隨機本機憑證，不放整組上游 key。
- Proxy 只監聽 loopback、只接受自己的本機憑證，上游只允許既有 `GATEWAYS/DS_GATEWAYS` 白名單。不可讓 Hub 指定任意 URL，不可記錄 Authorization、完整 key 或 prompt。Request body 設合理上限；forward 時只重建必要 headers 並替換成目前上游 key。
- 每一把請求從當時 active key 開始。上游在**尚未向下游送出任何回覆 bytes 前**回覆可辨識的 quota/credit/balance exhausted 錯誤時，將該 key 標記 exhausted，循序試下一把；同一請求每把最多一次。HTTP 402/429 必須搭配明確 quota/credit/balance 訊號，或錯誤 code 明確是 `insufficient_quota/quota_exceeded/usage_limit` 等；403 upgrade_required、短暫 rate limit、網路錯、5xx 不得盲目輪替。**HTTP 401 例外（用戶 2026-10-29 裁示：任何一把 key 收到 401 就跳到順序上的下一把）**：尚未向下游送出任何 bytes 時，同一請求改用下一把重送；但 401 是「key 被拒絕」，不是額度用盡：key 進獨立狀態 `authFailedAt/authFailures/authRetryAt`、不編造重置時間、不讀 401 回應的文字；距上次失敗 1 分鐘後由真實請求探測，每再失敗一次間隔加倍、上限 60 分鐘（只是探測間隔，不是回升時間），成功即清除並回報證據；人按「清除標記」立即恢復。全部不能用時，訊息要分開列出認證失敗（HTTP 401）與額度用完。
- 若上游已開始串流，絕不重新執行該請求，避免重複文字、工具或檔案副作用。可標記已確認用盡的 key 供下一請求避開，但原錯誤必須如實往下游傳。全部 key 都用盡時回清楚的錯誤，不無限循環、不假稱成功。
- 同一 connector 的並行請求共用 key health 與 active pointer，但以 failed key id 做 compare-and-swap，避免多個失敗請求連續跳過多把。不同電腦可有各自實際 active key，Hub 顯示各機最近回報，不強行把它們寫回成同一把。
- Bridge 持久保存 pool，讓已設定的 DeepSeek 原生對話沿用；connector 必須在線，loopback proxy 才存在，這項依賴要在 UI／README 說明。Kimi 與 Claude 對話不依賴此 proxy。
- Bridge→Hub 用已認證 WebSocket 傳 `{ t:'deepseek.pool', gateway, machineId由server綁定, activeId, revision, keys:[{id, exhaustedAt?}] }`，不得含秘密。Hub 驗證 gateway/key id 並保存各機狀態，再更新公開帳號 projection。舊 connector 沒有 `pool:1` 時，一把 key 可沿用舊直連模式；多把必須明確要求更新，不得靜默只用第一把。

### 13.3 號池驗收

- 舊單 key 遷移、增加多把、重複 key、刪除、指定使用中、重新啟用、持久化與權限 `0600`；所有公開輸出掃不到完整 key。
- 兩把以上時第一把回 `insufficient_quota`，同一個串流 request 由第二把成功，Kimi 只看到一個回合、沒有重複工具或使用者訊息；模型與 max 不變。
- 並行兩個請求對同一把失效 key 不會把第三把無故跳過；所有 key 用盡時有明確錯誤。403、短暫 429 rate-limit、網路錯與 5xx 不輪替；401 輪替但記為認證失敗（不是用盡，見上）。
- 已送出部分 SSE 後不得重試。proxy 不聽非 loopback、不可指定任意外部位址，request 過大有錯誤，日誌與回報無秘密。
- 真實 Kimi CLI + fake gateway 驗證目前請求自動成功；舊 connector 多 key 明示升級；重啟後 pool 與目前狀態仍在。

## 14. 側邊欄依建立來源分類，子代理只歸父對話

「子session」是使用者指定的**外部來源分類名稱**，不等同技術上的 `parentId` 子代理節點，也不改變任何對話層級。

- 使用者在 Agent Hub 主動建立的邏輯聊天室（Kimi／Claude／DeepSeek、Hub 內 fork 與其跨 runtime 接續鏈）屬於主「聊天室」分類，預設展開，整類依 `updatedAt` 新到舊排序。
- 從終端機、`kimi web` 或其他 CLI／runtime 發現、且沒有 `parentId` 的外部 session 一律屬於「子session」。從 Hub 點開查看不改寫來源。
- **真正的 `parentId` 子代理 session 不得出現在側邊欄，包括「子session」分類。** 它只存在父聊天室的「子代理」面板，顯示自己的工具步驟、權限、狀態與回報；不得另開成主聊天室。直接開啟 child URL 時要提供父對話／父卡片導向，不能讓使用者看到空白的子代理面板而誤以為功能壞掉。
- Session 持久化 `origin: 'hub' | 'external'`，summary 帶出；`parentId` 永遠是 external 並供前端過濾。建立、fork、接續鏈要正確繼承，重新整理、Hub 重啟與換 runtime 後不改類。舊版沒有 origin 的 Hub store 以 hub 遷移，避免把既有主對話突然藏起來；之後新 attach 的 native session 明確記 external。
- 主列表只保留一個依更新時間排序的展開分類，不再讓日期或釘選產生第三種同層分類。舊釘選本機資料不清空，但新兩分類排序以其取代，移除已無作用的釘選選單。
- 「子session」只有一個可摺疊分類，名稱必須完全是 `子session`，顯示數量，預設摺疊；使用者展開狀態可保存。搜尋時可暫時展開有結果的分類，但不改保存的預設。分類只影響顯示，不能刪除、複製、改寫或停止任何 native／子代理 session。
- 每次平行委派都要有獨立父卡片與正確 childSessionId；不得重用其他任務的 synthetic 卡。既有錯接 child 要在 restore 時修復父卡與投影 parent，不能靠隱藏 sidebar 掩蓋連結錯誤。
- 驗收 Hub 新建三家對話都進主類；native／terminal 外部對話進子session；parentId child 不在側邊欄但在父面板有完整進度；接續鏈只有一列且類別不變；更新後排序正確；reload 後來源與摺疊狀態正確，桌面與手機均能操作。
