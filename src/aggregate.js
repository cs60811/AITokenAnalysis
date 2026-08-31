import { getAnalysis } from './cache.js';
import { UNATTRIBUTED } from './attribute.js';
import { cacheWrite1hRateOf, ratesFor } from './pricing.js';

/**
 * 改善建議分頁「顯示用」的 1 小時快取寫入費率。
 *
 * 與 pricing 的 cacheWrite1hRateOf 是同一條 fallback 鏈，但最後是落在 null 而不是 0：
 * 這個數字會顯示給使用者看，把未知費率呈現成「0」會被讀成免費。
 * 計費落在 0 是因為寫入終究得有個價格；顯示落在 null 是因為「—」才是誠實的答案。
 */
const displayed1hRateOf = (r) =>
  r?.cache_creation_input_token_cost_above_1hr ?? r?.cache_creation_input_token_cost ?? null;

/** 1 小時寫入的成本要達到這個金額，該 session 才會被標記為「快取重用率偏低」。 */
const LOW_REUSE_MIN_1H_COST = 2;

/**
 * 重用率低於這個值才值得檢視；達到或超過它，代表快取已經回本，這時建議去
 * 「優化」寫入反而是錯的。另外還要 `> 0`：完全沒有讀取的 session，還談不上重用率。
 */
const LOW_REUSE_MAX_RATIO = 8;

/** 集中度數字與排行榜涵蓋幾個 session。 */
const TOP_SESSION_COUNT = 5;

const DAY_MS = 86_400_000;

/** 歸屬到 Opus 的成本是最主要的槓桿，所以趨勢分頁把它單獨追蹤。 */
const OPUS_MODEL_PREFIX = 'claude-opus';

/** ISO 時間戳 -> YYYY-MM-DD；沒有時間戳可分桶時回傳 null。 */
const dayOf = (ts) => (ts ? ts.slice(0, 10) : null);

/**
 * 每一個寫入 token 對應多少讀取 token —— 也就是「快取有沒有回本」。
 * 什麼都沒寫入時回傳 0，而不是 NaN 或 Infinity：這個數字是會顯示在 UI 上的。
 */
const reuseRatio = (readTok, writeTok) => (writeTok ? readTok / writeTok : 0);

/** 計算占比，分母為 0 時退化成 0 而不是 NaN。 */
const shareOf = (part, whole) => (whole ? part / whole : 0);

// 邊界值可能是 YYYY-MM-DD（來自 <input type="date">）或 YYYYMMDD（ccusage 的原生格式）。
// 把分隔符去掉，比較時就不必在意是哪一種格式。
const ymd = (s) => (s ? String(s).replace(/-/g, '') : s);

/**
 * `ts` 是否落在 [since, until] 之內？兩個邊界都是包含的，且任一邊都可以不給，
 * 不給就代表該側無界。
 *
 * 沒有時間戳的資料列，只有在時間窗完全開放時才會被納入 —— 它無法被定位，
 * 所以只要有任何一個邊界就會被排除。因此呼叫端不需要自己再寫一層「有沒有給邊界？」
 * 的判斷：原本有五個地方各寫了一份，而且每一份都是多餘的。
 */
const withinRange = (ts, since, until) => {
  if (!ts) return !since && !until;
  const d = ymd(dayOf(ts));
  const s = ymd(since);
  const u = ymd(until);
  if (s && d < s) return false;
  if (u && d > u) return false;
  return true;
};

/**
 * 語料中所有符合篩選條件、且可歸因的 turn，連同它所屬的 session 一起產出。
 *
 * UNATTRIBUTED 這個桶永遠不算 turn：它代表誠實承認的缺口，把它當成 prompt 拿去排名或
 * 做趨勢，等於是在為一個不存在的 prompt 說謊。原本有三個彙總各自寫了一份同樣的巢狀迴圈，
 * 內含同樣這兩個跳過條件。
 */
function* eachTurn(sessions, { since, until, project } = {}) {
  for (const session of sessions) {
    if (project && session.projectLabel !== project) continue;
    for (const turn of session.turns) {
      if (turn.promptId === UNATTRIBUTED) continue;
      if (!withinRange(turn.timestamp, since, until)) continue;
      yield { session, turn };
    }
  }
}

/** 取值或建立，讓彙總用的累加 map 在呼叫端只佔一行。 */
function upsert(map, key, create) {
  let v = map.get(key);
  if (!v) {
    v = create();
    map.set(key, v);
  }
  return v;
}

