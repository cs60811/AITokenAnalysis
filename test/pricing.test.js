import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'prices.fixture.json');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aita-pricing-'));

// Pricing reads its snapshot/cache paths from config at module load. Point them
// at a fixture with a known rate sheet so the cost assertions are exact numbers
// rather than whatever the shipped prices.json happens to hold today.
vi.mock('../src/config.js', () => ({
  CACHE_DIR: TMP,
  PRICES_CACHE_FILE: path.join(TMP, 'prices-cache.json'),
  PRICES_SNAPSHOT_FILE: FIXTURE,
  LITELLM_PRICES_URL: 'https://litellm.test/prices.json',
  MODELSDEV_PRICES_URL: 'https://models.test/api.json',
  LITELLM_TIMEOUT_MS: 5000,
  PRICES_STALE_DAYS: 30,
}));

const {
  billableParts,
  billingModelOf,
  costOf,
  fastMultiplierFor,
  hasRates,
  initPricing,
  loadSnapshotSync,
  pricingStatus,
  ratesFor,
  resetUnknownFastModels,
  tokensOf,
  unknownFastModels,
  writeSnapshot,
} = await import('../src/pricing.js');

const RATES = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

beforeEach(() => {
  loadSnapshotSync();
  resetUnknownFastModels();
});

afterEach(() => vi.unstubAllGlobals());

describe('billingModelOf', () => {
  it('appends the fast suffix for a speed=fast usage record', () => {
    expect(billingModelOf({ speed: 'fast' }, 'test-opus')).toBe('test-opus-fast');
  });

  it('is idempotent — an already-suffixed model is left alone', () => {
    expect(billingModelOf({ speed: 'fast' }, 'test-opus-fast')).toBe('test-opus-fast');
  });

  it('leaves standard-speed and missing usage untouched', () => {
    expect(billingModelOf({}, 'test-opus')).toBe('test-opus');
    expect(billingModelOf({ speed: 'standard' }, 'test-opus')).toBe('test-opus');
    expect(billingModelOf(undefined, 'test-opus')).toBe('test-opus');
    expect(billingModelOf(null, 'test-opus')).toBe('test-opus');
  });

  it('passes a nullish model straight through', () => {
    expect(billingModelOf({ speed: 'fast' }, null)).toBeNull();
    expect(billingModelOf({ speed: 'fast' }, '')).toBe('');
  });
});

describe('ratesFor', () => {
  it('returns the sheet entry for a known model', () => {
    expect(ratesFor('test-opus')).toEqual(RATES.rates['test-opus']);
  });

  it('returns null for an unknown model and for nullish input', () => {
    expect(ratesFor('nope')).toBeNull();
    expect(ratesFor(undefined)).toBeNull();
    expect(ratesFor(null)).toBeNull();
  });

  it('synthesises a -fast sheet by scaling the base by the published premium', () => {
    const base = RATES.rates['test-opus'];
    const fast = ratesFor('test-opus-fast');
    for (const [k, v] of Object.entries(base)) expect(fast[k]).toBeCloseTo(v * 2, 12);
  });

  it('bills a fast model with no published premium at the BASE rate, not $0', () => {
    // A floor is honest; $0 would be a lie. The model is recorded so verify fails.
    expect(ratesFor('test-no1h-fast')).toEqual(RATES.rates['test-no1h']);
    expect(unknownFastModels()).toContain('test-no1h');
  });

  it('returns null for a -fast variant whose base model is unpriced', () => {
    expect(ratesFor('ghost-fast')).toBeNull();
    expect(unknownFastModels()).not.toContain('ghost');
  });
});

describe('hasRates', () => {
  it('mirrors ratesFor as a boolean', () => {
    expect(hasRates('test-opus')).toBe(true);
    expect(hasRates('test-opus-fast')).toBe(true);
    expect(hasRates('nope')).toBe(false);
    expect(hasRates(undefined)).toBe(false);
  });
});

