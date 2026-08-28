import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CCUSAGE_SWR_MS = 5 * 60_000;

vi.mock('../src/config.js', () => ({ CCUSAGE_SWR_MS }));

const ccusage = { daily: vi.fn(), version: vi.fn() };
vi.mock('../src/ccusage.js', () => ({
  daily: (...a) => ccusage.daily(...a),
  version: (...a) => ccusage.version(...a),
}));

let fingerprint = 'fp-1';
vi.mock('../src/cache.js', () => ({ currentFingerprint: () => fingerprint }));

const { cachedVersion, filterDaily, fullDaily, invalidateCcusage, monthlyFromDaily } = await import(
  '../src/ccusage-cache.js'
);

const day = (period, breakdowns = []) => ({ period, modelBreakdowns: breakdowns });
const bd = (modelName, over = {}) => ({
  modelName,
  cost: 1,
  inputTokens: 10,
  outputTokens: 20,
  cacheCreationTokens: 30,
  cacheReadTokens: 40,
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
  fingerprint = 'fp-1';
  invalidateCcusage();
  ccusage.daily.mockReset();
  ccusage.version.mockReset();
  ccusage.daily.mockResolvedValue({ daily: [day('2026-05-01')] });
});

afterEach(() => vi.useRealTimers());

describe('fullDaily — caching', () => {
  it('runs ccusage once and serves the cached document after that', async () => {
    await fullDaily();
    await fullDaily();
    await fullDaily();
    expect(ccusage.daily).toHaveBeenCalledTimes(1);
    // Always the full corpus: no date range is ever passed down.
    expect(ccusage.daily).toHaveBeenCalledWith();
  });

  it('dedups concurrent cold starts into one ccusage run', async () => {
    let release;
    ccusage.daily.mockReturnValue(new Promise((r) => { release = r; }));
    const a = fullDaily();
    const b = fullDaily();
    release({ daily: [] });
    await Promise.all([a, b]);
    expect(ccusage.daily).toHaveBeenCalledTimes(1);
  });

  it('re-runs when force is set', async () => {
    await fullDaily();
    await fullDaily({ force: true });
    expect(ccusage.daily).toHaveBeenCalledTimes(2);
  });

  it('re-runs when the transcript fingerprint changes', async () => {
    await fullDaily();
    fingerprint = 'fp-2';
    await fullDaily();
    expect(ccusage.daily).toHaveBeenCalledTimes(2);
  });

  it('re-runs after invalidateCcusage', async () => {
    await fullDaily();
    invalidateCcusage();
    await fullDaily();
    expect(ccusage.daily).toHaveBeenCalledTimes(2);
  });

  it('serves stale and refreshes in the background past the SWR window', async () => {
    const first = { daily: [day('2026-05-01')] };
    const second = { daily: [day('2026-05-02')] };
    ccusage.daily.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    expect(await fullDaily()).toBe(first);
    vi.setSystemTime(Date.now() + CCUSAGE_SWR_MS + 1);

    // The stale document comes back immediately — never a 4s wait.
    expect(await fullDaily()).toBe(first);
    expect(ccusage.daily).toHaveBeenCalledTimes(2);

    await vi.waitFor(async () => expect(await fullDaily()).toBe(second));
  });

  it('does not refresh inside the SWR window', async () => {
    await fullDaily();
    vi.setSystemTime(Date.now() + CCUSAGE_SWR_MS - 1);
    await fullDaily();
    expect(ccusage.daily).toHaveBeenCalledTimes(1);
  });

  it('swallows a failed background refresh and keeps serving the stale document', async () => {
    const first = { daily: [day('2026-05-01')] };
    ccusage.daily.mockResolvedValueOnce(first).mockRejectedValueOnce(new Error('ccusage died'));

    await fullDaily();
    vi.setSystemTime(Date.now() + CCUSAGE_SWR_MS + 1);
    expect(await fullDaily()).toBe(first);
    // A rejected background refresh must not become an unhandled rejection.
    await vi.waitFor(() => expect(ccusage.daily).toHaveBeenCalledTimes(2));
    expect(await fullDaily()).toBe(first);
  });

  it('propagates a cold-start failure to the caller', async () => {
    ccusage.daily.mockRejectedValue(new Error('not found'));
    await expect(fullDaily()).rejects.toThrow('not found');
  });

  it('retries after a cold-start failure rather than caching it', async () => {
    ccusage.daily.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ daily: [] });
    await expect(fullDaily()).rejects.toThrow('boom');
    await expect(fullDaily()).resolves.toEqual({ daily: [] });
  });
});

