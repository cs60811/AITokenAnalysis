import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'prices.fixture.json');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aita-agg-'));

vi.mock('../src/config.js', () => ({
  CACHE_DIR: TMP,
  PRICES_CACHE_FILE: path.join(TMP, 'prices-cache.json'),
  PRICES_SNAPSHOT_FILE: FIXTURE,
  LITELLM_PRICES_URL: 'https://litellm.test/prices.json',
  MODELSDEV_PRICES_URL: 'https://models.test/api.json',
  LITELLM_TIMEOUT_MS: 5000,
  PRICES_STALE_DAYS: 30,
  SNIPPET_CHARS: 120,
  CLAUDE_PROJECTS_DIR: path.join(TMP, 'projects'),
  CACHE_VERSION: 3,
}));

// aggregate.js reads everything through getAnalysis(). Feeding it synthetic
// sessions is what lets these tests assert exact dollar figures — no transcripts,
// no filesystem, no dependence on this machine's corpus.
const analysis = { sessions: [], generatedAt: 'GEN', cached: true, parseMs: 7, fileCount: 0, readErrors: [] };
vi.mock('../src/cache.js', () => ({
  getAnalysis: () => analysis,
  cacheStats: () => ({ scans: 1, parses: 1, scanMs: 0 }),
  invalidate: () => {},
  currentFingerprint: () => 'fp',
}));

const {
  behaviorTrend,
  cacheWriteAnalysis,
  improvementSuggestions,
  ourClaudeTotal,
  projectRanking,
  promptDetail,
  promptRanking,
  sessionDetail,
  sessionRanking,
  unattributedTotal,
} = await import('../src/aggregate.js');
const { UNATTRIBUTED } = await import('../src/attribute.js');
const { loadSnapshotSync } = await import('../src/pricing.js');

beforeEach(() => {
  loadSnapshotSync();
  analysis.sessions = [];
});

/* ── builders ─────────────────────────────────────────────────────────────── */

const RATE = {
  write5m: 0.0000125,
  write1h: 0.00002,
  read: 0.000001,
};

const tokens = ({ input = 0, output = 0, w5 = 0, w1 = 0, read = 0 } = {}) => ({
  input,
  output,
  cacheWrite5m: w5,
  cacheWrite1h: w1,
  cacheRead: read,
});

const turn = ({ id, ts = '2026-05-10T00:00:00.000Z', cost = 0, model = 'test-opus', tok = {}, branch = null } = {}) => ({
  promptId: id,
  timestamp: ts,
  snippet: `snippet ${id}`,
  text: `text ${id}`,
  gitBranch: branch,
  ownCost: cost,
  subagentCost: 0,
  workflowCost: 0,
  ccusageCost: cost,
  trueCost: cost,
  tokens: tokens(tok),
  totalTokens: Object.values(tokens(tok)).reduce((a, b) => a + b, 0),
  byModel: [{ model, cost, tokens: tokens(tok) }],
});

const sess = ({
  id,
  project = 'proj-a',
  lastActivity = '2026-05-10T00:00:00.000Z',
  turns = [],
  workflowCost = 0,
  model = 'test-opus',
  tok = {},
} = {}) => {
  const trueCost = turns.reduce((n, t) => n + t.trueCost, 0) + workflowCost;
  return {
    sessionId: id,
    projectLabel: project,
    projectPath: `C:/repos/${project}`,
    gitBranch: 'main',
    lastActivity,
    promptCount: turns.filter((t) => t.promptId !== UNATTRIBUTED).length,
    ownCost: trueCost - workflowCost,
    subagentCost: 0,
    workflowCost,
    ccusageCost: trueCost - workflowCost,
    trueCost,
    tokens: tokens(tok),
    totalTokens: Object.values(tokens(tok)).reduce((a, b) => a + b, 0),
    byModel: [{ model, cost: trueCost, tokens: tokens(tok) }],
    unpricedModels: [],
    turns,
  };
};

/* ── range filtering: the rule every endpoint shares ─────────────────────── */

