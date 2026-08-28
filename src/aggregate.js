import { getAnalysis } from './cache.js';
import { UNATTRIBUTED } from './attribute.js';
import { cacheWrite1hRateOf, ratesFor } from './pricing.js';

/**
 * The 1h cache-write rate as the improvement tab DISPLAYS it.
 *
 * Same fallback chain as pricing's cacheWrite1hRateOf, but bottoming out at null
 * rather than 0: this figure is shown to the user, and rendering an unknown rate
 * as "0" reads as free. Billing bottoms out at 0 because a write still has to
 * cost something; display bottoms out at null because "—" is the honest answer.
 */
const displayed1hRateOf = (r) =>
  r?.cache_creation_input_token_cost_above_1hr ?? r?.cache_creation_input_token_cost ?? null;

/** A session is flagged for low cache reuse only once its 1h writes cost this much. */
const LOW_REUSE_MIN_1H_COST = 2;

/**
 * Reuse below this is worth looking at; at or above it the cache is paying for
 * itself and "optimising" the writes would be the wrong advice. `> 0` as well:
 * a session with no reads at all has no reuse to judge yet.
 */
const LOW_REUSE_MAX_RATIO = 8;

/** How many sessions the concentration figure and the top list cover. */
const TOP_SESSION_COUNT = 5;

const DAY_MS = 86_400_000;

/** Cost attributed to Opus is the dominant lever, so the trend tracks it apart. */
const OPUS_MODEL_PREFIX = 'claude-opus';

/** ISO timestamp -> YYYY-MM-DD, or null when there is no timestamp to bucket by. */
const dayOf = (ts) => (ts ? ts.slice(0, 10) : null);

/**
 * Read tokens per write token — "is the cache paying for itself".
 * Zero, not NaN or Infinity, when nothing was written: the UI shows this number.
 */
const reuseRatio = (readTok, writeTok) => (writeTok ? readTok / writeTok : 0);

/** One part of a whole as a share, degrading to 0 rather than NaN. */
const shareOf = (part, whole) => (whole ? part / whole : 0);

// Bounds arrive as either YYYY-MM-DD (from <input type="date">) or YYYYMMDD
// (ccusage's native form). Strip separators so the comparison is format-agnostic.
const ymd = (s) => (s ? String(s).replace(/-/g, '') : s);

/**
 * Is `ts` inside [since, until]? Both bounds are inclusive and either may be
 * absent, in which case that side is unbounded.
 *
 * A row with no timestamp is included only when the window is fully open — it
 * cannot be placed, so any bound at all excludes it. Callers therefore need no
 * "are there bounds?" guard of their own: five of them used to carry one, and
 * every one was redundant.
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
 * Every attributable turn in the corpus that matches the filter, with the
 * session it belongs to.
 *
 * The UNATTRIBUTED bucket is never a turn: it is the honest gap, and ranking or
 * trending it as if it were a prompt would be a lie about a prompt that does not
 * exist. Three rollups walked this same nested loop with this same pair of skip
 * conditions written out inline.
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

/** Fetch-or-create, so a rollup's accumulator map reads as one line at the call site. */
function upsert(map, key, create) {
  let v = map.get(key);
  if (!v) {
    v = create();
    map.set(key, v);
  }
  return v;
}

/** Descending by a numeric field — the order every ranking in this file uses. */
const byDesc = (field) => (a, z) => z[field] - a[field];

/* ── sessions ─────────────────────────────────────────────────────────────── */

/**
 * Session ranking. Ordered by cost, never by token count — see promptRanking for
 * why. The order itself is inherited from the analysis, which already sorted;
 * filtering must preserve it.
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
      .map(({ text, ...t }) => t) // full text served separately, per the privacy decision
      .sort(byDesc('trueCost')),
  };
}

/* ── prompts ──────────────────────────────────────────────────────────────── */

/**
 * Prompt ranking across every session.
 *
 * Ranked by cost, deliberately. 94% of tokens on this machine are cache reads,
 * which are ~10x cheaper per token — ranking by totalTokens would surface cheap
 * cache-heavy turns and bury the genuinely expensive ones, defeating the whole
 * point of the dashboard.
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

/* ── projects ─────────────────────────────────────────────────────────────── */

/** Projects rolled up, so spend can be traced to a codebase. */
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

/* ── cache-write cost ─────────────────────────────────────────────────────── */

const CACHE_COST_FIELDS = ['cost5m', 'cost1h', 'writeCost', 'readCost', 'write5mTok', 'write1hTok', 'readTok'];

const emptyCacheCost = () => Object.fromEntries(CACHE_COST_FIELDS.map((f) => [f, 0]));

const addCacheCost = (dst, src) => {
  for (const f of CACHE_COST_FIELDS) dst[f] += src[f];
  return dst;
};