describe('fastMultiplierFor', () => {
  it('returns the published premium', () => {
    expect(fastMultiplierFor('test-opus')).toBe(2);
  });

  it('returns null when unpublished, and for nullish input', () => {
    expect(fastMultiplierFor('test-no1h')).toBeNull();
    expect(fastMultiplierFor(undefined)).toBeNull();
  });
});

describe('costOf', () => {
  const usage = {
    input_tokens: 1000,
    output_tokens: 500,
    cache_read_input_tokens: 10_000,
    cache_creation: { ephemeral_5m_input_tokens: 2000, ephemeral_1h_input_tokens: 400 },
  };

  it('sums all five token classes at their own rates', () => {
    // 1000*1e-5 + 500*1e-4 + 2000*1.25e-5 + 400*2e-5 + 10000*1e-6
    expect(costOf(usage, 'test-opus')).toBeCloseTo(0.01 + 0.05 + 0.025 + 0.008 + 0.01, 12);
  });

  it('bills a 1h cache write at the 5m rate when the model has no 1h rate', () => {
    // The 1h fallback: 400 * 1.25e-5 instead of 400 * 2e-5.
    expect(costOf(usage, 'test-no1h')).toBeCloseTo(0.01 + 0.05 + 0.025 + 0.005 + 0.01, 12);
  });

  it('treats every missing rate field as zero rather than NaN', () => {
    expect(costOf(usage, 'test-bare')).toBeCloseTo(0.01 + 0.05, 12);
  });

  it('resolves speed=fast to the scaled sheet with no extra multiplier', () => {
    const fast = { ...usage, speed: 'fast' };
    expect(costOf(fast, 'test-opus')).toBeCloseTo(costOf(usage, 'test-opus') * 2, 12);
  });

  it('returns null for an unpriced model so the UI can render a dash, not $0', () => {
    expect(costOf(usage, 'nope')).toBeNull();
  });

  it('returns null for nullish usage', () => {
    expect(costOf(null, 'test-opus')).toBeNull();
    expect(costOf(undefined, 'test-opus')).toBeNull();
  });

  it('costs an empty usage record at exactly zero', () => {
    expect(costOf({}, 'test-opus')).toBe(0);
  });

  it('tolerates a missing cache_creation block', () => {
    expect(costOf({ input_tokens: 1000 }, 'test-opus')).toBeCloseTo(0.01, 12);
  });
});

describe('billableParts', () => {
  it('yields the message itself when there are no iterations', () => {
    const usage = { input_tokens: 1 };
    expect(billableParts(usage, 'test-opus')).toEqual([{ model: 'test-opus', usage }]);
  });

  it('adds an advisor_message iteration as its own billable part', () => {
    const advisor = { type: 'advisor_message', model: 'test-no1h', input_tokens: 9 };
    const usage = { input_tokens: 1, iterations: [advisor] };
    const parts = billableParts(usage, 'test-opus');
    expect(parts).toHaveLength(2);
    expect(parts[1]).toEqual({ model: 'test-no1h', usage: advisor });
  });

  it('ignores non-advisor iterations — their tokens are already in the top level', () => {
    const usage = { input_tokens: 1, iterations: [{ type: 'assistant_message', input_tokens: 1 }] };
    expect(billableParts(usage, 'test-opus')).toHaveLength(1);
  });

  it('falls back to the parent model when the advisor iteration names none', () => {
    const usage = { input_tokens: 1, iterations: [{ type: 'advisor_message' }] };
    expect(billableParts(usage, 'test-opus')[1].model).toBe('test-opus');
  });

  it('does NOT charge the fast premium on an advisor iteration inside a fast message', () => {
    const advisor = { type: 'advisor_message', model: 'test-opus' };
    const usage = { speed: 'fast', iterations: [advisor] };
    const parts = billableParts(usage, 'test-opus');
    expect(parts[0].model).toBe('test-opus-fast');
    expect(parts[1].model).toBe('test-opus');
  });

  it('handles nullish usage without throwing', () => {
    expect(billableParts(undefined, 'test-opus')).toEqual([{ model: 'test-opus', usage: undefined }]);
  });
});

