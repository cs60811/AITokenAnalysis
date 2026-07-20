import { getAnalysis } from './cache.js';
import { UNATTRIBUTED } from './attribute.js';
import { ratesFor } from './pricing.js';

// Bounds arrive as either YYYY-MM-DD (from <input type="date">) or YYYYMMDD
// (ccusage's native form). Strip separators so the comparison is format-agnostic.
const ymd = (s) => (s ? String(s).replace(/-/g, '') : s);
const withinRange = (ts, since, until) => {
  if (!ts) return !since && !until;
  const d = ymd(ts.slice(0, 10));
  const s = ymd(since);
  const u = ymd(until);
  if (s && d < s) return false;
  if (u && d > u) return false;
  return true;
};

/** Session ranking. Always ordered by cost — never by token count (see below). */
export function sessionRanking({ since, until } = {}) {
  const { sessions, generatedAt, cached, parseMs } = getAnalysis();
  const rows = sessions
    .filter((s) => (!since && !until) || withinRange(s.lastActivity, since, until))
    .map(({ turns, ...rest }) => rest);

  const totals = rows.reduce(
    (a, s) => {
      a.ccusageCost += s.ccusageCost;
      a.trueCost += s.trueCost;
      a.workflowCost += s.workflowCost;
      return a;
    },
    { ccusageCost: 0, trueCost: 0, workflowCost: 0 },
  );

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
      .sort((a, z) => z.trueCost - a.trueCost),
  };
}

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
  for (const s of sessions) {
    if (project && s.projectLabel !== project) continue;
    for (const t of s.turns) {
      if (t.promptId === UNATTRIBUTED) continue;
      if ((since || until) && !withinRange(t.timestamp, since, until)) continue;
      rows.push({
        promptId: t.promptId,
        sessionId: s.sessionId,
        projectLabel: s.projectLabel,
        gitBranch: t.gitBranch ?? s.gitBranch,
        timestamp: t.timestamp,
        snippet: t.snippet,
        ownCost: t.ownCost,
        subagentCost: t.subagentCost,
        workflowCost: t.workflowCost,
        ccusageCost: t.ccusageCost,
        trueCost: t.trueCost,
        tokens: t.tokens,
        totalTokens: t.totalTokens,
        byModel: t.byModel,
      });
    }
  }
  rows.sort((a, z) => z.trueCost - a.trueCost);
  return { prompts: rows.slice(0, limit), totalPrompts: rows.length, generatedAt };
}

export function promptDetail(promptId) {
  const { sessions } = getAnalysis();
  for (const s of sessions) {
    const t = s.turns.find((x) => x.promptId === promptId);
    if (t) {
      return {
        ...t,
        projectLabel: s.projectLabel,
        projectPath: s.projectPath,
        sessionId: s.sessionId,
      };
    }
  }
  return null;
}

/** Projects rolled up, so spend can be traced to a codebase. */
export function projectRanking({ since, until } = {}) {
  const { sessions } = getAnalysis();
  const by = new Map();
  for (const s of sessions) {
    if ((since || until) && !withinRange(s.lastActivity, since, until)) continue;
    const p = by.get(s.projectLabel) ?? {
      project: s.projectLabel,
      projectPath: s.projectPath,
      sessions: 0,
      prompts: 0,
      ccusageCost: 0,
      workflowCost: 0,
      trueCost: 0,
    };
    p.sessions++;
    p.prompts += s.promptCount;
    p.ccusageCost += s.ccusageCost;
    p.workflowCost += s.workflowCost;
    p.trueCost += s.trueCost;
    by.set(s.projectLabel, p);
  }
  return [...by.values()].sort((a, z) => z.trueCost - a.trueCost);
}

/**
 * Dollar cost of cache activity for one `byModel` array, split 5m / 1h.
 *
 * Cache-write cost is never stored separately — it's folded into ownCost/trueCost.
 * We recompute it here from the per-model token counts × per-model rates, using the
 * exact same formula as costOf() (pricing.js): a 1h write bills at the "above 1hr"
 * rate (~2× input), falling back to the 5m rate when a model has no 1h rate.
 * Models with no rates are skipped, exactly as trueCost skips them.
 */