/** 依某個數值欄位遞減 —— 本檔案每個排行榜都用這個順序。 */
const byDesc = (field) => (a, z) => z[field] - a[field];

/* ── session ──────────────────────────────────────────────────────────────── */

/**
 * Session 排行。依成本排序，絕不依 token 數 —— 原因見 promptRanking。
 * 順序本身是從分析結果繼承來的（那邊已經排好），篩選時必須保留它。
 */
export function sessionRanking({ since, until } = {}) {
  const { sessions, generatedAt, cached, parseMs } = getAnalysis();
  const rows = sessions
    .filter((s) => withinRange(s.lastActivity, since, until))
    .map(({ turns, ...rest }) => rest);

  const totals = { ccusageCost: 0, trueCost: 0, workflowCost: 0 };
  for (const s of rows) {
    for (const k of Object.keys(totals)) totals[k] += s[k];
  }

  return { sessions: rows, totals, generatedAt, cached, parseMs };
}

export function sessionDetail(sessionId) {
  const { sessions } = getAnalysis();
  const s = sessions.find((x) => x.sessionId === sessionId);
  if (!s) return null;
  return {
    ...s,
    turns: s.turns
      .map(({ text, ...t }) => t) // 依隱私決策，完整原文另外提供
      .sort(byDesc('trueCost')),
  };
}

/* ── prompt ───────────────────────────────────────────────────────────────── */

/**
 * 跨所有 session 的 prompt 排行。
 *
 * 刻意依成本排序。本機 94% 的 token 是快取讀取，而它的單價便宜約 10 倍 ——
 * 若依 totalTokens 排序，浮上來的會是那些便宜、大量讀快取的 turn，真正貴的反而被埋掉，
 * 這樣整個儀表板就失去意義了。
 */
export function promptRanking({ since, until, limit = 100, project } = {}) {
  const { sessions, generatedAt } = getAnalysis();
  const rows = [];
  for (const { session, turn } of eachTurn(sessions, { since, until, project })) {
    rows.push({
      promptId: turn.promptId,
      sessionId: session.sessionId,
      projectLabel: session.projectLabel,
      gitBranch: turn.gitBranch ?? session.gitBranch,
      timestamp: turn.timestamp,
      snippet: turn.snippet,
      ownCost: turn.ownCost,
      subagentCost: turn.subagentCost,
      workflowCost: turn.workflowCost,
      ccusageCost: turn.ccusageCost,
      trueCost: turn.trueCost,
      tokens: turn.tokens,
      totalTokens: turn.totalTokens,
      byModel: turn.byModel,
    });
  }
  rows.sort(byDesc('trueCost'));
  return { prompts: rows.slice(0, limit), totalPrompts: rows.length, generatedAt };
}

export function promptDetail(promptId) {
  const { sessions } = getAnalysis();
  for (const s of sessions) {
    const t = s.turns.find((x) => x.promptId === promptId);
    if (t) {
      return { ...t, projectLabel: s.projectLabel, projectPath: s.projectPath, sessionId: s.sessionId };
    }
  }
  return null;
}

/* ── 專案 ─────────────────────────────────────────────────────────────────── */

/** 依專案彙總，讓支出可以追溯到某個程式庫。 */
export function projectRanking({ since, until } = {}) {
  const { sessions } = getAnalysis();
  const by = new Map();
  for (const s of sessions) {
    if (!withinRange(s.lastActivity, since, until)) continue;
    const p = upsert(by, s.projectLabel, () => ({
      project: s.projectLabel,
      projectPath: s.projectPath,
      sessions: 0,
      prompts: 0,
      ccusageCost: 0,
      workflowCost: 0,
      trueCost: 0,
    }));
    p.sessions++;
    p.prompts += s.promptCount;
    p.ccusageCost += s.ccusageCost;
    p.workflowCost += s.workflowCost;
    p.trueCost += s.trueCost;
  }
  return [...by.values()].sort(byDesc('trueCost'));
}

/* ── 快取寫入成本 ─────────────────────────────────────────────────────────── */

const CACHE_COST_FIELDS = ['cost5m', 'cost1h', 'writeCost', 'readCost', 'write5mTok', 'write1hTok', 'readTok'];

const emptyCacheCost = () => Object.fromEntries(CACHE_COST_FIELDS.map((f) => [f, 0]));

const addCacheCost = (dst, src) => {
  for (const f of CACHE_COST_FIELDS) dst[f] += src[f];
  return dst;
};

