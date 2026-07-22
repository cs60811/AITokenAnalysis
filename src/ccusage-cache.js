import { daily as ccusageDaily, version as ccusageVersion } from './ccusage.js';
import { currentFingerprint } from './cache.js';
import { CCUSAGE_SWR_MS } from './config.js';

/**
 * Cache for the full-range `ccusage daily` document.
 *
 * ccusage re-parses every transcript on each run (~4s wall on this corpus) and
 * used to be invoked three times per page load (overview daily + monthly, health
 * daily). We now run it once with NO date range, cache the document, and serve
 * every range request by filtering the per-day rows — identical numbers, at
 * array-filter cost. `monthly` is synthesized from the same rows, which also
 * matches ccusage (it filters days first, then buckets).
 *
 * Invalidation:
 * - fingerprint over the Claude transcripts (the same ~9ms scan cache.js uses):
 *   our own new usage triggers a blocking re-run, so numbers the reconcile gate
 *   compares are never stale relative to our parser's.
 * - ccusage additionally reads other agents' logs the fingerprint can't see, so
 *   a document older than CCUSAGE_SWR_MS is served stale while a background
 *   refresh runs (bounded drift, never a 4s wait).
 */
let memo = null; // { fp, at, doc }
let inflight = null; // dedups concurrent cold starts (overview + health)

function runFull() {
  inflight ??= (async () => {
    const fp = currentFingerprint();
    const doc = await ccusageDaily();
    memo = { fp, at: Date.now(), doc };
    return doc;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

export async function fullDaily({ force = false } = {}) {
  if (force || !memo) return runFull();
  if (memo.fp !== currentFingerprint()) return runFull();
  if (Date.now() - memo.at > CCUSAGE_SWR_MS) runFull().catch(() => {});
  return memo.doc;
}

export function invalidateCcusage() {
  memo = null;
}

let versionPromise = null;
/** ccusage's version can't change while we're running — ask once per process. */
export function cachedVersion() {
  versionPromise ??= ccusageVersion();
  return versionPromise;
}

/** Per-day rows are already aggregates, so a range is just a string-compare filter. */
export function filterDaily(doc, { since, until } = {}) {
  let rows = doc.daily ?? [];
  if (since) rows = rows.filter((r) => String(r.period) >= since);
  if (until) rows = rows.filter((r) => String(r.period) <= until);
  return { ...doc, daily: rows };
}

/** Synthesize `ccusage monthly` rows from per-day rows (sum by YYYY-MM). */
export function monthlyFromDaily(rows) {
  const byMonth = new Map();
  for (const r of rows) {
    const key = String(r.period).slice(0, 7);
    const m = byMonth.get(key) ?? { period: key, byModel: new Map() };
    for (const b of r.modelBreakdowns ?? []) {
      const t = m.byModel.get(b.modelName) ?? {
        modelName: b.modelName,
        cost: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      };
      t.cost += b.cost ?? 0;
      t.inputTokens += b.inputTokens ?? 0;
      t.outputTokens += b.outputTokens ?? 0;
      t.cacheCreationTokens += b.cacheCreationTokens ?? 0;
      t.cacheReadTokens += b.cacheReadTokens ?? 0;
      m.byModel.set(b.modelName, t);
    }
    byMonth.set(key, m);
  }
  return [...byMonth.values()]
    .sort((a, z) => a.period.localeCompare(z.period))
    .map((m) => ({ period: m.period, modelBreakdowns: [...m.byModel.values()] }));
}