describe('range filtering', () => {
  beforeEach(() => {
    analysis.sessions = [
      sess({ id: 'apr', lastActivity: '2026-04-15T00:00:00.000Z', turns: [turn({ id: 't-apr', ts: '2026-04-15T00:00:00.000Z', cost: 1 })] }),
      sess({ id: 'may', lastActivity: '2026-05-15T00:00:00.000Z', turns: [turn({ id: 't-may', ts: '2026-05-15T00:00:00.000Z', cost: 2 })] }),
      sess({ id: 'jun', lastActivity: '2026-06-15T00:00:00.000Z', turns: [turn({ id: 't-jun', ts: '2026-06-15T00:00:00.000Z', cost: 4 })] }),
    ];
  });

  it('includes everything when no bounds are given', () => {
    expect(sessionRanking().sessions).toHaveLength(3);
  });

  // Row order is inherited from the analysis, which analyzeAll already sorted by
  // cost; the range filter must preserve it rather than re-sorting.
  it('applies an inclusive lower bound', () => {
    expect(sessionRanking({ since: '2026-05-15' }).sessions.map((s) => s.sessionId)).toEqual(['may', 'jun']);
  });

  it('applies an inclusive upper bound', () => {
    expect(sessionRanking({ until: '2026-05-15' }).sessions.map((s) => s.sessionId)).toEqual(['apr', 'may']);
  });

  it('accepts the YYYYMMDD form ccusage uses, as well as YYYY-MM-DD', () => {
    const dashed = sessionRanking({ since: '2026-05-01', until: '2026-05-31' });
    const compact = sessionRanking({ since: '20260501', until: '20260531' });
    expect(compact.sessions.map((s) => s.sessionId)).toEqual(dashed.sessions.map((s) => s.sessionId));
    expect(compact.sessions).toHaveLength(1);
  });

  it('keeps a bound-less row but drops it once any bound is set', () => {
    analysis.sessions = [sess({ id: 'nots', lastActivity: null, turns: [] })];
    expect(sessionRanking().sessions).toHaveLength(1);
    expect(sessionRanking({ since: '2026-01-01' }).sessions).toHaveLength(0);
  });
});

/* ── sessions ─────────────────────────────────────────────────────────────── */

describe('sessionRanking', () => {
  it('strips turns from each row and totals the three cost tiers', () => {
    analysis.sessions = [
      sess({ id: 'a', workflowCost: 3, turns: [turn({ id: 't1', cost: 10 })] }),
      sess({ id: 'b', turns: [turn({ id: 't2', cost: 5 })] }),
    ];
    const r = sessionRanking();
    expect(r.sessions[0].turns).toBeUndefined();
    expect(r.totals).toEqual({ ccusageCost: 15, trueCost: 18, workflowCost: 3 });
    expect(r).toMatchObject({ generatedAt: 'GEN', cached: true, parseMs: 7 });
  });

  it('totals to zero over an empty corpus', () => {
    expect(sessionRanking().totals).toEqual({ ccusageCost: 0, trueCost: 0, workflowCost: 0 });
  });
});

describe('sessionDetail', () => {
  it('returns turns sorted by cost and with the full text withheld', () => {
    analysis.sessions = [sess({ id: 'a', turns: [turn({ id: 'cheap', cost: 1 }), turn({ id: 'dear', cost: 9 })] })];
    const d = sessionDetail('a');
    expect(d.turns.map((t) => t.promptId)).toEqual(['dear', 'cheap']);
    expect(d.turns[0].text).toBeUndefined();
    expect(d.turns[0].snippet).toBe('snippet dear');
  });

  it('returns null for an unknown session', () => {
    expect(sessionDetail('nope')).toBeNull();
  });
});

/* ── prompts ──────────────────────────────────────────────────────────────── */

describe('promptRanking', () => {
  beforeEach(() => {
    analysis.sessions = [
      sess({ id: 'a', project: 'proj-a', turns: [turn({ id: 'p1', cost: 3 }), turn({ id: 'p2', cost: 9 })] }),
      sess({ id: 'b', project: 'proj-b', turns: [turn({ id: 'p3', cost: 6 }), turn({ id: UNATTRIBUTED, cost: 99 })] }),
    ];
  });

  it('ranks prompts across every session by cost, descending', () => {
    expect(promptRanking().prompts.map((p) => p.promptId)).toEqual(['p2', 'p3', 'p1']);
  });

  it('never ranks the UNATTRIBUTED bucket as a prompt', () => {
    const r = promptRanking();
    expect(r.prompts.map((p) => p.promptId)).not.toContain(UNATTRIBUTED);
    expect(r.totalPrompts).toBe(3);
  });

  it('filters by project', () => {
    expect(promptRanking({ project: 'proj-b' }).prompts.map((p) => p.promptId)).toEqual(['p3']);
  });

  it('caps the returned rows at limit but still reports the true total', () => {
    const r = promptRanking({ limit: 2 });
    expect(r.prompts).toHaveLength(2);
    expect(r.totalPrompts).toBe(3);
  });

  it('carries the session gitBranch when the turn has none of its own', () => {
    expect(promptRanking().prompts[0].gitBranch).toBe('main');
  });

  it('prefers the turn gitBranch when it has one', () => {
    analysis.sessions = [sess({ id: 'a', turns: [turn({ id: 'p1', cost: 1, branch: 'feature/x' })] })];
    expect(promptRanking().prompts[0].gitBranch).toBe('feature/x');
  });
});