/**
 * 單一筆 `byModel` 項目的快取活動金額，拆成 5 分鐘 / 1 小時。
 *
 * 快取寫入成本從來不會被單獨儲存 —— 它已經被併進 ownCost/trueCost 裡。
 * 這裡是用「各模型的 token 數 × 各模型的費率」重新算出來的，規則與 costOf()
 * （pricing.js）完全相同，包含 cacheWrite1hRateOf 在模型沒有 1 小時費率時退回
 * 5 分鐘費率的行為。完全沒有費率的模型不貢獻任何金額，與 trueCost 跳過它的做法一致。
 */
function cacheCostOfModel(bm) {
  const r = ratesFor(bm.model);
  if (!r) return emptyCacheCost();
  const t = bm.tokens;
  const cost5m = t.cacheWrite5m * (r.cache_creation_input_token_cost ?? 0);
  const cost1h = t.cacheWrite1h * cacheWrite1hRateOf(r);
  return {
    cost5m,
    cost1h,
    writeCost: cost5m + cost1h,
    readCost: t.cacheRead * (r.cache_read_input_token_cost ?? 0),
    write5mTok: t.cacheWrite5m,
    write1hTok: t.cacheWrite1h,
    readTok: t.cacheRead,
  };
}

/** 同上，但對整個 `byModel` 陣列加總。 */
function cacheWriteCostOf(byModel) {
  const out = emptyCacheCost();
  for (const bm of byModel ?? []) addCacheCost(out, cacheCostOfModel(bm));
  return out;
}

const writeTokensOf = (c) => c.write5mTok + c.write1hTok;

/**
 * 快取寫入分析 —— 這個工具存在的理由，也是真正可行動的訊號。
 *
 * 快取讀取約占 token 的 94%，但單價只有約 1/10；真正值得追的錢是快取「寫入」，
 * 尤其是 1 小時那一層（約為 input 的 2 倍）。這裡的一切都依寫入成本排序，
 * 拆成 5 分鐘與 1 小時，並提供 prompt 與專案兩種粒度，外加每日趨勢與寫入/讀取重用率。
 */
export function cacheWriteAnalysis({ since, until, limit = 30, project } = {}) {
  const { sessions, generatedAt } = getAnalysis();
  const prompts = [];
  const byProject = new Map();
  const byDay = new Map();
  const totals = { ...emptyCacheCost(), trueCost: 0 };

  for (const { session, turn } of eachTurn(sessions, { since, until, project })) {
    const c = cacheWriteCostOf(turn.byModel);
    addCacheCost(totals, c);
    totals.trueCost += turn.trueCost;

    // 沒有寫入快取的 turn 在這個分頁沒什麼好說的，但它的 trueCost 仍然要算進
    // 上面那個分母裡。
    if (c.writeCost <= 0) continue;

    prompts.push({
      promptId: turn.promptId,
      sessionId: session.sessionId,
      projectLabel: session.projectLabel,
      gitBranch: turn.gitBranch ?? session.gitBranch,
      timestamp: turn.timestamp,
      snippet: turn.snippet,
      cost5m: c.cost5m,
      cost1h: c.cost1h,
      writeCost: c.writeCost,
      trueCost: turn.trueCost,
    });

    const p = upsert(byProject, session.projectLabel, () => ({
      project: session.projectLabel,
      cost5m: 0,
      cost1h: 0,
      writeCost: 0,
    }));
    p.cost5m += c.cost5m;
    p.cost1h += c.cost1h;
    p.writeCost += c.writeCost;

    const day = dayOf(turn.timestamp);
    if (day) {
      const d = upsert(byDay, day, () => ({ period: day, cost5m: 0, cost1h: 0 }));
      d.cost5m += c.cost5m;
      d.cost1h += c.cost1h;
    }
  }

  prompts.sort(byDesc('writeCost'));
  totals.reuseRatio = reuseRatio(totals.readTok, writeTokensOf(totals));

  return {
    prompts: prompts.slice(0, limit),
    totalPrompts: prompts.length,
    projects: [...byProject.values()].sort(byDesc('writeCost')),
    daily: [...byDay.values()].sort((a, z) => a.period.localeCompare(z.period)),
    totals,
    generatedAt,
  };
}

/* ── 改善訊號 ─────────────────────────────────────────────────────────────── */

