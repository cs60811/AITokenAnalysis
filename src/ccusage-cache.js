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
/**
 * ccusage's version can't change while we're running — ask once per process.
 *
 * Successes are memoized forever; failures are not. One hiccup at startup used to
 * pin the health card to "unavailable" until the app was restarted, because the
 * failure was baked into this promise (and version() hid it inside a string).
 */
export function cachedVersion() {
  versionPromise ??= ccusageVersion().catch((err) => {
    versionPromise = null; // let the next request try again
    return `unavailable (${err?.kind ?? 'error'})`;
  });
  return versionPromise;
}

/** Per-day rows are already aggregates, so a range is just a string-compare filter. */
export function filterDaily(doc, { since, until } = {}) {
  let rows = doc.daily ?? [];
  if (since) rows = rows.filter((r) => String(r.period) >= since);
  if (until) rows = rows.filter((r) => String(r.period) <= until);
  return { ...doc, daily: rows };
}

/**
 * ccusage's OWN breakdown field names, deliberately.
 *
 * These rows stand in for `ccusage monthly`'s, so they must be shaped like
 * ccusage's. modelTotalsFromDaily (ccusage.js) looks like the same aggregation
 * and is not: it converts to our internal cacheWrite/cacheRead names. Two
 * schemas, two audiences — do not merge them.
 */
const BREAKDOWN_FIELDS = ['cost', 'inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens'];

/** `period` is the dashed YYYY-MM-DD form ccusage emits in daily rows. */
const monthKeyOf = (period) => String(period).slice(0, 'YYYY-MM'.length);

/** Synthesize `ccusage monthly` rows from per-day rows (sum by YYYY-MM). */
export function monthlyFromDaily(rows) {
  const byMonth = new Map();
  for (const r of rows) {
    const key = monthKeyOf(r.period);
    let month = byMonth.get(key);
    if (!month) {
      month = { period: key, byModel: new Map() };
      byMonth.set(key, month);
    }
    for (const b of r.modelBreakdowns ?? []) {
      let t = month.byModel.get(b.modelName);
      if (!t) {
        t = { modelName: b.modelName, ...Object.fromEntries(BREAKDOWN_FIELDS.map((f) => [f, 0])) };
        month.byModel.set(b.modelName, t);
      }
      for (const f of BREAKDOWN_FIELDS) t[f] += b[f] ?? 0;
    }
  }
  return [...byMonth.values()]
    .sort((a, z) => a.period.localeCompare(z.period))
    .map((m) => ({ period: m.period, modelBreakdowns: [...m.byModel.values()] }));
}