describe('promptDetail', () => {
  it('finds a turn in any session and tags it with that session', () => {
    analysis.sessions = [sess({ id: 'a', project: 'proj-z', turns: [turn({ id: 'p1', cost: 1 })] })];
    expect(promptDetail('p1')).toMatchObject({ promptId: 'p1', sessionId: 'a', projectLabel: 'proj-z' });
  });

  it('returns null when no session holds that prompt', () => {
    expect(promptDetail('ghost')).toBeNull();
  });
});

/* ── projects ─────────────────────────────────────────────────────────────── */

describe('projectRanking', () => {
  it('rolls sessions up per project and sorts by cost', () => {
    analysis.sessions = [
      sess({ id: 'a', project: 'small', turns: [turn({ id: 'p1', cost: 1 })] }),
      sess({ id: 'b', project: 'big', workflowCost: 2, turns: [turn({ id: 'p2', cost: 5 })] }),
      sess({ id: 'c', project: 'big', turns: [turn({ id: 'p3', cost: 4 })] }),
    ];
    const r = projectRanking();
    expect(r.map((p) => p.project)).toEqual(['big', 'small']);
    expect(r[0]).toMatchObject({ sessions: 2, prompts: 2, trueCost: 11, workflowCost: 2, ccusageCost: 9 });
  });

  it('returns an empty list for an empty corpus', () => {
    expect(projectRanking()).toEqual([]);
  });
});

/* ── cache-write analysis ─────────────────────────────────────────────────── */

