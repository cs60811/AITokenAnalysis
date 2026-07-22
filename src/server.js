import express from 'express';
import path from 'node:path';
import {
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
} from './aggregate.js';
import * as ccusage from './ccusage.js';
import { getAnalysis, invalidate } from './cache.js';
import { initPricing, pricingStatus } from './pricing.js';
import { HOST, PORT, RECONCILE_TOLERANCE_PCT, ROOT } from './config.js';

const app = express();
app.disable('x-powered-by');

const asJson = (handler) => async (req, res) => {
  try {
    res.json(await handler(req));
  } catch (err) {
    const status = err?.kind === 'not_found' ? 503 : 500;
    res.status(status).json({
      error: err?.message ?? String(err),
      kind: err?.kind ?? 'internal',
      detail: err?.detail,
    });
  }
};

const range = (req) => ({
  since: req.query.since || undefined,
  until: req.query.until || undefined,
});

/** Tab 1: every agent, straight from ccusage. */
app.get(
  '/api/overview',
  asJson(async (req) => {
    const [daily, monthly] = await Promise.all([
      ccusage.daily(range(req)),
      ccusage.monthly(range(req)),
    ]);
    return {
      ...ccusage.modelTotalsFromDaily(daily),
      daily: daily.daily ?? [],
      monthly: monthly.monthly ?? [],
    };
  }),
);

/** Tab 2: our per-session analysis, with the ccusage-vs-true split. */
app.get('/api/sessions', asJson((req) => sessionRanking(range(req))));

app.get(
  '/api/sessions/:id',
  asJson((req) => {
    const s = sessionDetail(req.params.id);
    if (!s) throw Object.assign(new Error('session not found'), { kind: 'not_found' });
    return s;
  }),
);

/** Tab 3: prompt ranking. */
app.get(
  '/api/prompts',
  asJson((req) =>
    promptRanking({
      ...range(req),
      limit: Math.min(Number(req.query.limit) || 100, 1000),
      project: req.query.project || undefined,
    }),
  ),
);

/** Full prompt text, fetched only when the user clicks to expand. */
app.get(
  '/api/prompts/:id',
  asJson((req) => {
    const p = promptDetail(req.params.id);
    if (!p) throw Object.assign(new Error('prompt not found'), { kind: 'not_found' });
    return p;
  }),
);

app.get('/api/projects', asJson((req) => ({ projects: projectRanking(range(req)) })));

/**
 * Export: raw `ccusage claude daily --since --until --mode calculate --breakdown --json`
 * as a download named 工號_since_until_使用位置.json.
 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 使用位置 codes: company=公司桌機, nb=自備筆電, home=家中使用. */
const DEVICES = new Set(['company', 'nb', 'home']);
app.get('/api/export', async (req, res) => {
  try {
    const { since, until } = range(req);
    if (!DATE_RE.test(since ?? '') || !DATE_RE.test(until ?? '')) {
      return res.status(400).json({ error: 'since/until 必須是 YYYY-MM-DD', kind: 'bad_request' });
    }
    // Filename-safe: drop control chars, path separators, quotes, and the `_`
    // used as the field separator in the export filename.
    const empId = String(req.query.empId ?? '').replace(/[\x00-\x1f"'\\/:*?<>|_]/g, '').trim();
    const device = String(req.query.device ?? '');
    if (!empId) {
      return res.status(400).json({ error: '工號為必填', kind: 'bad_request' });
    }
    if (!DEVICES.has(device)) {
      return res.status(400).json({ error: '使用位置必須是 company / nb / home', kind: 'bad_request' });
    }

    const body = await ccusage.exportClaudeDaily({ since, until });
    const filename = `${empId}_${since}_${until}_${device}.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    // ASCII fallback + RFC 5987 in case the 工號 contains non-ASCII.
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename.replace(/[^ -~]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    res.send(body);
  } catch (err) {
    const status = err?.kind === 'not_found' ? 503 : 500;
    res.status(status).json({ error: err?.message ?? String(err), kind: err?.kind ?? 'internal', detail: err?.detail });
  }
});

/** Cache-write analysis: the actionable cost signal, split 5m vs 1h. */
app.get(
  '/api/cache-writes',
  asJson((req) =>
    cacheWriteAnalysis({
      ...range(req),
      limit: Math.min(Number(req.query.limit) || 30, 1000),
      project: req.query.project || undefined,
    }),
  ),
);

/** Actionable improvement signals derived from the cache-write analysis. */
app.get('/api/improvements', asJson((req) => improvementSuggestions(range(req))));

/** Behaviour trend: current vs previous window + weekly buckets ("am I improving?"). */
app.get('/api/trend', asJson((req) => behaviorTrend(range(req))));

app.get(
  '/api/health',
  asJson(async () => {
    const analysis = getAnalysis();
    const ours = ourClaudeTotal();
    const un = unattributedTotal();

    let reconcile = null;
    let ccusageErr = null;
    let version = null;
    try {
      version = await ccusage.version();
      const totals = ccusage.modelTotalsFromDaily(await ccusage.daily());
      const delta = ours - totals.claudeCost;
      const pct = totals.claudeCost ? (Math.abs(delta) / totals.claudeCost) * 100 : 0;
      reconcile = {
        ours,
        ccusageClaude: totals.claudeCost,
        ccusageOther: totals.otherCost,
        delta,
        pct,
        ok: pct <= RECONCILE_TOLERANCE_PCT,
        tolerancePct: RECONCILE_TOLERANCE_PCT,
      };
    } catch (err) {
      ccusageErr = { kind: err.kind ?? 'error', message: err.message };
    }

    return {
      pricing: pricingStatus(),
      ccusage: { version, cliPath: ccusage.cliLocation(), error: ccusageErr },
      analysis: {
        sessions: analysis.sessions.length,
        files: analysis.fileCount,
        parseMs: analysis.parseMs,
        generatedAt: analysis.generatedAt,
        cached: analysis.cached,
      },
      unattributed: { cost: un, pct: ours ? (un / ours) * 100 : 0 },
      reconcile,
    };
  }),
);

app.post('/api/refresh', asJson(() => {
  invalidate();
  const a = getAnalysis();
  return { ok: true, parseMs: a.parseMs, generatedAt: a.generatedAt };
}));

app.use(express.static(path.join(ROOT, 'public')));

const status = await initPricing();
if (!status.rates) {
  console.error('WARNING: no pricing data available — costs will show as "—".');
  console.error(`  ${status.error ?? ''}`);
} else {
  const ps = pricingStatus();
  console.log(`pricing: ${ps.source} (${ps.modelCount} models)${ps.stale ? ' [STALE]' : ''}`);
}

// 127.0.0.1 only: this data is local and stays local.
app.listen(PORT, HOST, () => {
  console.log(`AI usage dashboard: http://${HOST}:${PORT}`);
});
