# AI 用量儀表板 (AITokenAnalysis)

本機 AI 用量儀表板：看各模型用量與預估金額，並找出**最花費 token 的語句與 session**，以利後續改善。

資料全部來自本機記錄檔，除了抓取模型定價外**不會對外傳送任何資料**；服務只綁定 `127.0.0.1`。

## 桌面版（最簡單，建議一般同仁使用）

從 [Releases](https://github.com/cs60811/AITokenAnalysis/releases/latest) 下載
`AITokenAnalysis-Setup-x.y.z.exe` 雙擊安裝（也有免安裝的 `Portable` 版）。
**不需要 Node.js、不需要 ccusage、不需要系統管理員權限**（安裝到使用者目錄）。

- 首次執行若出現 SmartScreen 藍色警告（未簽章），點「**其他資訊**」→「**仍要執行**」。
- 資料一樣全在本機：伺服器只綁 `127.0.0.1` 隨機 port，快取放在 `%APPDATA%\AITokenAnalysis\cache`。
- 有新版本時右下角會出現通知，點「前往下載新版」會開啟 Releases 頁面下載安裝。
- 前提不變：本機要有 Claude Code 的使用紀錄（`~/.claude/projects`）。

維護者建置與發版：

```bash
npm run dist   # 產出 release/AITokenAnalysis-Setup-x.y.z.exe 與 Portable 版
```

發版流程：`npm version minor` → push master → `npm run dist` → 把 Setup／Portable 上傳到
GitHub Release。桌面版與 zip 版的更新通知都比對 master 上 `package.json` 的 `version`，
**沒 bump 版號使用者就不會收到通知**。公司網路擋 GitHub 大檔時，建置前先設
`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 與
`ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`。

## 網頁版快速開始（開發者／進階同仁）

1. 安裝 [Node.js](https://nodejs.org/zh-tw) **20 以上版本**（安裝時一路「下一步」即可）。
2. 取得本專案：git clone，或解壓縮 zip（分享 zip 時請排除 `node_modules/` 與 `.cache/`）。
3. **雙擊 `start.bat`** —— 首次執行會自動安裝相依套件（含 ccusage），完成後自動開啟瀏覽器。
   之後每次使用也是雙擊它；關閉該視窗即停止伺服器。

前提：本機要有 Claude Code 的使用紀錄（`~/.claude/projects`），否則沒有資料可分析。
所有資料都留在本機，除了抓取模型定價外不對外連線。

熟悉指令列的話也可以直接：

```bash
npm install      # 相依套件已含 ccusage，毋須另外全域安裝
npm start        # http://127.0.0.1:4317
npm run verify   # 對帳驗證（見下方）
npm test         # 單元測試（見下方）
npm run coverage # 單元測試 + 覆蓋率報告
```

### 匯出用量 JSON（回報用）

右上角「**匯出**」→ 輸入工號、選擇使用位置（輸入一次會記住）→ 下載 `工號_起日_迄日_使用位置.json`。
日期範圍依當時選擇的時間範圍；內容為
`ccusage claude daily --since 起日 --until 迄日 --mode calculate --breakdown --json` 的原始輸出。

使用位置代碼：`company`＝公司桌機、`nb`＝自備筆電、`home`＝家中使用。

### 自動更新

儀表板啟動後會檢查遠端是否有新版本（每 30 分鐘至多一次），有新版時**畫面右下角**會出現通知；
按「忽略此版」則該版本不再提醒。依安裝方式分兩種模式：

| 安裝方式 | 檢查方式 | 按鈕行為 |
|---|---|---|
| **桌面版 exe** | 比對 GitHub 上 `package.json` 的 `version` | 「前往下載新版」：開啟 Releases 頁面，下載新版安裝 |
| **git clone** | `git fetch` 比對追蹤分支 | 「立即更新」：自動 `git pull --ff-only`、重裝相依並重啟，頁面自動重整 |
| **下載 zip** | 比對 GitHub 上 `package.json` 的 `version` | 「前往下載新版」：開啟 zip 下載，解壓覆蓋後重跑 `start.bat` |

- git 模式在本機有未提交變更時會拒絕自動更新，以免蓋掉修改。
- **維護者發版**：改版時執行 `npm version minor`（自動 bump 版號＋commit＋tag）再 push——
  zip 使用者的更新通知是靠版號比對，**沒 bump 版號 zip 使用者就不會收到通知**。

## 三個分頁

| 分頁 | 回答什麼 | 資料來源 |
|---|---|---|
| **模型用量與成本** | 各模型花了多少、每日趨勢、token 組成 | `ccusage`（涵蓋 Claude / Codex / Gemini） |
| **語句排行** | 哪一句 prompt 最燒錢（點擊展開全文） | 自行解析 JSONL（Claude Code） |
| **Session 排行** | 哪個 session 最燒錢、ccusage 漏算多少 | 自行解析 JSONL（Claude Code） |

## 兩個重要發現（也是本專案存在的理由）

### 1. ccusage 無法回答「哪一句最花錢」
`ccusage session --json` 的 `period` 只有一個 session UUID，沒有專案名稱、沒有 prompt 原文。
因此逐句歸因必須自行解析 `~/.claude/projects/**/*.jsonl`。

### 2. ccusage 的 session 統計會漏算 workflow subagent 成本
實測 MS-Web 的 `ced37f19`：

| 資料範圍 | 金額 |
|---|---|
| 主記錄 (main) | $86.89 |
| + 一般 subagents | **$87.41** ← ccusage 報 $87.45 |
| + workflow agents | **$112.66** ← 實際 |

**該 session 有 $25.24（22%）的 opus 用量在 `ccusage session` 中完全看不到。**
（`ccusage daily`/`monthly` 則有含 workflow，只有 session 檢視有此盲點。）

儀表板因此**並列顯示兩個數字**：`ccusage 數字` 與 `含 workflow 實際成本`，差額以顏色標示。

## 成本計算

執行期抓 [LiteLLM 定價](https://github.com/BerriAI/litellm)，失敗時退回 `.cache/prices.json`，再退回內建 `prices.json`。
**未知模型顯示 `—`，絕不顯示 $0**（`ccusage -O/--offline` 會對未知模型靜默回傳 $0.00，因此本專案不使用該選項）。

公式（已驗證與 ccusage 逐位相同至小數第 8 位）：

```
cost = input  * input_cost_per_token
     + output * output_cost_per_token
     + cache_creation.ephemeral_5m_input_tokens * cache_creation_input_token_cost
     + cache_creation.ephemeral_1h_input_tokens * cache_creation_input_token_cost_above_1hr
     + cache_read_input_tokens * cache_read_input_token_cost
```

### fast 模式另有加價

`/fast` 用的是同一個模型但收取加價，記錄檔以 `usage.speed === "fast"` 標記。
LiteLLM 沒有 speed 這個維度、也沒有 `claude-opus-5-fast` 條目，因此這類訊息一度全部
以標準費率計算，本機少算 **$33.04（全域總額的 2.06%）**。

加價倍率改從 [models.dev](https://models.dev) 的 `experimental.modes.fast` 取得
（ccusage 讀的也是這份，其識別條件 `provider.body.speed === "fast"` 正是記錄檔裡那個欄位），
**只取比值**：絕對費率與 5m/1h 快取寫入切分仍以 LiteLLM 為準，因為 models.dev 沒有 1h 這個概念。
實測 opus-4-8 與 opus-5 的 fast 在 input／output／快取讀／快取寫四項都是精確 2.00 倍。

內部視為虛擬模型 `<模型>-fast`（與 ccusage 報的名稱一致），所以：

- 逐模型與 ccusage 對得起來，不是「我們 1 列 vs ccusage 2 列」
- 加價獨立成一列，不會被稀釋進母模型——fast 讓成本直接翻倍，這是該被看見的訊號
- 快取寫入分析、改善建議的費率欄都跟著是加價後的數字，費率解釋得了金額

倍率**按每個計價單元**解析而非每行：fast 訊息裡的 advisor 迭代自己沒有 `speed`，
ccusage 也不對它加價。models.dev 短暫連不上時退回磁碟上的前次良好副本；
真的查不到倍率就照標準費率計價（下限，不是 $0）並記錄下來，由 verify 直接失敗。

## 為什麼一律以「成本」排序，不以 token 數排序

實測 **94.2% 的 token 是快取讀取**，但其費率僅約輸入的 1/10。
以 token 數排序會把便宜的快取密集語句推到最前面，把真正貴的埋掉——正好與「找出浪費」的目標相反。

- 快取讀取高且便宜 = 正常現象（弱化顯示）
- **快取寫入才是可改善的訊號**（1 小時寫入約為輸入的 2 倍價）

## 歸因模型

> 一句 prompt 的成本 = 它引發的所有支出。

一個 turn = 一句真人 prompt + 其 `parentUuid` 鏈下所有 assistant 訊息，直到下一句真人 prompt。
該 turn 觸發的 subagent / workflow 成本會**上捲回這句 prompt**：

- subagent → 其 `agentId` 出現在主記錄某行的 `toolUseResult.agentId`
- workflow agent → 其 `runId`（`wf_*` 目錄名）出現在 `toolUseResult.runId`

兩者都會落在某個 turn 內，再沿 `parentUuid` 往上找到擁有它的 prompt。

### 兩個非做不可的細節

1. **dedup 必須跨 session 全域執行。** 續接（resume）session 會把先前對話重播進新檔，實測有 **592 則訊息、$133.64 重複**。只在單一 session 內 dedup 會讓總額高估 14%。
   系統依時間順序處理，讓**原始 session** 保留成本（續接並沒有再花一次錢）。
2. **語句分類器**：實測 757 筆有文字的 user 行中有 584 筆是真人動作，其餘 23% 是 IDE 事件、local-command 管線、任務通知等噪音。prompt 有三種格式：`string`、`array[text]`、`array[image,text]`。

   **slash 指令算真人動作**，不是噪音——`/code-review` 是人按下去的，而且很貴。曾把它當噪音過濾，導致 15 個以指令開場的 session 完全沒有可歸因的 prompt，$63.59 變成孤兒。只有「有 `<command-args>` 標籤但內容為空」的純設定指令（`/clear`、`/effort` 等，成本皆為 $0.00）會被排除。

## 驗證 (`npm run verify`)

以實測值作為回歸錨點，ccusage 行為改變或解析器走鐘時會直接失敗，而不是靜默算錯錢：

1. 成本公式精確回歸（opus `85.52876450`、sonnet `1.36267350`，8 位小數）
2. dedup 不變式（主記錄 731 筆 → 249 筆唯一）
3. 語句分類器有效過濾噪音
4. 三層成本切分（own / subagent / workflow）
5. 未歸因成本 < 5%
6. **fast 加價有被計價**：任何 `speed=fast` 的模型查不到倍率就失敗，不讓它靜默用半價
7. **全域對帳閘門**：本工具總額 vs `ccusage daily`，容差 1%（實測 0.00%，逐模型皆分毫不差）

> 曾有約 1% 的落差（ccusage 略高），後來擴大到 2% 以上，已找出並修正兩個各佔約 1% 的原因：
> - **串流訊息的部分寫入**：同一則 assistant 訊息會以相同 `id|requestId` 反覆寫入記錄檔，
>   `output_tokens` 逐次增長（本機 1307 組，無一例外遞增）。原本取第一筆＝取到未寫完的計數。
> - **advisor 層**：high effort 的回合會另外請 advisor 模型作答，該次請求記在
>   `usage.iterations[]` 的 `advisor_message`，且**不含**在最外層 usage 內
>   （本機 15030 筆帶 iterations 的記錄，最外層一律等於非 advisor iterations 之和）。
>
> 之後 fast 模式上線，同一個閘門再次紅燈（2.06%），成因與上述兩者無關，見「成本計算」的
> fast 段落。三次都不是容差問題，容差始終維持 1%。
>
> 容差留 1% 是給快取時間差：儀表板拿即時解析結果比對最舊 5 分鐘的 ccusage 文件。

### local agent 排程任務（兩邊都看不到的支出）

桌面版 local agent mode（在 UI 設定的排程任務）把記錄寫在
`%APPDATA%\claude\local-agent-mode-sessions`，不在 `~/.claude/projects` 底下，**ccusage 也不讀這個目錄**。
實測本機 483 個 message id 與主目錄的 7611 個完全不重疊，確定是額外的錢。

首頁以獨立卡片顯示（跟著日期篩選走），**刻意不計入總成本**：對帳閘門要拿我們的數字比 ccusage 的，
把 ccusage 看不到的錢加進去會讓那道閘門永遠有雜訊。

兩個實作上的坑：每則訊息會同時寫進 `audit.jsonl` 和巢狀的 `.claude/projects/**`，而 audit 副本
**沒有 `requestId`**，共用的 `dedupKey()` 會退化成 uuid 而重複計算（金額會翻成 2.6 倍），
故此模組改以 `message.id` 為鍵；另外每個 run 都帶一份 skill 套件的副本，遞迴掃描要跨 ~430 個目錄
（~85ms／次），因此改為直接讀取已知的兩個固定位置。

## 單元測試 (`npm test`)

Vitest，351 個測試，覆蓋率 **98.5% 敘述／91.1% 分支／99.6% 行數**。

```bash
npm test         # 跑一次
npm run test:watch
npm run coverage # 加上覆蓋率報告
```

`npm run verify` 和 `npm test` 問的是**兩個不同的問題**，兩個都要過：

- **`verify`** 問「總額對不對」——拿真實語料跟即時的 `ccusage daily` 對帳到分。它是這個工具的存在理由，但它只看得到總數，看不出某個函式的邊界條件壞掉。
- **`test`** 問「每個決策還在不在」——用合成的 JSONL／目錄樹釘住那些**用實測換來、而且看起來像 bug 其實不是**的行為。例如：串流訊息只算最後一次寫入、找不到歸屬的 agent 寧可留在 `__unattributed__` 也不用時間戳去猜、沒有公布 fast 溢價的模型以基礎費率計價（$0 是謊話）、workflow 層要和 `ccusageCost` 分開。這些光看總額都是對的，改壞了也不會被 `verify` 抓到。

測試不碰網路、不碰 `~/.claude`，也不依賴這台機器的語料——定價用 `test/fixtures/` 的固定費率表，語料用臨時目錄裡的合成 JSONL，所以金額都能斷言到精確數字。

以下**刻意不納入覆蓋率**（理由記在 `vitest.config.js`）：`server.js`（載入即綁 port）、`verify.js`（呼叫 ccusage 對帳）、`update.js`（呼叫 git／GitHub 並重啟程序）——這三個是整合面，由 `npm run verify` 和實際跑起來涵蓋；`public/app.js` 的 DOM 膠水則以實際跑頁面驗證，其純邏輯已抽到 `public/lib.js`（100% 敘述覆蓋）。

## 架構

```
src/
  server.js        Express，只綁 127.0.0.1
  config.js        路徑、port、容差常數
  ccusage.js       以 node 直接執行 ccusage 的 cli.js（見下）
  ccusage-cache.js ccusage 全量文件快取（含 SWR 背景更新）
  pricing.js       LiteLLM 抓取 + fallback + costOf()
  discover.js      遞迴掃描，依層級標記 main / subagent / workflow
  parser.js        逐行解析 + isRealPrompt() 分類器
  attribute.js     turn 歸因 + 三層成本切分
  cache.js         全域指紋快取
  aggregate.js     API 資料整形
  localagent.js    local agent 排程任務支出（ccusage 看不到的部分）
  update.js        自動更新（git／zip 兩種模式）
  verify.js        對帳驗證
public/
  index.html       版面
  app.js           DOM、圖表、fetch（以 module 載入）
  lib.js           前端純邏輯：格式化／分桶／排序／驗證（可單元測試）
  style.css        樣式
  vendor/          chart.umd.min.js
test/              Vitest 單元測試，與 src/ 檔名一一對應
```

### 兩個實作上的取捨

- **`ccusage.js` 不用 shell 執行。** PATH 上的 `ccusage` 是 `.cmd`/`.ps1`/sh shim；Node 自 CVE-2024-27980 修補後拒絕在 `shell:false` 下執行 `.cmd`（會得到 `spawn EINVAL`）。改為解析套件的 bin 入口後以 `node cli.js` 直接執行——沒有 shell、沒有引號跳脫、沒有注入面。
- **快取是全域指紋，而非每個 session 各自快取。** 因為 dedup 必須跨 session，session 之間彼此相依，各自快取會不正確。全量重算 340 檔／104MB 實測約 **650ms**，指紋檢查約 9ms，因此整份快取更簡單也更安全。

### 配色

配色取自 dataviz 參考色盤，並以 `validate_palette.js` 在**淺色與深色兩種模式**下驗證，非目視挑選。
最初的深色三色組（藍／紫／橘）**未通過**：紫與藍在紅色盲下 ΔE 僅 2.5，等同無法分辨。
最終採用藍→青→橘（淺色 ΔE 25.0、深色 27.6），快取讀取則使用弱化灰。
