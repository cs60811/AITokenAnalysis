import path from 'node:path';
import { billableParts, costOf, hasRates, tokensOf } from './pricing.js';
import {
  dedupKey,
  finalUsageByKey,
  firstTimestamp,
  isBillable,
  isRealPrompt,
  promptTextOf,
  readLines,
  snippet,
  textOf,
} from './parser.js';
import { allFilesOf } from './discover.js';

const UNATTRIBUTED = '__unattributed__';
const UNATTRIBUTED_TEXT = '(未能歸因至任何 prompt)';
const TASK_ID_RE = /<task-id>\s*([^<\s]+)\s*<\/task-id>/;

/** Agent 記錄檔名為 `agent-<agentId>.jsonl`；中間那段就是 id。 */
const AGENT_FILE_PREFIX_RE = /^agent-/;
const JSONL_EXT_RE = /\.jsonl$/;
const agentIdOf = (file) => path.basename(file).replace(AGENT_FILE_PREFIX_RE, '').replace(JSONL_EXT_RE, '');

/**
 * 主記錄完全沒有時間戳的 session 所使用的排序鍵。
 * 它排在所有真實 ISO 日期之後，因此無法定日期的 session 會最後才處理，
 * 也就絕不會把重播的訊息從「有日期」的 session 手上搶走。
 */
const NO_TIMESTAMP_SORT_KEY = '9999';

/* ── 累加桶 ───────────────────────────────────────────────────────────────── */