function cacheWriteCostOf(byModel) {
  let cost5m = 0;
  let cost1h = 0;
  let readCost = 0;
  let write5mTok = 0;
  let write1hTok = 0;
  let readTok = 0;
  for (const bm of byModel ?? []) {
    const r = ratesFor(bm.model);
    if (!r) continue;
    const t = bm.tokens;
    const rate1h = r.cache_creation_input_token_cost_above_1hr ?? r.cache_creation_input_token_cost ?? 0;
    cost5m += t.cacheWrite5m * (r.cache_creation_input_token_cost ?? 0);
    cost1h += t.cacheWrite1h * rate1h;
    readCost += t.cacheRead * (r.cache_read_input_token_cost ?? 0);
    write5mTok += t.cacheWrite5m;
    write1hTok += t.cacheWrite1h;
    readTok += t.cacheRead;
  }
  return { cost5m, cost1h, writeCost: cost5m + cost1h, readCost, write5mTok, write1hTok, readTok };
}

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
  const totals = { cost5m: 0, cost1h: 0, writeCost: 0, readCost: 0, trueCost: 0, write5mTok: 0, write1hTok: 0, readTok: 0 };

  for (const s of sessions) {
    if (project && s.projectLabel !== project) continue;
    for (const t of s.turns) {
      if (t.promptId === UNATTRIBUTED) continue;
      if ((since || until) && !withinRange(t.timestamp, since, until)) continue;

      const c = cacheWriteCostOf(t.byModel);
      totals.cost5m += c.cost5m;
      totals.cost1h += c.cost1h;
      totals.writeCost += c.writeCost;
      totals.readCost += c.readCost;
      totals.trueCost += t.trueCost;
      totals.write5mTok += c.write5mTok;
      totals.write1hTok += c.write1hTok;
      totals.readTok += c.readTok;

      if (c.writeCost > 0) {
        prompts.push({
          promptId: t.promptId,
          sessionId: s.sessionId,
          projectLabel: s.projectLabel,
          gitBranch: t.gitBranch ?? s.gitBranch,
          timestamp: t.timestamp,
          snippet: t.snippet,
          cost5m: c.cost5m,
          cost1h: c.cost1h,
          writeCost: c.writeCost,
          trueCost: t.trueCost,
        });

        const p = byProject.get(s.projectLabel) ?? { project: s.projectLabel, cost5m: 0, cost1h: 0, writeCost: 0 };
        p.cost5m += c.cost5m;
        p.cost1h += c.cost1h;
        p.writeCost += c.writeCost;
        byProject.set(s.projectLabel, p);

        const day = t.timestamp ? t.timestamp.slice(0, 10) : null;
        if (day) {
          const d = byDay.get(day) ?? { period: day, cost5m: 0, cost1h: 0 };
          d.cost5m += c.cost5m;
          d.cost1h += c.cost1h;
          byDay.set(day, d);
        }
      }
    }
  }

  prompts.sort((a, z) => z.writeCost - a.writeCost);
  const writeTok = totals.write5mTok + totals.write1hTok;
  totals.reuseRatio = writeTok ? totals.readTok / writeTok : 0;

  return {
    prompts: prompts.slice(0, limit),
    totalPrompts: prompts.length,
    projects: [...byProject.values()].sort((a, z) => z.writeCost - a.writeCost),
    daily: [...byDay.values()].sort((a, z) => a.period.localeCompare(z.period)),
    totals,
    generatedAt,
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
  let totalWrite = 0;
  let total1h = 0;
  let totalCost = 0;
  let totReadTok = 0;
  let totWriteTok = 0;

  for (const s of sessions) {
    if ((since || until) && !withinRange(s.lastActivity, since, until)) continue;
    const c = cacheWriteCostOf(s.byModel);
    if (c.writeCost <= 0 && s.trueCost <= 0) continue;

    totalWrite += c.writeCost;
    total1h += c.cost1h;
    totalCost += s.trueCost;
    totReadTok += c.readTok;
    totWriteTok += c.write5mTok + c.write1hTok;

    for (const bm of s.byModel ?? []) {
      const cc = cacheWriteCostOf([bm]);
      const e = byModelMap.get(bm.model) ?? {
        model: bm.model,
        writeCost: 0,
        cost1h: 0,
        cost5m: 0,
        totalCost: 0,
        rate1h:
          ratesFor(bm.model)?.cache_creation_input_token_cost_above_1hr ??
          ratesFor(bm.model)?.cache_creation_input_token_cost ??
          null,
      };
      e.writeCost += cc.writeCost;
      e.cost1h += cc.cost1h;
      e.cost5m += cc.cost5m;
      e.totalCost += bm.cost;
      byModelMap.set(bm.model, e);
    }

    const writeTok = c.write5mTok + c.write1hTok;
    sess.push({
      sessionId: s.sessionId,
      projectLabel: s.projectLabel,
      writeCost: c.writeCost,
      cost1h: c.cost1h,
      reuse: writeTok ? c.readTok / writeTok : 0,
      promptCount: s.promptCount,
      trueCost: s.trueCost,
    });
  }

  const byModel = [...byModelMap.values()].sort((a, z) => z.writeCost - a.writeCost);
  const byWrite = [...sess].sort((a, z) => z.writeCost - a.writeCost);
  const top5Write = byWrite.slice(0, 5).reduce((n, x) => n + x.writeCost, 0);

  return {
    byModel,
    topSessions: byWrite.slice(0, 5),
    lowReuseSessions: sess
      .filter((x) => x.cost1h > 2 && x.reuse > 0 && x.reuse < 8)
      .sort((a, z) => a.reuse - z.reuse),
    concentration: { top5Share: totalWrite ? top5Write / totalWrite : 0, sessionCount: sess.length },
    totals: {
      writeCost: totalWrite,
      cost1h: total1h,
      totalCost,
      reuseRatio: totWriteTok ? totReadTok / totWriteTok : 0,
    },
    generatedAt,
  };
}

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