/**
 * 各模型的彙總列，附上該模型公布的費率，供費率表使用。
 *
 * 刻意只帶改善建議分頁會顯示的那三個快取成本數字，而不是整份快取成本記錄：
 * token 數與讀取成本在這裡只是中間值，把它們掛到這一列上，只會讓 API 回傳的資料
 * 變寬，卻沒有任何使用端需要。
 */
function newModelRow(model) {
  const r = ratesFor(model);
  return {
    model,
    writeCost: 0,
    cost1h: 0,
    cost5m: 0,
    totalCost: 0,
    rate1h: displayed1hRateOf(r),
    rates: {
      input: r?.input_cost_per_token ?? null,
      output: r?.output_cost_per_token ?? null,
      write5m: r?.cache_creation_input_token_cost ?? null,
      write1h: displayed1hRateOf(r),
      read: r?.cache_read_input_token_cost ?? null,
    },
  };
}

/**
 * 改善訊號 —— 把快取寫入的診斷轉成可以行動的建議。
 *
 * 刻意只提供純事實（不做省下多少錢的估算）。前端會把這些組裝成建議卡片。
 * 實務上最主要的槓桿是模型選擇：高階模型的 1 小時寫入費率是便宜模型的好幾倍，
 * 所以只要把一小部分工作往下移一階就能省很多。重用率通常是健康的，所以我們也一併呈現，
 * 免得使用者跑去「優化」那些其實已經回本的寫入。
 */
export function improvementSuggestions({ since, until } = {}) {
  const { sessions, generatedAt } = getAnalysis();
  const byModelMap = new Map();
  const sess = [];
  const totals = { ...emptyCacheCost(), totalCost: 0 };

  for (const s of sessions) {
    if (!withinRange(s.lastActivity, since, until)) continue;

    // 先逐模型定價再加總 —— 只走訪一次而非兩次，而且這樣 session 的數字就會
    // 恰好等於旁邊那些列的總和。
    const perModel = (s.byModel ?? []).map((bm) => ({ bm, cost: cacheCostOfModel(bm) }));
    const c = perModel.reduce((acc, x) => addCacheCost(acc, x.cost), emptyCacheCost());

    // 既沒寫快取、也沒花到錢的 session 沒什麼好說的。
    // 這個跳過必須發生在動到 byModel 表「之前」，否則一個沒有花費的 session
    // 會把一個它根本沒貢獻支出的模型塞進費率表裡。
    if (c.writeCost <= 0 && s.trueCost <= 0) continue;

    for (const { bm, cost } of perModel) {
      const row = upsert(byModelMap, bm.model, () => newModelRow(bm.model));
      row.writeCost += cost.writeCost;
      row.cost1h += cost.cost1h;
      row.cost5m += cost.cost5m;
      row.totalCost += bm.cost;
    }

    addCacheCost(totals, c);
    totals.totalCost += s.trueCost;

    sess.push({
      sessionId: s.sessionId,
      projectLabel: s.projectLabel,
      writeCost: c.writeCost,
      cost1h: c.cost1h,
      reuse: reuseRatio(c.readTok, writeTokensOf(c)),
      promptCount: s.promptCount,
      trueCost: s.trueCost,
    });
  }

  const byWrite = [...sess].sort(byDesc('writeCost'));
  const top = byWrite.slice(0, TOP_SESSION_COUNT);
  const topWriteCost = top.reduce((n, x) => n + x.writeCost, 0);

  return {
    byModel: [...byModelMap.values()].sort(byDesc('writeCost')),
    topSessions: top,
    lowReuseSessions: sess
      .filter((x) => x.cost1h > LOW_REUSE_MIN_1H_COST && x.reuse > 0 && x.reuse < LOW_REUSE_MAX_RATIO)
      .sort((a, z) => a.reuse - z.reuse),
    concentration: { top5Share: shareOf(topWriteCost, totals.writeCost), sessionCount: sess.length },
    totals: {
      writeCost: totals.writeCost,
      cost1h: totals.cost1h,
      totalCost: totals.totalCost,
      reuseRatio: reuseRatio(totals.readTok, writeTokensOf(totals)),
    },
    generatedAt,
  };
}

/* ── 行為趨勢 ─────────────────────────────────────────────────────────────── */

