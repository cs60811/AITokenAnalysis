import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'prices.fixture.json');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aita-pricing-'));

// pricing 會在模組載入時從 config 讀取快照／快取的路徑。把它們指向一份費率已知的
// 測試資料，好讓成本斷言是精確數字，而不是隨著今天出貨的 prices.json 內容而變。
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
  cacheWrite1hRateOf,
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
const CACHE = path.join(TMP, 'prices-cache.json');

beforeEach(() => {
  // 放在全域而不是各區塊：initPricing 在抓取成功時會「寫入」這個檔案，
  // 所以某個測試的成功會靜默地變成下一個測試的備援費率表。
  fs.rmSync(CACHE, { force: true });
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
    // 用下限是誠實的；$0 則是謊話。該模型會被記錄下來，好讓 verify 失敗。
    expect(ratesFor('test-no1h-fast')).toEqual(RATES.rates['test-no1h']);
    expect(unknownFastModels()).toContain('test-no1h');
  });

  it('returns null for a -fast variant whose base model is unpriced', () => {
    expect(ratesFor('ghost-fast')).toBeNull();
    expect(unknownFastModels()).not.toContain('ghost');
  });
});

describe('cacheWrite1hRateOf', () => {
  it('prefers the published above-1hr rate', () => {
    expect(cacheWrite1hRateOf(RATES.rates['test-opus'])).toBe(0.00002);
  });

  it('falls back to the 5m rate when there is no 1h rate', () => {
    expect(cacheWrite1hRateOf(RATES.rates['test-no1h'])).toBe(0.0000125);
  });

  it('bottoms out at zero for a sheet with no cache-write rate, and for nullish', () => {
    expect(cacheWrite1hRateOf(RATES.rates['test-bare'])).toBe(0);
    expect(cacheWrite1hRateOf(null)).toBe(0);
    expect(cacheWrite1hRateOf(undefined)).toBe(0);
  });

  it('is the rule costOf actually bills a 1h write at', () => {
    const usage = { cache_creation: { ephemeral_1h_input_tokens: 1000 } };
    for (const model of ['test-opus', 'test-no1h', 'test-bare']) {
      expect(costOf(usage, model)).toBeCloseTo(1000 * cacheWrite1hRateOf(RATES.rates[model]), 12);
    }
  });
});

describe('scaled -fast sheets are invalidated with the rate sheet', () => {
  it('does not serve a -fast sheet scaled from a superseded rate sheet', async () => {
    // 迴歸測試：scaledCache 以前只在 initPricing 的開頭被清除，所以它內部的
    // cache／snapshot fallback —— 以及 loadSnapshotSync —— 會在「已經用舊費率
    // 推導出來的表」底下把費率抽換掉。
    expect(ratesFor('test-opus-fast').input_cost_per_token).toBeCloseTo(0.00002, 12);

    vi.stubGlobal('fetch', async (url) => ({
      ok: true,
      json: async () =>
        String(url) === 'https://models.test/api.json'
          ? { p: { models: { 'test-opus': { cost: { input: 1 }, experimental: { modes: { fast: { cost: { input: 2 } } } } } } } }
          : { 'test-opus': { input_cost_per_token: 0.5 } },
    }));
    await initPricing();
    expect(ratesFor('test-opus-fast').input_cost_per_token).toBeCloseTo(1, 12);

    loadSnapshotSync();
    expect(ratesFor('test-opus-fast').input_cost_per_token).toBeCloseTo(0.00002, 12);
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
    // 1 小時的 fallback：變成 400 * 1.25e-5 而不是 400 * 2e-5。
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
    expect(s.stale).toBe(true); // 這份測試資料的日期是 2026-01-01
    expect(s.ageDays).toBeGreaterThan(30);
  });

  it('surfaces the models seen billing fast with no published premium', async () => {
    // 走 initPricing 而不是 loadSnapshotSync：只有前者會清掉已縮放的 -fast 快取，
    // 而一旦命中快取，就會完全跳過 unknownFast 的記錄動作。
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline');
    });
    await initPricing();
    ratesFor('test-no1h-fast');
    expect(pricingStatus().unknownFastModels).toEqual(['test-no1h']);
  });
});

const stubFetch = (byUrl) =>
  vi.stubGlobal('fetch', async (url) => {
    const hit = byUrl[String(url)];
    if (!hit) throw new Error('unexpected url ' + url);
    if (hit instanceof Error) throw hit;
    return { ok: true, json: async () => hit };
  });