describe('cacheWriteAnalysis', () => {
  const writeTurn = (id, w5, w1, read = 0, ts = '2026-05-10T00:00:00.000Z') =>
    turn({ id, ts, cost: 1, tok: { w5, w1, read } });

  it('splits write cost 5m vs 1h at the per-model rates', () => {
    analysis.sessions = [sess({ id: 'a', turns: [writeTurn('p1', 1000, 500, 20_000)] })];
    const r = cacheWriteAnalysis();
    expect(r.totals.cost5m).toBeCloseTo(1000 * RATE.write5m, 12);
    expect(r.totals.cost1h).toBeCloseTo(500 * RATE.write1h, 12);
    expect(r.totals.writeCost).toBeCloseTo(1000 * RATE.write5m + 500 * RATE.write1h, 12);
    expect(r.totals.readCost).toBeCloseTo(20_000 * RATE.read, 12);
  });

  it('bills a 1h write at the 5m rate for a model with no 1h rate', () => {
    analysis.sessions = [
      sess({ id: 'a', turns: [{ ...writeTurn('p1', 0, 1000), byModel: [{ model: 'test-no1h', cost: 1, tokens: tokens({ w1: 1000 }) }] }] }),
    ];
    expect(cacheWriteAnalysis().totals.cost1h).toBeCloseTo(1000 * RATE.write5m, 12);
  });

  it('skips a model with no rates at all, exactly as trueCost does', () => {
    analysis.sessions = [
      sess({ id: 'a', turns: [{ ...writeTurn('p1', 1000, 0), byModel: [{ model: 'ghost', cost: 0, tokens: tokens({ w5: 1000 }) }] }] }),
    ];
    expect(cacheWriteAnalysis().totals.writeCost).toBe(0);
  });

  it('lists only prompts that actually wrote cache, ranked by write cost', () => {
    analysis.sessions = [
      sess({ id: 'a', turns: [writeTurn('small', 100, 0), writeTurn('none', 0, 0), writeTurn('big', 0, 5000)] }),
    ];
    const r = cacheWriteAnalysis();
    expect(r.prompts.map((p) => p.promptId)).toEqual(['big', 'small']);
    expect(r.totalPrompts).toBe(2);
  });

  it('rolls write cost up by project and by day', () => {
    analysis.sessions = [
      sess({ id: 'a', project: 'p1', turns: [writeTurn('t1', 1000, 0, 0, '2026-05-01T09:00:00.000Z')] }),
      sess({ id: 'b', project: 'p2', turns: [writeTurn('t2', 0, 1000, 0, '2026-05-02T09:00:00.000Z')] }),
      sess({ id: 'c', project: 'p2', turns: [writeTurn('t3', 0, 1000, 0, '2026-05-02T23:00:00.000Z')] }),
    ];
    const r = cacheWriteAnalysis();
    expect(r.projects.map((p) => p.project)).toEqual(['p2', 'p1']);
    expect(r.daily.map((d) => d.period)).toEqual(['2026-05-01', '2026-05-02']);
    expect(r.daily[1].cost1h).toBeCloseTo(2000 * RATE.write1h, 12);
  });

  it('reports reuse as read tokens per write token', () => {
    analysis.sessions = [sess({ id: 'a', turns: [writeTurn('p1', 100, 100, 2000)] })];
    expect(cacheWriteAnalysis().totals.reuseRatio).toBeCloseTo(10, 12);
  });

  it('reports reuse as zero rather than dividing by zero', () => {
    analysis.sessions = [sess({ id: 'a', turns: [writeTurn('p1', 0, 0, 5000)] })];
    expect(cacheWriteAnalysis().totals.reuseRatio).toBe(0);
  });

  it('excludes UNATTRIBUTED and honours limit and project', () => {
    analysis.sessions = [
      sess({ id: 'a', project: 'keep', turns: [writeTurn('p1', 900, 0), writeTurn('p2', 800, 0), { ...writeTurn(UNATTRIBUTED, 5000, 0), promptId: UNATTRIBUTED }] }),
      sess({ id: 'b', project: 'drop', turns: [writeTurn('p3', 700, 0)] }),
    ];
    const r = cacheWriteAnalysis({ project: 'keep', limit: 1 });
    expect(r.prompts.map((p) => p.promptId)).toEqual(['p1']);
    expect(r.totalPrompts).toBe(2);
  });

  it('omits a turn with no timestamp from the daily buckets but not from totals', () => {
    analysis.sessions = [sess({ id: 'a', turns: [{ ...writeTurn('p1', 1000, 0), timestamp: null }] })];
    const r = cacheWriteAnalysis();
    expect(r.daily).toEqual([]);
    expect(r.totals.writeCost).toBeGreaterThan(0);
  });
});

/* ── improvement signals ──────────────────────────────────────────────────── */