function emptyTokens() {
  return { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
}

function addTokens(dst, src) {
  for (const k of Object.keys(dst)) dst[k] += src[k] ?? 0;
}

function newBucket() {
  return {
    ownCost: 0,
    subagentCost: 0,
    workflowCost: 0,
    tokens: emptyTokens(),
    byModel: new Map(), // model -> { cost, tokens }
    unpricedModels: new Set(),
  };
}

function addToModel(bucket, model, cost, tokens) {
  let m = bucket.byModel.get(model);
  if (!m) {
    m = { cost: 0, tokens: emptyTokens() };
    bucket.byModel.set(model, m);
  }
  m.cost += cost ?? 0;
  addTokens(m.tokens, tokens);
}

/**
 * 把一個可計費部分定價後，累加進 `into` 裡的每一個桶，記在 `field` 這個層級。
 *
 * 無法定價的模型只貢獻「token」和它的名字，絕不貢獻金額、也絕不產生 byModel 列：
 * UI 會為它顯示「—」，而一列 $0 會被讀成「這是免費的工作」，而不是「這是我們算不出
 * 價格的工作」。這條規則只存在這一個地方 —— 以前主記錄迴圈和 agent 檔案迴圈各有一份。
 */
function addPart(into, field, model, usage) {
  const tokens = tokensOf(usage);
  const priced = hasRates(model);
  const cost = priced ? costOf(usage, model) ?? 0 : 0;
  for (const bucket of into) {
    addTokens(bucket.tokens, tokens);
    if (!priced) {
      bucket.unpricedModels.add(model);
      continue;
    }
    bucket[field] += cost;
    addToModel(bucket, model, cost, tokens);
  }
}

/**
 * 把整份 agent 記錄的總計，以 `field` 這個層級併入 `into` 裡的每一個桶。
 *
 * agent 檔案是累加進它自己的 `ownCost` —— 那就是該 agent 自身的支出。
 * 它屬於哪一「層」（subagent 還是 workflow）是呼叫端根據「檔案在哪裡被找到」
 * 做的決定，不是檔案本身的性質。
 */
function mergeBucket(into, field, src) {
  for (const dst of into) {
    dst[field] += src.ownCost;
    addTokens(dst.tokens, src.tokens);
    for (const [model, v] of src.byModel) addToModel(dst, model, v.cost, v.tokens);
    for (const m of src.unpricedModels) dst.unpricedModels.add(m);
  }
}

/* ── 讀取記錄 ─────────────────────────────────────────────────────────────── */

/**
 * `lines` 裡所有尚未被先前檔案認領的可計費 (model, usage) 部分。
 *
 * 「認領」是刻意具破壞性的：`seen` 會隨著我們 yield 而長大，而且它跨每個檔案、
 * 每個 session 共用（見 analyzeAll）。續接一個 session 會把先前的對話重播進新的記錄檔，
 * 所以有 592 則、價值 $133.64 的訊息各出現在兩個檔案裡；少了這個共用集合，
 * 總額會膨脹 14%。
 *
 * 迭代順序是有承重作用的 —— 先被迭代到的那一方會保住重播的訊息 ——
 * 所以呼叫端不可以在這周圍重排檔案或行的順序。
 *
 * finalUsageByKey 是逐檔建立的：串流訊息只有最後一次寫入是完整的，而那也是 ccusage
 * 採計的那一次。這裡 yield 的是「第一次」出現的位置，好讓決定成本歸屬到哪個 turn 的
 * parentUuid 鏈保持完整。
 */
function* claimBillableParts(lines, seen) {
  const finalUsage = finalUsageByKey(lines);
  for (const line of lines) {
    if (!isBillable(line)) continue;
    const key = dedupKey(line);
    if (seen.has(key)) continue;
    seen.add(key);
    for (const part of billableParts(finalUsage.get(key), line.message.model)) {
      yield { line, model: part.model, usage: part.usage };
    }
  }
}

/** 把單一份 agent 記錄（subagent 或 workflow）轉成一個記錄它自身支出的桶。 */
function bucketOfAgentFile(file, seen) {
  const bucket = newBucket();
  for (const { model, usage } of claimBillableParts(readLines(file), seen)) {
    addPart([bucket], 'ownCost', model, usage);
  }
  return bucket;
}

/**
 * session 層級的事實，從「每一行」讀取 —— 包含不可計費的行，以及已被前一個 session
 * 認領走的行。一則被去重掉的訊息，仍然能告訴我們這個 session 最後活動的時間和執行位置。
 */
function scanSessionMeta(lines) {
  let cwd = null;
  let gitBranch = null;
  let lastActivity = null;
  for (const line of lines) {
    cwd ??= line.cwd ?? null;
    gitBranch ??= line.gitBranch ?? null;
    if (line.timestamp && (!lastActivity || line.timestamp > lastActivity)) {
      lastActivity = line.timestamp;
    }
  }
  return { cwd, gitBranch, lastActivity };
}

/* ── turn ─────────────────────────────────────────────────────────────────── */

function newTurn({ promptId, sessionId, text, timestamp = null, cwd = null, gitBranch = null }) {
  return { promptId, sessionId, text, snippet: snippet(text), timestamp, cwd, gitBranch, ...newBucket() };
}

/**
 * 依記錄順序，為每個真實的使用者 prompt 建立一個 turn，另外加上 UNATTRIBUTED 這個
 * 收容用的桶。`order` 為呼叫端保留記錄順序；成本迴圈則是透過那個 map 去查歸屬。
 */
function mintTurns(session, mainLines) {
  const turns = new Map();
  const order = [];
  for (const line of mainLines) {
    if (!isRealPrompt(line)) continue;
    turns.set(
      line.uuid,
      newTurn({
        promptId: line.uuid,
        sessionId: session.sessionId,
        text: promptTextOf(line),
        timestamp: line.timestamp ?? null,
        cwd: line.cwd ?? null,
        gitBranch: line.gitBranch ?? null,
      }),
    );
    order.push(line.uuid);
  }
  turns.set(UNATTRIBUTED, newTurn({ promptId: UNATTRIBUTED, sessionId: session.sessionId, text: UNATTRIBUTED_TEXT }));
  return { turns, order };
}

/**
 * 沿著 parentUuid 往樹上走，找出擁有這一行的那個真實 prompt。
 *
 * 會把走過的整條鏈都記憶起來，連 null 結果也記：走不到的行就維持走不到，不會被重走一次；
 * 而那個 null 正是 buildAgentIndexes 的使用端那些 `??` fallback 所依賴的東西。
 */
function createOwnerResolver(byUuid) {
  const cache = new Map();
  return function ownerPromptOf(uuid) {
    const chain = [];
    let cur = uuid;
    while (cur) {
      if (cache.has(cur)) break;
      const line = byUuid.get(cur);
      if (!line) {
        cur = null;
        break;
      }
      chain.push(cur);
      if (isRealPrompt(line)) break;
      cur = line.parentUuid ?? null;
    }
    const owner = cur && cache.has(cur) ? cache.get(cur) : cur;
    for (const u of chain) cache.set(u, owner);
    return owner ?? null;
  };
}

/**
 * 主檔案中會指名某個被派生 agent 的那些行，依三種能連回「派生它的 turn」的 id 建索引。
 *
 * 存的是原始的回溯結果，連 null 也存：如果寫入 UNATTRIBUTED，就會讓 ownerOfAgent 裡
 * 那些 `??` fallback 對「正好需要它們的那些 agent」變成死碼 —— 因為鍵是存在的，
 * 只是裡面裝著哨兵值。
 */
function buildAgentIndexes(mainLines, ownerPromptOf) {
  const byAgentId = new Map();
  const byRunId = new Map();
  const byTaskId = new Map();
  for (const line of mainLines) {
    const r = line.toolUseResult;
    if (r && typeof r === 'object') {
      const owner = ownerPromptOf(line.uuid);
      if (r.agentId) byAgentId.set(r.agentId, owner);
      if (r.runId) byRunId.set(r.runId, owner);
    }
    // 背景任務會在 <task-notification> 裡宣告它的 agent id。只有帶 uuid 的那些副本
    // 才可用 —— 同樣的文字也會出現在 `type: "queue-operation"` 的行上，而那種行既沒有
    // uuid 也沒有 parentUuid，因此在樹上沒有位置可以往上走。
    if (!line.uuid) continue;
    const txt = textOf(line.message?.content);
    if (!txt?.includes('<task-notification>')) continue;
    const m = TASK_ID_RE.exec(txt);
    if (m && !byTaskId.has(m[1])) byTaskId.set(m[1], ownerPromptOf(line.uuid));
  }
  return { byAgentId, byRunId, byTaskId };
}

/** 把一個桶轉換成 API 與 UI 實際使用的資料格式。 */
function finishBucket(b, extra = {}) {
  const ccusageCost = b.ownCost + b.subagentCost;
  const t = b.tokens;
  return {
    ...extra,
    ownCost: b.ownCost,
    subagentCost: b.subagentCost,
    workflowCost: b.workflowCost,
    ccusageCost,
    trueCost: ccusageCost + b.workflowCost,
    tokens: t,
    totalTokens: t.input + t.output + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead,
    byModel: [...b.byModel.entries()]
      .map(([model, v]) => ({ model, cost: v.cost, tokens: v.tokens }))
      .sort((a, z) => z.cost - a.cost),
    unpricedModels: [...b.unpricedModels],
  };
}

const TURN_FIELDS = ['promptId', 'sessionId', 'text', 'snippet', 'timestamp', 'gitBranch'];

/* ── 分析本體 ─────────────────────────────────────────────────────────────── */

/**
 * 建立單一 session 的完整樣貌。
 *
 * 歸因模型 —— 一個 prompt 的成本，就是它所引發的一切：
 *   turn = 一個真實的使用者 prompt + 所有經由 parentUuid 從它衍生下來的 assistant
 *   訊息，直到下一個真實 prompt 為止。在該 turn 內被派生的 agent，其成本會往上捲進它。
 *
 * 連結方式（全部在這份資料上驗證過）：
 *   subagent 檔案  -> 它的 `agentId` 出現在某個主檔案行的 toolUseResult.agentId
 *   workflow agent -> 它的 `runId`（wf_* 目錄名）出現在 toolUseResult.runId
 *   背景任務       -> 它的 id 以 <task-id> 出現在某個 <task-notification> 行裡
 * 這三種情況下，那個主檔案行都位於某個 turn 之內，所以我們從它沿 parentUuid 往上走，
 * 就能找到擁有它的 prompt。
 *
 * 有 57 個 subagent 檔案完全沒有任何 toolUseResult.agentId 指名 —— 桌面版是把它們
 * 排進佇列，從來不會把派生它們的 tool_use 寫進主記錄。<task-id> 這條路救回了其中 11 個。
 * 剩下的 47 個「刻意」維持無法歸因：唯一還能連結它們的方法就是比對時間戳，
 * 而對一個「宣稱每一塊錢都可追溯」的工具來說，用猜的比誠實承認有缺口更糟。
 *
 * 兩條看起來可行但其實「不行」的路（已實測，不要再重推一次）：
 * task-notification 裡的 <tool-use-id>，在 45 個帶有它的未連結 agent 中，能解析到真實
 * tool_use 區塊的有 0 個；agent 檔案第一行的 `sourceToolAssistantUUID`，48 個中也是 0 個。
 * 兩者都是結構性地失敗 —— 如果那個 tool_use 真的有寫進主記錄，它的 tool_result 就會帶著
 * agentId，第一條路早就match到了。
 *
 * 成本之所以維持三層拆分，是因為 `ccusage session` 只算 main+subagent，會靜默地漏掉
 * workflow 這一層 —— 在 ced37f19 上那等於藏了 $25.24（22%）。
 *
 * `seen` 必須跨所有 session 共用（見 analyzeAll 與 claimBillableParts）：
 * 只在單一 session 內去重，會把續接的對話重複計算，讓總額膨脹 14%。
 */
export function analyzeSession(session, seen = new Set()) {
  const mainLines = session.main ? readLines(session.main) : [];

  const byUuid = new Map();
  for (const l of mainLines) if (l.uuid) byUuid.set(l.uuid, l);
  const ownerPromptOf = createOwnerResolver(byUuid);

  const { turns, order } = mintTurns(session, mainLines);
  const { cwd, gitBranch, lastActivity } = scanSessionMeta(mainLines);
  const sessionBucket = newBucket();
  const turnOf = (id) => turns.get(id) ?? turns.get(UNATTRIBUTED);

  // 1) 主記錄的成本 -> 歸屬 turn 的 ownCost
  for (const { line, model, usage } of claimBillableParts(mainLines, seen)) {
    addPart([turnOf(ownerPromptOf(line.uuid) ?? UNATTRIBUTED), sessionBucket], 'ownCost', model, usage);
  }

  // 2) 把每個被派生的 agent 解析到派生它的 turn，或解析到哨兵值。
  //    isTurn() 檢查的是「真的存在的 turn」，因為索引裡刻意會存 null
  //    （見 buildAgentIndexes）。
  const index = buildAgentIndexes(mainLines, ownerPromptOf);
  const isTurn = (id) => id != null && id !== UNATTRIBUTED && turns.has(id);
  const ownerOfAgent = (id, directIndex) => {
    const direct = directIndex.get(id);
    if (isTurn(direct)) return direct;
    const viaTask = index.byTaskId.get(id);
    return isTurn(viaTask) ? viaTask : UNATTRIBUTED;
  };
  const applyAgentFile = (owner, field, file) =>
    mergeBucket([turnOf(owner), sessionBucket], field, bucketOfAgentFile(file, seen));

  // 3) 一般 subagent -> subagentCost（這一層 ccusage「有」算）
  for (const file of session.subagents) {
    applyAgentFile(ownerOfAgent(agentIdOf(file), index.byAgentId), 'subagentCost', file);
  }

  // 4) workflow agent -> workflowCost（這一層正是 ccusage session 漏掉的）
  for (const [runId, files] of session.workflows) {
    const owner = ownerOfAgent(runId, index.byRunId);
    for (const file of files) applyAgentFile(owner, 'workflowCost', file);
  }

  const turnList = [...order, UNATTRIBUTED]
    .map((id) => {
      const t = turns.get(id);
      return finishBucket(t, Object.fromEntries(TURN_FIELDS.map((f) => [f, t[f]])));
    })
    .filter((t) => t.promptId !== UNATTRIBUTED || t.trueCost > 0 || t.totalTokens > 0);

  return finishBucket(sessionBucket, {
    sessionId: session.sessionId,
    // basename(cwd) 才是權威來源；掃描時得到的標籤只是從一個有歧義的目錄編碼
    // 猜出來的（見 projectLabelFromDirName）。
    projectLabel: cwd ? path.basename(cwd) : session.projectLabel,
    projectPath: cwd,
    gitBranch,
    lastActivity,
    promptCount: order.length,
    workflowRunCount: session.workflows.size,
    agentFileCount: session.subagents.length + [...session.workflows.values()].flat().length,
    turns: turnList,
  });
}

/**
 * 用同一個共用的去重集合分析所有 session，從最舊的開始。
 *
 * 順序很重要：當一個 session 被續接時，重播的歷史會同時出現在兩份記錄裡。
 * 依時間順序處理，能讓「原本的」session 保住那筆成本，續接的那個只拿到它真正新增的
 * 訊息 —— 續接一個 session 並不會把同一筆錢再花一次。
 */
export function analyzeAll(sessions) {
  const live = [...sessions.values()].filter(
    (s) => s.main || s.subagents.length || s.workflows.size,
  );

  const startOf = new Map();
  for (const s of live) {
    startOf.set(s, (s.main ? firstTimestamp(s.main) : null) ?? NO_TIMESTAMP_SORT_KEY);
  }
  live.sort((a, z) => String(startOf.get(a)).localeCompare(String(startOf.get(z))));

  const seen = new Set();
  const out = live.map((s) => analyzeSession(s, seen));
  out.sort((a, z) => z.trueCost - a.trueCost);
  return out;
}

export { UNATTRIBUTED, allFilesOf };
