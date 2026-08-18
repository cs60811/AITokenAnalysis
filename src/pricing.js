import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  CACHE_DIR,
  LITELLM_PRICES_URL,
  LITELLM_TIMEOUT_MS,
  MODELSDEV_PRICES_URL,
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

/**
 * Suffix marking the fast-mode variant of a model. Chosen to match the name
 * `ccusage` reports (claude-opus-5-fast) so the two agree row for row.
 */
const FAST_SUFFIX = '-fast';

/**
 * The model a usage record actually bills as.
 *
 * Idempotent, because it is applied both when minting byModel keys and again
 * inside costOf() on whatever key it is handed.
 */
export function billingModelOf(usage, model) {
  if (!model || usage?.speed !== 'fast' || model.endsWith(FAST_SUFFIX)) return model;
  return `${model}${FAST_SUFFIX}`;
}

let state = {
  rates: null,
  /** model -> price multiplier for fast mode (see fetchFastMultipliers) */
  fastMultipliers: null,
  /** 'litellm' | 'cache' | 'snapshot' */
  source: null,
  fetchedAt: null,
  error: null,
};

/**
 * Models seen billing at speed=fast that we had no multiplier for.
 *
 * Never empty silently: such a message is charged at the standard rate, which
 * under-reports by whatever the premium is (2x on every model that publishes
 * one so far). verify() gates on this so a newly fast-capable model fails loudly
 * instead of quietly cheapening the total.
 */
const unknownFast = new Set();
export const unknownFastModels = () => [...unknownFast];
export const resetUnknownFastModels = () => unknownFast.clear();

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

/**
 * Fast-mode price multipliers, keyed by model.
 *
 * Claude Code's fast mode (`/fast`) bills the same model at a premium and marks
 * every such message `usage.speed === "fast"`. LiteLLM does not model this at
 * all — it has no `claude-opus-5-fast` entry and no speed dimension — so on this
 * corpus 165 messages were billed at the standard rate and the global total came
 * out 2.06% under `ccusage daily`.
 *
 * models.dev carries it as `experimental.modes.fast`, identified by exactly the
 * field we read from the transcript (`provider.body.speed === "fast"`). We take
 * only the ratio, not the absolute rates: LiteLLM is the authority on the 5m/1h
 * cache-write split that models.dev has no concept of, and the premium is
 * uniform across input/output/read/write on every model that publishes one
 * (verified: opus-4-8 and opus-5 are 2.00x on all four).
 */