describe('improvementSuggestions', () => {
  const s = (id, { cost, w5 = 0, w1 = 0, read = 0, model = 'test-opus', prompts = 1, project = 'p' } = {}) => ({
    ...sess({ id, project, model, tok: { w5, w1, read } }),
    promptCount: prompts,
    trueCost: cost,
    byModel: [{ model, cost, tokens: tokens({ w5, w1, read }) }],
  });

  it('rolls write cost up per model with that model published rates attached', () => {
    analysis.sessions = [s('a', { cost: 10, w5: 1000, w1: 2000 })];
    const r = improvementSuggestions();
    expect(r.byModel).toHaveLength(1);
    expect(r.byModel[0]).toMatchObject({ model: 'test-opus', totalCost: 10, rate1h: RATE.write1h });
    expect(r.byModel[0].rates).toEqual({
      input: 0.00001,
      output: 0.0001,
      write5m: RATE.write5m,
      write1h: RATE.write1h,
      read: RATE.read,
    });
    expect(r.byModel[0].writeCost).toBeCloseTo(1000 * RATE.write5m + 2000 * RATE.write1h, 12);
  });

  it('reports a null rate for an unpriced model rather than a misleading zero', () => {
    analysis.sessions = [s('a', { cost: 1, w1: 100, model: 'ghost' })];
    const [m] = improvementSuggestions().byModel;
    expect(m.rate1h).toBeNull();
    expect(m.rates).toEqual({ input: null, output: null, write5m: null, write1h: null, read: null });
  });

  it('reports the 5m rate as the 1h rate for a model that publishes no 1h rate', () => {
    analysis.sessions = [s('a', { cost: 1, w1: 100, model: 'test-no1h' })];
    expect(improvementSuggestions().byModel[0].rate1h).toBe(RATE.write5m);
  });

  it('sorts models and top sessions by write cost, and caps top sessions at five', () => {
    analysis.sessions = Array.from({ length: 7 }, (_, i) => s(`s${i}`, { cost: 1, w1: (i + 1) * 100 }));
    const r = improvementSuggestions();
    expect(r.topSessions).toHaveLength(5);
    expect(r.topSessions.map((x) => x.sessionId)).toEqual(['s6', 's5', 's4', 's3', 's2']);
    expect(r.concentration.sessionCount).toBe(7);
  });

  it('measures concentration as the top five share of all write cost', () => {
    analysis.sessions = [s('big', { cost: 1, w1: 1000 }), s('small', { cost: 1, w1: 1000 })];
    expect(improvementSuggestions().concentration.top5Share).toBe(1);
  });

  it('flags a low-reuse session only above the 1h cost floor and below the reuse ceiling', () => {
    // cost1h must exceed $2 and reuse must sit in (0, 8).
    const dear = 200_000; // 200000 * 2e-5 = $4.00 of 1h write
    analysis.sessions = [
      s('flagged', { cost: 9, w1: dear, read: dear * 4 }),
      s('reuse-too-high', { cost: 9, w1: dear, read: dear * 20 }),
      s('too-cheap', { cost: 9, w1: 1000, read: 4000 }),
      s('no-reuse-at-all', { cost: 9, w1: dear, read: 0 }),
    ];
    expect(improvementSuggestions().lowReuseSessions.map((x) => x.sessionId)).toEqual(['flagged']);
  });

  it('sorts flagged sessions worst-reuse-first', () => {
    const dear = 200_000;
    analysis.sessions = [
      s('better', { cost: 9, w1: dear, read: dear * 6 }),
      s('worse', { cost: 9, w1: dear, read: dear * 2 }),
    ];
    expect(improvementSuggestions().lowReuseSessions.map((x) => x.sessionId)).toEqual(['worse', 'better']);
  });

  it('skips a session with no write cost and no true cost', () => {
    analysis.sessions = [s('a', { cost: 0 }), s('b', { cost: 5 })];
    expect(improvementSuggestions().concentration.sessionCount).toBe(1);
  });

  it('keeps a skipped session out of the per-model rate table entirely', () => {
    // Distinct models, so the skipped session cannot hide behind a row another
    // session would have created anyway.
    analysis.sessions = [s('costless', { cost: 0, model: 'test-no1h' }), s('real', { cost: 5, model: 'test-opus' })];
    expect(improvementSuggestions().byModel.map((m) => m.model)).toEqual(['test-opus']);
  });

  it('reports zeroed totals over an empty corpus without dividing by zero', () => {
    expect(improvementSuggestions().totals).toEqual({ writeCost: 0, cost1h: 0, totalCost: 0, reuseRatio: 0 });
    expect(improvementSuggestions().concentration).toEqual({ top5Share: 0, sessionCount: 0 });
  });
});

/* ── behaviour trend ──────────────────────────────────────────────────────── */