/** 給一個 ISO 日期字串，算出以星期一為基準的週鍵值（YYYY-MM-DD）。 */
function weekKeyOf(ts) {
  const d = new Date(dayOf(ts));
  const dow = (d.getUTCDay() + 6) % 7; // 0 = 星期一
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

const emptyTrendAcc = () => ({
  totalCost: 0,
  opusCost: 0,
  cost1h: 0,
  writeCost: 0,
  readTok: 0,
  writeTok: 0,
  promptCount: 0,
  byModel: new Map(),
});

function addTurnToTrend(acc, turn) {
  const c = cacheWriteCostOf(turn.byModel);
  acc.totalCost += turn.trueCost;
  acc.cost1h += c.cost1h;
  acc.writeCost += c.writeCost;
  acc.readTok += c.readTok;
  acc.writeTok += writeTokensOf(c);
  acc.promptCount += 1;
  for (const bm of turn.byModel ?? []) {
    if (bm.model.startsWith(OPUS_MODEL_PREFIX)) acc.opusCost += bm.cost;
    acc.byModel.set(bm.model, (acc.byModel.get(bm.model) ?? 0) + (bm.cost ?? 0));
  }
}

const finalizeTrend = (acc) => ({
  totalCost: acc.totalCost,
  opusShare: shareOf(acc.opusCost, acc.totalCost),
  oneHrShare: shareOf(acc.cost1h, acc.writeCost),
  reuse: reuseRatio(acc.readTok, acc.writeTok),
  avgCostPerPrompt: shareOf(acc.totalCost, acc.promptCount),
  promptCount: acc.promptCount,
  byModel: [...acc.byModel.entries()].map(([model, cost]) => ({ model, cost })).sort(byDesc('cost')),
});

/**
 * [since, until] 之前、等長的那一段時間窗：[since - 長度, since - 1 天]。
 * 除非「兩個」邊界都有給，否則回傳 null —— 開放式的時間窗沒有長度可以對照。
 */
function previousWindowOf(since, until) {
  if (!since || !until) return null;
  const start = Date.parse(`${since}T00:00:00Z`);
  const end = Date.parse(`${until}T00:00:00Z`);
  const lenDays = Math.round((end - start) / DAY_MS) + 1; // 含頭尾
  return {
    since: new Date(start - lenDays * DAY_MS).toISOString().slice(0, 10),
    until: new Date(start - DAY_MS).toISOString().slice(0, 10),
  };
}

/**
 * 行為趨勢 —— 「我有沒有進步？」的回饋迴圈。
 *
 * 改善建議分頁告訴使用者要改什麼；這裡則顯示改了之後有沒有效。我們會為所選時間窗、
 * 它之前等長的時間窗（用來算差異）、以及該時間窗內的每週分桶（用來看方向）
 * 各算出一組習慣指標。全部都是 turn 層級，並重複使用 cacheWriteCostOf。
 */
export function behaviorTrend({ since, until } = {}) {
  const { sessions, generatedAt } = getAnalysis();
  const prevWindow = previousWindowOf(since, until);
  const hasComparison = prevWindow != null;

  const cur = emptyTrendAcc();
  const prev = emptyTrendAcc();
  const weekMap = new Map();

  // 這裡不用 eachTurn()：這趟走訪需要時間窗「兩側」的 turn，所以無法把範圍判斷
  // 委派出去。
  for (const s of sessions) {
    for (const t of s.turns) {
      if (t.promptId === UNATTRIBUTED || !t.timestamp) continue;
      if (withinRange(t.timestamp, since, until)) {
        addTurnToTrend(cur, t);
        addTurnToTrend(upsert(weekMap, weekKeyOf(t.timestamp), emptyTrendAcc), t);
      } else if (hasComparison && withinRange(t.timestamp, prevWindow.since, prevWindow.until)) {
        addTurnToTrend(prev, t);
      }
    }
  }

  return {
    current: finalizeTrend(cur),
    previous: hasComparison ? finalizeTrend(prev) : null,
    hasComparison,
    window: { since: since ?? null, until: until ?? null },
    previousWindow: prevWindow,
    weekly: [...weekMap.entries()]
      .sort((a, z) => a[0].localeCompare(z[0]))
      .map(([week, acc]) => ({ week, ...finalizeTrend(acc) })),
    generatedAt,
  };
}

/* ── 總計 ─────────────────────────────────────────────────────────────────── */

export function ourClaudeTotal() {
  const { sessions } = getAnalysis();
  return sessions.reduce((n, s) => n + s.trueCost, 0);
}

export function unattributedTotal() {
  const { sessions } = getAnalysis();
  let un = 0;
  for (const s of sessions) {
    const u = s.turns.find((t) => t.promptId === UNATTRIBUTED);
    if (u) un += u.trueCost;
  }
  return un;
}