describe('cachedVersion', () => {
  // A successful lookup is memoized for the life of the module, deliberately —
  // ccusage's version cannot change while we run. So each test needs its own
  // module instance rather than an ordering convention between them.
  let freshCachedVersion;
  beforeEach(async () => {
    vi.resetModules();
    ({ cachedVersion: freshCachedVersion } = await import('../src/ccusage-cache.js'));
  });

  it('asks ccusage once per process', async () => {
    ccusage.version.mockResolvedValue('20.0.17');
    expect(await freshCachedVersion()).toBe('20.0.17');
    expect(await freshCachedVersion()).toBe('20.0.17');
    expect(ccusage.version).toHaveBeenCalledTimes(1);
  });

  it('does NOT memoize a failure — one hiccup used to pin the card until restart', async () => {
    ccusage.version
      .mockRejectedValueOnce(Object.assign(new Error('nope'), { kind: 'not_found' }))
      .mockResolvedValueOnce('20.0.17');

    expect(await freshCachedVersion()).toBe('unavailable (not_found)');
    expect(await freshCachedVersion()).toBe('20.0.17');
    expect(ccusage.version).toHaveBeenCalledTimes(2);
  });

  it('labels a failure with no kind as a generic error', async () => {
    ccusage.version.mockRejectedValueOnce(new Error('plain'));
    expect(await freshCachedVersion()).toBe('unavailable (error)');
  });
});

describe('filterDaily', () => {
  const doc = { daily: [day('2026-05-01'), day('2026-05-10'), day('2026-05-20')], extra: 'kept' };

  it('filters rows inclusively at both ends and preserves the rest of the document', () => {
    const r = filterDaily(doc, { since: '2026-05-10', until: '2026-05-10' });
    expect(r.daily.map((d) => d.period)).toEqual(['2026-05-10']);
    expect(r.extra).toBe('kept');
  });

  it('treats each bound as optional', () => {
    expect(filterDaily(doc, { since: '2026-05-10' }).daily).toHaveLength(2);
    expect(filterDaily(doc, { until: '2026-05-10' }).daily).toHaveLength(2);
    expect(filterDaily(doc, {}).daily).toHaveLength(3);
    expect(filterDaily(doc).daily).toHaveLength(3);
  });

  it('tolerates a document with no daily rows', () => {
    expect(filterDaily({}, { since: '2026-05-01' }).daily).toEqual([]);
  });

  it('does not mutate the document it filters', () => {
    filterDaily(doc, { since: '2026-05-20' });
    expect(doc.daily).toHaveLength(3);
  });
});

describe('monthlyFromDaily', () => {
  it('sums per-day rows into per-month rows, keyed YYYY-MM', () => {
    const rows = [
      day('2026-05-01', [bd('claude-opus-5')]),
      day('2026-05-02', [bd('claude-opus-5')]),
      day('2026-06-01', [bd('claude-opus-5')]),
    ];
    const out = monthlyFromDaily(rows);
    expect(out.map((m) => m.period)).toEqual(['2026-05', '2026-06']);
    expect(out[0].modelBreakdowns[0]).toEqual({
      modelName: 'claude-opus-5',
      cost: 2,
      inputTokens: 20,
      outputTokens: 40,
      cacheCreationTokens: 60,
      cacheReadTokens: 80,
    });
  });

  it('keeps ccusage own wire field names, not our internal token shape', () => {
    const [m] = monthlyFromDaily([day('2026-05-01', [bd('m')])]);
    // Monthly rows are consumed as if they came from `ccusage monthly`, so the
    // field names must match ccusage's, not aggregate.js's cacheWrite/cacheRead.
    expect(Object.keys(m.modelBreakdowns[0]).sort()).toEqual([
      'cacheCreationTokens',
      'cacheReadTokens',
      'cost',
      'inputTokens',
      'modelName',
      'outputTokens',
    ]);
  });

  it('keeps one breakdown row per model within a month', () => {
    const out = monthlyFromDaily([day('2026-05-01', [bd('a'), bd('b')]), day('2026-05-02', [bd('a')])]);
    const byModel = Object.fromEntries(out[0].modelBreakdowns.map((b) => [b.modelName, b.cost]));
    expect(byModel).toEqual({ a: 2, b: 1 });
  });

  it('sorts months chronologically regardless of input order', () => {
    const out = monthlyFromDaily([day('2026-12-01'), day('2026-02-01'), day('2026-07-01')]);
    expect(out.map((m) => m.period)).toEqual(['2026-02', '2026-07', '2026-12']);
  });

  it('treats missing numeric fields as zero rather than NaN', () => {
    const [m] = monthlyFromDaily([day('2026-05-01', [{ modelName: 'sparse' }])]);
    expect(m.modelBreakdowns[0]).toEqual({
      modelName: 'sparse',
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    });
  });

  it('emits a month row even for a day with no breakdowns', () => {
    expect(monthlyFromDaily([day('2026-05-01')])).toEqual([{ period: '2026-05', modelBreakdowns: [] }]);
  });

  it('returns nothing for no rows', () => {
    expect(monthlyFromDaily([])).toEqual([]);
  });

  it('keys off the dashed YYYY-MM-DD period ccusage emits in daily rows', () => {
    // Not the compact YYYYMMDD form: filterDaily string-compares `period`
    // against the YYYY-MM-DD bounds the UI sends, so a compact period would
    // already break range filtering upstream of here.
    expect(monthlyFromDaily([day('2026-05-01'), day('2026-05-31')])).toHaveLength(1);
  });
});
