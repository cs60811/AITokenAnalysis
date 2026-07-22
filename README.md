# AI 用量儀表板 (AITokenAnalysis)

本機 AI 用量儀表板：看各模型用量與預估金額，並找出**最花費 token 的語句與 session**，以利後續改善。

資料全部來自本機記錄檔，除了抓取模型定價外**不會對外傳送任何資料**；服務只綁定 `127.0.0.1`。

## 快速開始（同仁安裝指引）

1. 安裝 [Node.js](https://nodejs.org/zh-tw) **20 以上版本**（安裝時一路「下一步」即可）。
2. 取得本專案：git clone，或解壓縮 zip（分享 zip 時請排除 `node_modules/` 與 `.cache/`）。
3. **雙擊 `start.bat`** —— 首次執行會自動安裝相依套件（含 ccusage），完成後自動開啟瀏覽器。
   之後每次使用也是雙擊它；關閉該視窗即停止伺服器。

前提：本機要有 Claude Code 的使用紀錄（`~/.claude/projects`），否則沒有資料可分析。
所有資料都留在本機，除了抓取模型定價外不對外連線。

熟悉指令列的話也可以直接：

```bash
npm install    # 相依套件已含 ccusage，毋須另外全域安裝
npm start      # http://127.0.0.1:4317
npm run verify # 對帳驗證（見下方）
```

### 匯出用量 JSON（回報用）

右上角「**匯出**」→ 輸入工號、選擇使用位置（輸入一次會記住）→ 下載 `工號_起日_迄日_使用位置.json`。
日期範圍依當時選擇的時間範圍；內容為
`ccusage claude daily --since 起日 --until 迄日 --mode calculate --breakdown --json` 的原始輸出。

使用位置代碼：`company`＝公司桌機、`nb`＝自備筆電、`home`＝家中使用。

### 自動更新

儀表板啟動後會檢查遠端是否有新版本（`git fetch` 比對追蹤分支，每 30 分鐘至多一次）。
有新版時**畫面右下角**會出現通知，按「**立即更新**」即自動 `git pull --ff-only`、
重新安裝相依並重啟伺服器，完成後頁面自動重新整理；按「忽略此版」則該版本不再提醒。

- 需以 **git clone** 取得專案才有此功能（zip 使用者請重新下載解壓）。
- 本機有未提交的變更時會拒絕自動更新，以免蓋掉修改。

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
2. **語句分類器**：實測 551 筆有文字的 user 行中只有 360 筆是真人輸入，其餘是 IDE 事件、slash command 等噪音。prompt 有三種格式：`string`、`array[text]`、`array[image,text]`。

## 驗證 (`npm run verify`)

以實測值作為回歸錨點，ccusage 行為改變或解析器走鐘時會直接失敗，而不是靜默算錯錢：

1. 成本公式精確回歸（opus `85.52876450`、sonnet `1.36267350`，8 位小數）
2. dedup 不變式（主記錄 731 筆 → 249 筆唯一）
3. 語句分類器有效過濾噪音
4. 三層成本切分（own / subagent / workflow）
5. 未歸因成本 < 5%
6. **全域對帳閘門**：本工具總額 vs `ccusage daily`，容差 2%（實測 ~1.0%）

> 對帳有約 1% 的既知落差（ccusage 略高）。已排除：解析範圍不足、跨 session 重複、未定價模型。
> 這 1% 已足以確認金額正確，故以 2% 作為容差；欲進一步收斂需比對 ccusage 內部實作。

## 架構

```
src/
  server.js     Express，只綁 127.0.0.1
  config.js     路徑、port、容差常數
  ccusage.js    以 node 直接執行 ccusage 的 cli.js（見下）
  pricing.js    LiteLLM 抓取 + fallback + costOf()
  discover.js   遞迴掃描，依層級標記 main / subagent / workflow
  parser.js     逐行解析 + isRealPrompt() 分類器
  attribute.js  turn 歸因 + 三層成本切分
  cache.js      全域指紋快取
  aggregate.js  API 資料整形
  verify.js     對帳驗證
public/         index.html / app.js / style.css / vendor/chart.umd.min.js
```

### 兩個實作上的取捨

- **`ccusage.js` 不用 shell 執行。** PATH 上的 `ccusage` 是 `.cmd`/`.ps1`/sh shim；Node 自 CVE-2024-27980 修補後拒絕在 `shell:false` 下執行 `.cmd`（會得到 `spawn EINVAL`）。改為解析套件的 bin 入口後以 `node cli.js` 直接執行——沒有 shell、沒有引號跳脫、沒有注入面。
- **快取是全域指紋，而非每個 session 各自快取。** 因為 dedup 必須跨 session，session 之間彼此相依，各自快取會不正確。全量重算 340 檔／104MB 實測約 **650ms**，指紋檢查約 9ms，因此整份快取更簡單也更安全。

### 配色

配色取自 dataviz 參考色盤，並以 `validate_palette.js` 在**淺色與深色兩種模式**下驗證，非目視挑選。
最初的深色三色組（藍／紫／橘）**未通過**：紫與藍在紅色盲下 ΔE 僅 2.5，等同無法分辨。
最終採用藍→青→橘（淺色 ΔE 25.0、深色 27.6），快取讀取則使用弱化灰。