const LITELLM = 'https://litellm.test/prices.json';
const MODELSDEV = 'https://models.test/api.json';

describe('initPricing', () => {
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

describe('models.dev rate fallback', () => {
  // 剛發布的模型會比 LiteLLM 型錄先到。在補上這條 fallback 之前，這種模型會照算
  // token、卻算不出金額，於是它整份支出從總額裡憑空消失 —— 實測 `claude-fable-5-1`
  // 就這樣靜默漏掉 $83.08，只表現成 3.28% 的對帳偏差。
  const anthropicDoc = (models) => ({ anthropic: { models } });

  it('prices a model LiteLLM has not catalogued yet, converting per-million to per-token', async () => {
    stubFetch({
      [LITELLM]: { known: { input_cost_per_token: 1 } },
      [MODELSDEV]: anthropicDoc({
        newcomer: { cost: { input: 10, output: 50, cache_read: 0.25, cache_write: 12.5 } },
      }),
    });
    await initPricing();
    expect(ratesFor('newcomer')).toEqual({
      input_cost_per_token: 0.00001,
      output_cost_per_token: 0.00005,
      cache_creation_input_token_cost: 0.0000125,
      // models.dev 沒有 1 小時欄位；它是由 input 的 2 倍推導出來的。
      cache_creation_input_token_cost_above_1hr: 0.00002,
      cache_read_input_token_cost: 2.5e-7,
    });
    expect(pricingStatus().fallbackModels).toEqual(['newcomer']);
  });

  it('never overrides a rate LiteLLM already publishes', async () => {
    stubFetch({
      [LITELLM]: { m: { input_cost_per_token: 1, output_cost_per_token: 2 } },
      [MODELSDEV]: anthropicDoc({ m: { cost: { input: 999, output: 999 } } }),
    });
    await initPricing();
    expect(ratesFor('m')).toEqual({ input_cost_per_token: 1, output_cost_per_token: 2 });
    expect(pricingStatus().fallbackModels).toEqual([]);
  });

  // 同一個 model id 會出現在幾十家轉售商底下，牌價各不相同（實測 claude-opus-4-8
  // 在 unorouter 是 0.425/2.125）。絕對費率只能取 anthropic 那一份。
  it('takes rates only from the anthropic provider, ignoring resellers', async () => {
    stubFetch({
      [LITELLM]: {},
      [MODELSDEV]: {
        reseller: { models: { cheap: { cost: { input: 1, output: 1 } } } },
        anthropic: { models: { real: { cost: { input: 5, output: 25 } } } },
      },
    });
    await initPricing();
    expect(hasRates('cheap')).toBe(false);
    expect(ratesFor('real').input_cost_per_token).toBe(0.000005);
  });

  it('skips models.dev entries with no published input or output price', async () => {
    stubFetch({
      [LITELLM]: {},
      [MODELSDEV]: anthropicDoc({
        outputOnly: { cost: { output: 5 } },
        inputOnly: { cost: { input: 5 } },
        noCost: {},
      }),
    });
    await initPricing();
    expect(pricingStatus().fallbackModels).toEqual([]);
  });

  it('fills gaps in the bundled snapshot too, so a blocked LiteLLM cannot zero out a new model', async () => {
    stubFetch({
      [LITELLM]: new Error('GitHub blocked'),
      [MODELSDEV]: anthropicDoc({ newcomer: { cost: { input: 10, output: 50 } } }),
    });
    const state = await initPricing();
    expect(state.source).toBe('snapshot');
    // 快照自己的模型全都留著；models.dev 只補它漏掉的那一個。
    expect(ratesFor('test-opus')).toEqual(RATES.rates['test-opus']);
    expect(ratesFor('newcomer').input_cost_per_token).toBe(0.00001);
    expect(pricingStatus().fallbackModels).toEqual(['newcomer']);
  });
});

describe('writeSnapshot', () => {
  it('stores the base rate plus the premium for a -fast model, not the scaled sheet', async () => {
    const out = path.join(TMP, 'written.json');
    const cfg = await import('../src/config.js');
    const original = cfg.PRICES_SNAPSHOT_FILE;
    // writeSnapshot 會寫進 PRICES_SNAPSHOT_FILE；這個測試把它導向別處。
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