describe('tokensOf', () => {
  it('splits a usage record into the five token classes', () => {
    expect(
      tokensOf({
        input_tokens: 1,
        output_tokens: 2,
        cache_read_input_tokens: 5,
        cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 4 },
      }),
    ).toEqual({ input: 1, output: 2, cacheWrite5m: 3, cacheWrite1h: 4, cacheRead: 5 });
  });

  it('zero-fills every class for nullish or empty usage', () => {
    const zero = { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
    expect(tokensOf(undefined)).toEqual(zero);
    expect(tokensOf({})).toEqual(zero);
  });
});

describe('pricingStatus', () => {
  it('reports the loaded snapshot, its age and its staleness', () => {
    const s = pricingStatus();
    expect(s.source).toBe('snapshot');
    expect(s.modelCount).toBe(Object.keys(RATES.rates).length);
    expect(s.fastModelCount).toBe(1);
    expect(s.stale).toBe(true); // the fixture is dated 2026-01-01
    expect(s.ageDays).toBeGreaterThan(30);
  });

  it('surfaces the models seen billing fast with no published premium', async () => {
    // Via initPricing, not loadSnapshotSync: only the former clears the scaled
    // -fast cache, and a cache hit skips the unknownFast bookkeeping entirely.
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline');
    });
    await initPricing();
    ratesFor('test-no1h-fast');
    expect(pricingStatus().unknownFastModels).toEqual(['test-no1h']);
  });
});