async function fetchFastMultipliers() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LITELLM_TIMEOUT_MS);
  try {
    const res = await fetch(MODELSDEV_PRICES_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = await res.json();
    const out = {};
    for (const provider of Object.values(doc)) {
      for (const [id, m] of Object.entries(provider?.models ?? {})) {
        const fast = m?.experimental?.modes?.fast?.cost;
        const base = m?.cost;
        if (!fast || !base?.input) continue;
        out[id] = fast.input / base.input;
      }
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}

/** Last good multipliers on disk, for when models.dev is briefly unreachable. */
async function diskFastMultipliers() {
  for (const file of [PRICES_CACHE_FILE, PRICES_SNAPSHOT_FILE]) {
    try {
      const doc = await readJson(file);
      if (doc?.fastMultipliers && Object.keys(doc.fastMultipliers).length) return doc.fastMultipliers;
    } catch {
      // try the next file
    }
  }
  return null;
}

/**
 * Resolve pricing once at startup: LiteLLM -> on-disk cache -> bundled snapshot.
 * Never throws; on total failure `state.rates` stays null and costOf() returns null,
 * which the UI renders as "—" rather than a misleading $0.
 */
export async function initPricing() {
  resetUnknownFastModels();
  scaledCache.clear();
  // Independent of the rate fetch: a models.dev outage must not cost us LiteLLM
  // rates, and vice versa. A missing multiplier surfaces through unknownFast.
  let fastMultipliers = null;
  try {
    fastMultipliers = await fetchFastMultipliers();
  } catch (err) {
    state.error = `models.dev fetch failed: ${err.message}`;
  }
  // Observed in testing: one timed-out fetch and every fast message silently
  // reverts to half price. The premium changes far more slowly than the catalog
  // is fetched, so the last good copy is a much better answer than none.
  fastMultipliers ??= await diskFastMultipliers();

  try {
    const rates = await fetchLiteLLM();
    state = {
      rates,
      fastMultipliers,
      source: 'litellm',
      fetchedAt: new Date().toISOString(),
      error: state.error,
    };
    await fsp.mkdir(CACHE_DIR, { recursive: true });
    await fsp.writeFile(
      PRICES_CACHE_FILE,
      JSON.stringify({ fetchedAt: state.fetchedAt, rates, fastMultipliers }, null, 2),
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
        // A live models.dev still wins over a stale on-disk copy.
        fastMultipliers: fastMultipliers ?? doc.fastMultipliers ?? null,
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
    fastModelCount: state.fastMultipliers ? Object.keys(state.fastMultipliers).length : 0,
    unknownFastModels: unknownFastModels(),
    error: state.error,
  };
}

/**
 * Fast mode is modelled as a virtual model `<base>-fast` — the name ccusage also
 * reports. Its rates are the base sheet scaled by the published premium, so every
 * consumer (cost, the 5m/1h cache-write split, the rate columns in the improvement
 * tab) stays consistent without needing to know fast mode exists.
 *
 * With no published premium we bill the BASE rate rather than dropping the
 * message: base is a floor, $0 would be a lie. The model is recorded so that
 * verify fails loudly instead of the total quietly cheapening.
 */
const scaledCache = new Map();

export function ratesFor(model) {
  if (!model?.endsWith(FAST_SUFFIX)) return state.rates?.[model] ?? null;
  if (scaledCache.has(model)) return scaledCache.get(model);

  const bare = model.slice(0, -FAST_SUFFIX.length);
  const base = state.rates?.[bare] ?? null;
  if (!base) return null;

  const mult = fastMultiplierFor(bare);
  if (mult == null) unknownFast.add(bare);
  const rec = {};
  for (const [k, v] of Object.entries(base)) rec[k] = v * (mult ?? 1);
  scaledCache.set(model, rec);
  return rec;
}

export function hasRates(model) {
  return ratesFor(model) != null;
}

/** Price multiplier for one model in fast mode, or null when unpublished. */
export function fastMultiplierFor(model) {
  const m = state.fastMultipliers?.[model];
  return typeof m === 'number' && m > 0 ? m : null;
}

/**
 * Cost of one assistant message.
 *
 * This formula was verified against ccusage to 8 decimal places on session
 * ced37f19 (opus 85.52876450, sonnet 1.36267350). The 5m/1h cache-creation
 * split matters: a 1h write costs ~2x input, a 5m write ~1.25x.
 *
 * `usage.speed === "fast"` resolves to the `<model>-fast` rate sheet, which
 * already carries the premium — there is no multiplier here to forget. The key is
 * resolved per billable part, not per transcript line, which is what keeps the
 * advisor tier correct: an `advisor_message` iteration inside a fast message
 * carries no `speed` of its own and ccusage does not charge it the premium either
 * (measured: the one such iteration on this corpus is $0.85, an order of magnitude
 * above the $0.08 residual the reconciliation lands on).
 *
 * Returns null for an unpriced model so callers can render "—" instead of $0.
 */
export function costOf(usage, model) {
  const p = ratesFor(billingModelOf(usage, model));
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
  const parts = [{ model: billingModelOf(usage, model), usage }];
  for (const it of usage?.iterations ?? []) {
    // Per part, not per line: an advisor iteration inside a fast message carries
    // no speed of its own, and ccusage does not charge it the premium either.
    if (it?.type === 'advisor_message') {
      parts.push({ model: billingModelOf(it, it.model ?? model), usage: it });
    }
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
  const fastMultipliers = {};
  for (const model of models) {
    // byModel now yields fast keys too; the snapshot stores the real model plus
    // its premium, and ratesFor() reconstitutes the variant from those two.
    const m = model.endsWith(FAST_SUFFIX) ? model.slice(0, -FAST_SUFFIX.length) : model;
    if (state.rates[m]) rates[m] = state.rates[m];
    // Ship the premium too, or the offline desktop build under-reports fast mode.
    if (state.fastMultipliers?.[m]) fastMultipliers[m] = state.fastMultipliers[m];
  }
  const doc = { fetchedAt: state.fetchedAt ?? new Date().toISOString(), rates, fastMultipliers };
  await fsp.writeFile(PRICES_SNAPSHOT_FILE, JSON.stringify(doc, null, 2));
  return Object.keys(rates).length;
}

/** Load a snapshot synchronously — used by unit tests that skip initPricing(). */
export function loadSnapshotSync() {
  const doc = JSON.parse(fs.readFileSync(PRICES_SNAPSHOT_FILE, 'utf8'));
  state = {
    rates: doc.rates ?? doc,
    fastMultipliers: doc.fastMultipliers ?? null,
    source: 'snapshot',
    fetchedAt: doc.fetchedAt ?? null,
    error: null,
  };
  return state;
}

export const _internal = { pickRates, RATE_FIELDS, path, fetchFastMultipliers, FAST_SUFFIX };