describe('behaviorTrend', () => {
  const t = (id, ts, { cost = 1, w1 = 0, read = 0, model = 'test-opus' } = {}) => ({
    ...turn({ id, ts, cost, model, tok: { w1, read } }),
    byModel: [{ model, cost, tokens: tokens({ w1, read }) }],
  });

  it('buckets turns into Monday-anchored weeks, ordered', () => {
    // 2026-05-06 is a Wednesday; 2026-05-11 a Monday.
    analysis.sessions = [
      sess({ id: 'a', turns: [t('p1', '2026-05-06T00:00:00.000Z'), t('p2', '2026-05-11T00:00:00.000Z'), t('p3', '2026-05-15T00:00:00.000Z')] }),
    ];
    const r = behaviorTrend();
    expect(r.weekly.map((w) => w.week)).toEqual(['2026-05-04', '2026-05-11']);
    expect(r.weekly[1].promptCount).toBe(2);
  });

  it('compares against the equal-length window immediately before', () => {
    analysis.sessions = [
      sess({ id: 'a', turns: [t('cur', '2026-05-10T00:00:00.000Z', { cost: 10 }), t('prev', '2026-05-05T00:00:00.000Z', { cost: 4 })] }),
    ];
    const r = behaviorTrend({ since: '2026-05-08', until: '2026-05-14' });
    expect(r.hasComparison).toBe(true);
    expect(r.previousWindow).toEqual({ since: '2026-05-01', until: '2026-05-07' });
    expect(r.current.totalCost).toBe(10);
    expect(r.previous.totalCost).toBe(4);
  });

  it('offers no comparison when the window is open-ended', () => {
    analysis.sessions = [sess({ id: 'a', turns: [t('p1', '2026-05-10T00:00:00.000Z')] })];
    for (const w of [{}, { since: '2026-05-01' }, { until: '2026-05-31' }]) {
      const r = behaviorTrend(w);
      expect(r.hasComparison).toBe(false);
      expect(r.previous).toBeNull();
      expect(r.previousWindow).toBeNull();
    }
  });

  it('computes opus share from the model name prefix', () => {
    analysis.sessions = [
      sess({
        id: 'a',
        turns: [t('p1', '2026-05-10T00:00:00.000Z', { cost: 3, model: 'claude-opus-9' }), t('p2', '2026-05-10T00:00:00.000Z', { cost: 1 })],
      }),
    ];
    expect(behaviorTrend().current.opusShare).toBeCloseTo(0.75, 12);
  });

  it('derives the habit ratios and the per-prompt average', () => {
    analysis.sessions = [sess({ id: 'a', turns: [t('p1', '2026-05-10T00:00:00.000Z', { cost: 8, w1: 1000, read: 4000 })] })];
    const c = behaviorTrend().current;
    expect(c.oneHrShare).toBe(1); // all write cost is 1h here
    expect(c.reuse).toBeCloseTo(4, 12);
    expect(c.avgCostPerPrompt).toBe(8);
    expect(c.byModel).toEqual([{ model: 'test-opus', cost: 8 }]);
  });

  it('reports every ratio as zero over an empty window instead of NaN', () => {
    const c = behaviorTrend().current;
    expect(c).toMatchObject({ totalCost: 0, opusShare: 0, oneHrShare: 0, reuse: 0, avgCostPerPrompt: 0, promptCount: 0 });
    expect(c.byModel).toEqual([]);
  });

  it('ignores UNATTRIBUTED turns and turns with no timestamp', () => {
    analysis.sessions = [
      sess({
        id: 'a',
        turns: [
          { ...t('p1', '2026-05-10T00:00:00.000Z', { cost: 5 }) },
          { ...t(UNATTRIBUTED, '2026-05-10T00:00:00.000Z', { cost: 99 }), promptId: UNATTRIBUTED },
          { ...t('p3', '2026-05-10T00:00:00.000Z', { cost: 99 }), timestamp: null },
        ],
      }),
    ];
    expect(behaviorTrend().current.totalCost).toBe(5);
    expect(behaviorTrend().current.promptCount).toBe(1);
  });

  it('echoes the requested window back', () => {
    expect(behaviorTrend({ since: '2026-05-01', until: '2026-05-31' }).window).toEqual({
      since: '2026-05-01',
      until: '2026-05-31',
    });
    expect(behaviorTrend().window).toEqual({ since: null, until: null });
  });
});

/* ── totals ───────────────────────────────────────────────────────────────── */

describe('ourClaudeTotal and unattributedTotal', () => {
  it('sums trueCost across every session', () => {
    analysis.sessions = [sess({ id: 'a', turns: [turn({ id: 'p1', cost: 2 })] }), sess({ id: 'b', turns: [turn({ id: 'p2', cost: 3 })] })];
    expect(ourClaudeTotal()).toBe(5);
  });

  it('sums only the UNATTRIBUTED bucket of each session', () => {
    analysis.sessions = [
      sess({ id: 'a', turns: [turn({ id: 'p1', cost: 2 }), { ...turn({ id: UNATTRIBUTED, cost: 1 }), promptId: UNATTRIBUTED }] }),
      sess({ id: 'b', turns: [turn({ id: 'p2', cost: 3 })] }),
    ];
    expect(unattributedTotal()).toBe(1);
  });

  it('returns zero over an empty corpus', () => {
    expect(ourClaudeTotal()).toBe(0);
    expect(unattributedTotal()).toBe(0);
  });
});