describe('initPricing', () => {
  const stubFetch = (byUrl) =>
    vi.stubGlobal('fetch', async (url) => {
      const hit = byUrl[String(url)];
      if (!hit) throw new Error('unexpected url ' + url);
      if (hit instanceof Error) throw hit;
      return { ok: true, json: async () => hit };
    });

  const LITELLM = 'https://litellm.test/prices.json';
  const MODELSDEV = 'https://models.test/api.json';
  const CACHE = path.join(TMP, 'prices-cache.json');
  const dropCache = () => fs.rmSync(CACHE, { force: true });

  beforeEach(dropCache);

  it('prefers live LiteLLM rates and writes them to the on-disk cache', async () => {
    stubFetch({
      [LITELLM]: { 'live-model': { input_cost_per_token: 0.5, output_cost_per_token: 1 } },
      [MODELSDEV]: { anthropic: { models: { 'live-model': { cost: { input: 2 }, experimental: { modes: { fast: { cost: { input: 6 } } } } } } } },
    });
    const state = await initPricing();
    expect(state.source).toBe('litellm');
    expect(ratesFor('live-model').input_cost_per_token).toBe(0.5);
    expect(fastMultiplierFor('live-model')).toBe(3);
    expect(fs.existsSync(CACHE)).toBe(true);
  });

  it('prefers the on-disk cache over the bundled snapshot when LiteLLM is down', async () => {
    fs.writeFileSync(
      CACHE,
      JSON.stringify({ fetchedAt: '2026-08-01T00:00:00.000Z', rates: { cached: { input_cost_per_token: 7 } } }),
    );
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline');
    });
    const state = await initPricing();
    expect(state.source).toBe('cache');
    expect(ratesFor('cached').input_cost_per_token).toBe(7);
    expect(hasRates('test-opus')).toBe(false);
  });

  it('carries a live models.dev premium over a stale on-disk one', async () => {
    fs.writeFileSync(CACHE, JSON.stringify({ rates: { m: { input_cost_per_token: 1 } }, fastMultipliers: { m: 9 } }));
    stubFetch({
      [LITELLM]: new Error('offline'),
      [MODELSDEV]: { p: { models: { m: { cost: { input: 1 }, experimental: { modes: { fast: { cost: { input: 4 } } } } } } } },
    });
    await initPricing();
    expect(fastMultiplierFor('m')).toBe(4);
  });

  it('reuses the last good on-disk premium when models.dev is unreachable', async () => {
    fs.writeFileSync(CACHE, JSON.stringify({ rates: { m: { input_cost_per_token: 1 } }, fastMultipliers: { m: 9 } }));
    vi.stubGlobal('fetch', async (url) => {
      if (String(url) === MODELSDEV) throw new Error('down');
      return { ok: true, json: async () => ({ m: { input_cost_per_token: 1 } }) };
    });
    await initPricing();
    expect(fastMultiplierFor('m')).toBe(9);
  });

  it('drops sheet entries that carry no numeric input cost', async () => {
    stubFetch({
      [LITELLM]: {
        good: { input_cost_per_token: 1 },
        noInput: { output_cost_per_token: 1 },
        notAnObject: 'nope',
        nullish: null,
      },
      [MODELSDEV]: {},
    });
    await initPricing();
    expect(hasRates('good')).toBe(true);
    expect(hasRates('noInput')).toBe(false);
    expect(hasRates('notAnObject')).toBe(false);
    expect(hasRates('nullish')).toBe(false);
  });

  it('keeps only the rate fields it knows how to bill', async () => {
    stubFetch({
      [LITELLM]: { m: { input_cost_per_token: 1, litellm_provider: 'anthropic', max_tokens: 8192 } },
      [MODELSDEV]: {},
    });
    await initPricing();
    expect(ratesFor('m')).toEqual({ input_cost_per_token: 1 });
  });

  it('falls back to the bundled snapshot when both fetches fail, and reports the error', async () => {
    stubFetch({ [LITELLM]: new Error('offline'), [MODELSDEV]: new Error('offline') });
    const state = await initPricing();
    expect(state.source).toBe('snapshot');
    expect(state.error).toMatch(/LiteLLM fetch failed/);
    expect(ratesFor('test-opus')).toEqual(RATES.rates['test-opus']);
  });

  it('survives a models.dev outage without losing LiteLLM rates', async () => {
    stubFetch({ [LITELLM]: { m: { input_cost_per_token: 1 } }, [MODELSDEV]: new Error('down') });
    const state = await initPricing();
    expect(state.source).toBe('litellm');
    expect(state.error).toMatch(/models\.dev fetch failed/);
    expect(hasRates('m')).toBe(true);
  });

  it('treats a non-OK HTTP response as a failure', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 503, json: async () => ({}) }));
    const state = await initPricing();
    expect(state.source).toBe('snapshot');
    expect(state.error).toMatch(/HTTP 503/);
  });

  it('ignores models.dev entries with no fast mode or no base input cost', async () => {
    stubFetch({
      [LITELLM]: { a: { input_cost_per_token: 1 } },
      [MODELSDEV]: {
        p1: {
          models: {
            noFast: { cost: { input: 1 } },
            noBase: { experimental: { modes: { fast: { cost: { input: 2 } } } } },
          },
        },
        p2: null,
      },
    });
    await initPricing();
    expect(fastMultiplierFor('noFast')).toBeNull();
    expect(fastMultiplierFor('noBase')).toBeNull();
  });
});

describe('writeSnapshot', () => {
  it('stores the base rate plus the premium for a -fast model, not the scaled sheet', async () => {
    const out = path.join(TMP, 'written.json');
    const cfg = await import('../src/config.js');
    const original = cfg.PRICES_SNAPSHOT_FILE;
    // writeSnapshot writes to PRICES_SNAPSHOT_FILE; redirect it for this one test.
    vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (_file, body) => {
      fs.writeFileSync(out, body);
    });
    const n = await writeSnapshot(['test-opus-fast', 'test-bare', 'ghost']);
    vi.restoreAllMocks();
    expect(original).toBe(FIXTURE);

    const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(n).toBe(2);
    expect(doc.rates['test-opus']).toEqual(RATES.rates['test-opus']);
    expect(doc.rates['test-opus-fast']).toBeUndefined();
    expect(doc.fastMultipliers).toEqual({ 'test-opus': 2 });
    expect(doc.rates.ghost).toBeUndefined();
  });
});