/**
 * Dollar cost of one `byModel` entry's cache activity, split 5m / 1h.
 *
 * Cache-write cost is never stored separately — it's folded into ownCost/trueCost.
 * We recompute it here from the per-model token counts × per-model rates, using the
 * exact same rule as costOf() (pricing.js), including cacheWrite1hRateOf's fallback
 * to the 5m rate for a model with no 1h rate. A model with no rates at all
 * contributes nothing, exactly as trueCost skips it.
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

/** The same, summed over a whole `byModel` array. */
function cacheWriteCostOf(byModel) {
  const out = emptyCacheCost();
  for (const bm of byModel ?? []) addCacheCost(out, cacheCostOfModel(bm));
  return out;
}

const writeTokensOf = (c) => c.write5mTok + c.write1hTok;

/**
 * Cache-write analysis — the actionable signal this tool exists for.
 *
 * Cache reads are ~94% of tokens but ~1/10 the price; the money worth chasing is
 * cache WRITE, especially the 1h tier (~2× input). Everything here is ranked by
 * write cost, split 5m vs 1h, at prompt and project granularity, plus a daily
 * trend and a write-vs-read reuse ratio.
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

    // A turn that wrote no cache has nothing to say on this tab, but its
    // trueCost still belongs in the denominator above.
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

/* ── improvement signals ──────────────────────────────────────────────────── */

/**
 * Per-model roll-up row, with that model's published rates for the rate table.
 *
 * Deliberately carries only the three cache-cost figures the improvement tab
 * shows, not the whole cache-cost record: the token counts and read cost are
 * working values here, and putting them on the row would widen the API payload
 * for no consumer.
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
 * Improvement signals — turns the cache-write diagnosis into action.
 *
 * Pure facts only (no dollar-savings estimates, by design). The frontend assembles
 * these into recommendation cards. The dominant lever in practice is model choice:
 * a premium model's 1h write rate is several × a cheaper one's, so a small share of
 * work moving down-tier saves a lot. Reuse is usually healthy, so we surface it too
 * to keep the user from "optimising" writes that are already paying off.
 */
export function improvementSuggestions({ since, until } = {}) {
  const { sessions, generatedAt } = getAnalysis();
  const byModelMap = new Map();
  const sess = [];
  const totals = { ...emptyCacheCost(), totalCost: 0 };

  for (const s of sessions) {
    if (!withinRange(s.lastActivity, since, until)) continue;

    // Priced per model, then summed — one traversal instead of two, and the
    // session figure is then exactly the sum of the rows shown beside it.
    const perModel = (s.byModel ?? []).map((bm) => ({ bm, cost: cacheCostOfModel(bm) }));
    const c = perModel.reduce((acc, x) => addCacheCost(acc, x.cost), emptyCacheCost());

    // Nothing to say about a session that neither wrote cache nor cost anything.
    // The skip has to come BEFORE the byModel table is touched, or a costless
    // session puts a model in the rate table it contributed no spend to.
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

/* ── behaviour trend ──────────────────────────────────────────────────────── */

/** Monday-anchored week key (YYYY-MM-DD) for a given ISO date string. */
function weekKeyOf(ts) {
  const d = new Date(dayOf(ts));
  const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
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
 * The equal-length window immediately before [since, until]: [since - len, since - 1day].
 * Null unless BOTH bounds are given — an open-ended window has no length to mirror.
 */
function previousWindowOf(since, until) {
  if (!since || !until) return null;
  const start = Date.parse(`${since}T00:00:00Z`);
  const end = Date.parse(`${until}T00:00:00Z`);
  const lenDays = Math.round((end - start) / DAY_MS) + 1; // inclusive
  return {
    since: new Date(start - lenDays * DAY_MS).toISOString().slice(0, 10),
    until: new Date(start - DAY_MS).toISOString().slice(0, 10),
  };
}

/**
 * Behaviour trend — the "am I improving?" feedback loop.
 *
 * The improvement tab tells the user what to change; this shows whether the change
 * is working. We compute a bundle of habit metrics for the selected window, the
 * equal-length window before it (for a delta), and weekly buckets across the window
 * (for direction). Everything is turn-level and reuses cacheWriteCostOf.
 */
export function behaviorTrend({ since, until } = {}) {
  const { sessions, generatedAt } = getAnalysis();
  const prevWindow = previousWindowOf(since, until);
  const hasComparison = prevWindow != null;

  const cur = emptyTrendAcc();
  const prev = emptyTrendAcc();
  const weekMap = new Map();

  // Not eachTurn(): this walk needs turns on BOTH sides of the window, so it
  // cannot delegate the range test.
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

/* ── totals ───────────────────────────────────────────────────────────────── */

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
