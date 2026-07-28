import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  CACHE_DIR,
  LITELLM_PRICES_URL,
  LITELLM_TIMEOUT_MS,
  PRICES_CACHE_FILE,
  PRICES_SNAPSHOT_FILE,
  PRICES_STALE_DAYS,
} from './config.js';

/** Rate fields we require to price a model. */
const RATE_FIELDS = [
  'input_cost_per_token',
  'output_cost_per_token',
  'cache_creation_input_token_cost',
  'cache_creation_input_token_cost_above_1hr',
  'cache_read_input_token_cost',
];

let state = {
  rates: null,
  /** 'litellm' | 'cache' | 'snapshot' */
  source: null,
  fetchedAt: null,
  error: null,
};

function pickRates(raw) {
  const out = {};
  for (const [model, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.input_cost_per_token !== 'number') continue;
    const rec = {};
    for (const f of RATE_FIELDS) {
      if (typeof entry[f] === 'number') rec[f] = entry[f];
    }
    out[model] = rec;
  }
  return out;
}

async function fetchLiteLLM() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LITELLM_TIMEOUT_MS);
  try {
    const res = await fetch(LITELLM_PRICES_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return pickRates(await res.json());
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}

/**
 * Resolve pricing once at startup: LiteLLM -> on-disk cache -> bundled snapshot.
 * Never throws; on total failure `state.rates` stays null and costOf() returns null,
 * which the UI renders as "—" rather than a misleading $0.
 */
export async function initPricing() {
  try {
    const rates = await fetchLiteLLM();
    state = { rates, source: 'litellm', fetchedAt: new Date().toISOString(), error: null };
    await fsp.mkdir(CACHE_DIR, { recursive: true });
    await fsp.writeFile(
      PRICES_CACHE_FILE,
      JSON.stringify({ fetchedAt: state.fetchedAt, rates }, null, 2),
    );
    return state;
  } catch (err) {
    state.error = `LiteLLM fetch failed: ${err.message}`;
  }

  for (const [file, source] of [
    [PRICES_CACHE_FILE, 'cache'],
    [PRICES_SNAPSHOT_FILE, 'snapshot'],
  ]) {
    try {
      const doc = await readJson(file);
      state = {
        rates: doc.rates ?? doc,
        source,
        fetchedAt: doc.fetchedAt ?? null,
        error: state.error,
      };
      return state;
    } catch {
      // try the next fallback
    }
  }
  return state;
}

export function pricingStatus() {
  const ageDays =
    state.fetchedAt != null
      ? (Date.now() - Date.parse(state.fetchedAt)) / 86_400_000
      : null;
  return {
    source: state.source,
    fetchedAt: state.fetchedAt,
    ageDays: ageDays == null ? null : Number(ageDays.toFixed(1)),
    stale: ageDays != null && ageDays > PRICES_STALE_DAYS,
    modelCount: state.rates ? Object.keys(state.rates).length : 0,
    error: state.error,
  };
}

export function ratesFor(model) {
  return state.rates?.[model] ?? null;
}

export function hasRates(model) {
  return ratesFor(model) != null;
}

/**
 * Cost of one assistant message.
 *
 * This formula was verified against ccusage to 8 decimal places on session
 * ced37f19 (opus 85.52876450, sonnet 1.36267350). The 5m/1h cache-creation
 * split matters: a 1h write costs ~2x input, a 5m write ~1.25x.
 *
 * Returns null for an unpriced model so callers can render "—" instead of $0.
 */
export function costOf(usage, model) {
  const p = ratesFor(model);
  if (!p || !usage) return null;
  const cc = usage.cache_creation ?? {};
  const write5m = cc.ephemeral_5m_input_tokens ?? 0;
  const write1h = cc.ephemeral_1h_input_tokens ?? 0;
  const rate1h =
    p.cache_creation_input_token_cost_above_1hr ?? p.cache_creation_input_token_cost ?? 0;

  return (
    (usage.input_tokens ?? 0) * (p.input_cost_per_token ?? 0) +
    (usage.output_tokens ?? 0) * (p.output_cost_per_token ?? 0) +
    write5m * (p.cache_creation_input_token_cost ?? 0) +
    write1h * rate1h +
    (usage.cache_read_input_tokens ?? 0) * (p.cache_read_input_token_cost ?? 0)
  );
}

/**
 * The (model, usage) pairs one transcript entry bills for — usually just itself.
 *
 * A high-effort turn consults an advisor model and records that request as an
 * extra `usage.iterations[]` entry of type `advisor_message`, carrying its own
 * `model`. Those tokens are NOT in the top-level usage: verified on all 15,030
 * iteration-carrying entries here, the top level equals the sum of the
 * non-advisor iterations exactly. ccusage bills the advisor; missing it
 * under-reported our total by 1.03%, all of it opus.
 */
export function billableParts(usage, model) {
  const parts = [{ model, usage }];
  for (const it of usage?.iterations ?? []) {
    if (it?.type === 'advisor_message') parts.push({ model: it.model ?? model, usage: it });
  }
  return parts;
}

/** Break a usage record into the four token classes the UI must show separately. */
export function tokensOf(usage) {
  const cc = usage?.cache_creation ?? {};
  return {
    input: usage?.input_tokens ?? 0,
    output: usage?.output_tokens ?? 0,
    cacheWrite5m: cc.ephemeral_5m_input_tokens ?? 0,
    cacheWrite1h: cc.ephemeral_1h_input_tokens ?? 0,
    cacheRead: usage?.cache_read_input_tokens ?? 0,
  };
}

/** Write the current LiteLLM rates for our models to the bundled snapshot. */
export async function writeSnapshot(models) {
  if (!state.rates) throw new Error('no rates loaded');
  const rates = {};
  for (const m of models) {
    if (state.rates[m]) rates[m] = state.rates[m];
  }
  const doc = { fetchedAt: state.fetchedAt ?? new Date().toISOString(), rates };
  await fsp.writeFile(PRICES_SNAPSHOT_FILE, JSON.stringify(doc, null, 2));
  return Object.keys(rates).length;
}

/** Load a snapshot synchronously — used by unit tests that skip initPricing(). */
export function loadSnapshotSync() {
  const doc = JSON.parse(fs.readFileSync(PRICES_SNAPSHOT_FILE, 'utf8'));
  state = { rates: doc.rates ?? doc, source: 'snapshot', fetchedAt: doc.fetchedAt ?? null, error: null };
  return state;
}

export const _internal = { pickRates, RATE_FIELDS, path };
