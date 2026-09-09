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

/** 為一個模型定價所需要的費率欄位。 */
const RATE_FIELDS = [
  'input_cost_per_token',
  'output_cost_per_token',
  'cache_creation_input_token_cost',
  'cache_creation_input_token_cost_above_1hr',
  'cache_read_input_token_cost',
];

/**
 * 標記模型 fast 模式變體的後綴。刻意與 `ccusage` 回報的名稱一致
 * （claude-opus-5-fast），這樣兩邊的每一列才對得起來。
 */
const FAST_SUFFIX = '-fast';

/**
 * 一筆 usage 記錄實際上以哪個模型計費。
 *
 * 具冪等性，因為它既會在產生 byModel 的鍵時套用，也會在 costOf() 內部對傳進來的
 * 任何鍵再套用一次。
 */
export function billingModelOf(usage, model) {
  if (!model || usage?.speed !== 'fast' || model.endsWith(FAST_SUFFIX)) return model;
  return `${model}${FAST_SUFFIX}`;
}

let state = {
  rates: null,
  /** model -> fast 模式的價格倍率（見 fetchModelsDev） */
  fastMultipliers: null,
  /** 主來源沒收錄、改由 models.dev 補上費率的模型（見 withFallbackRates） */
  fallbackModels: [],
  /** 'litellm' | 'cache' | 'snapshot' | 'models.dev' */
  source: null,
  fetchedAt: null,
  error: null,
};

/**
 * 替換 state 的唯一途徑。
 *
 * scaledCache 存的是由 `state.rates` × 公布的加價倍率推導出來的 `<model>-fast`
 * 費率表，所以它只對「當初推導它的那份費率」有效。以前直接指派 state，會讓它繼續
 * 持有用「上一份」費率算出來的表 —— 於是 fast 模型在整個程序的生命週期裡都以舊費率
 * 計費。當時只有 initPricing() 剛好會清它；它內部的 cache 與 snapshot fallback，
 * 以及 loadSnapshotSync()，都不會。
 */
function setState(next) {
  state = next;
  scaledCache.clear();
}

/**
 * 1 小時快取寫入的計費費率，找不到時退回 5 分鐘的費率。
 *
 * 這個 fallback 正是重點：模型可能只公布 `cache_creation_input_token_cost` 而沒有
 * `_above_1hr` 版本，但 1 小時寫入還是得用某個價格計費。它放在這裡 —— 也就是負責
 * 定價的模組 —— 因為 aggregate.js 會用同一份費率表重算快取寫入成本，而且「必須」
 * 用完全相同的規則：把這個算式抄成三份，就是給了改善建議分頁三個機會去跟它正在
 * 解釋的那個總額對不起來。
 */
export function cacheWrite1hRateOf(rates) {
  return rates?.cache_creation_input_token_cost_above_1hr ?? rates?.cache_creation_input_token_cost ?? 0;
}

/**
 * 看到以 speed=fast 計費、但我們沒有對應倍率的模型。
 *
 * 絕不會靜默地放過：這種訊息會以標準費率計費，等於少報了那個加價（目前有公布的
 * 模型都是 2 倍）。verify() 會對這份清單設閘門，好讓新支援 fast 的模型「大聲地」
 * 失敗，而不是悄悄把總額算便宜。
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

/** models.dev 以「每百萬 token」報價；本模組內部一律用「每 token」。 */
const PER_MILLION = 1e6;

/**
 * models.dev 上唯一可信的「絕對費率」發布者。
 *
 * 同一個 model id 會出現在幾十個供應商底下，價格各不相同（實測：`claude-fable-5-1`
 * 在 venice 是 12/60、在 302ai 完全沒有快取費率，`claude-opus-4-8` 在 unorouter 是
 * 0.425/2.125）。走訪「所有」供應商再讓後寫入者覆蓋前者，等於隨機挑一家轉售商的牌價，
 * 所以費率只取 anthropic 這一份。
 *
 * 加價倍率則相反，仍走全部供應商：倍率是「同一個供應商」的 fast.input ÷ base.input，
 * 是個相對值，不受發布者的牌價高低影響。
 */
const MODELSDEV_RATE_PROVIDER = 'anthropic';

/**
 * Anthropic 公布的 1 小時快取寫入費率是 input 的 2 倍。
 *
 * models.dev 只有一個 `cache_write` 欄位（也就是 5 分鐘那個），沒有 1 小時的版本，
 * 所以 1 小時費率由 input 推導。這不是猜的：兩份型錄都有收錄的 14 個 Claude 模型，
 * LiteLLM 的 `above_1hr ÷ input` 全部恰為 2.000、`cache_write ÷ input` 全部恰為 1.250。
 * 少了這一步，靠 fallback 定價的模型其 1 小時寫入會被當成 5 分鐘價（1.25 倍）計費。
 */
const CACHE_WRITE_1H_MULTIPLIER = 2;

/**
 * 把 models.dev 的 `cost` 區塊轉成我們的費率欄位。
 *
 * 只映射真的有公布的欄位（外加上面那個 1 小時的推導）—— 憑空補一個沒公布的費率，
 * 跟少報一樣是在說謊。缺 input／output 的項目直接視為不可定價。
 */
function ratesFromModelsDev(cost) {
  if (typeof cost?.input !== 'number' || typeof cost?.output !== 'number') return null;
  const rec = {
    input_cost_per_token: cost.input / PER_MILLION,
    output_cost_per_token: cost.output / PER_MILLION,
    cache_creation_input_token_cost_above_1hr: (cost.input * CACHE_WRITE_1H_MULTIPLIER) / PER_MILLION,
  };
  if (typeof cost.cache_write === 'number') {
    rec.cache_creation_input_token_cost = cost.cache_write / PER_MILLION;
  }
  if (typeof cost.cache_read === 'number') {
    rec.cache_read_input_token_cost = cost.cache_read / PER_MILLION;
  }
  return rec;
}

/**
 * 從 models.dev 取兩樣東西：fast 模式的加價倍率，以及一份備用費率表。
 *
 * 倍率 —— Claude Code 的 fast 模式（`/fast`）會用加價對同一個模型計費，並在每則這類
 * 訊息上標記 `usage.speed === "fast"`。LiteLLM 完全沒有建模這件事：它沒有
 * `claude-opus-5-fast` 這筆資料，也沒有速度這個維度，所以在這份語料上有 165 則訊息
 * 被以標準費率計費，全域總額比 `ccusage daily` 少了 2.06%。models.dev 把它放在
 * `experimental.modes.fast`，判斷依據正是我們從記錄裡讀的同一個欄位
 * （`provider.body.speed === "fast"`）。我們只取比值，不取絕對費率 —— models.dev 沒有
 * 5m/1h 快取寫入拆分的概念（已驗證：opus-4-8 與 opus-5 四項皆為 2.00 倍）。
 *
 * 備用費率 —— 見 withFallbackRates：新模型會比 LiteLLM 型錄先到。
 */
async function fetchModelsDev() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LITELLM_TIMEOUT_MS);
  try {
    const res = await fetch(MODELSDEV_PRICES_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = await res.json();
    const fastMultipliers = {};
    for (const provider of Object.values(doc)) {
      for (const [id, m] of Object.entries(provider?.models ?? {})) {
        const fast = m?.experimental?.modes?.fast?.cost;
        const base = m?.cost;
        if (!fast || !base?.input) continue;
        fastMultipliers[id] = fast.input / base.input;
      }
    }
    const rates = {};
    for (const [id, m] of Object.entries(doc[MODELSDEV_RATE_PROVIDER]?.models ?? {})) {
      const rec = ratesFromModelsDev(m?.cost);
      if (rec) rates[id] = rec;
    }
    return { rates, fastMultipliers };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * LiteLLM 為主，models.dev 只補「LiteLLM 還沒收錄的模型」。
 *
 * 這是那 3.23% 對帳缺口的修正。新模型發布後，LiteLLM 型錄要過幾天才跟上；在那之前
 * 它的訊息會照算 token、卻算不出金額 —— addPart()（attribute.js）對沒有費率的模型
 * 「只計 token、不計金額」，於是它那一整份支出從全域總額憑空消失。實測把
 * `claude-fable-5-1` 從型錄拿掉，$83.08 被靜默漏掉，對帳偏差 3.28%。
 *
 * ccusage 不會有這個問題：Claude Code 自己就把 costUSD 寫進記錄檔，它預設的 auto
 * 模式直接採用，所以缺口全部落在我們這一側 —— 這也是為什麼症狀只表現成「對帳偏差」。
 *
 * 方向是刻意的：LiteLLM 有的就以 LiteLLM 為準，因為只有它把 5 分鐘與 1 小時的快取
 * 寫入費率分開公布 —— config.js 已把「絕對費率以 LiteLLM 為準」定為決策。
 */
function withFallbackRates(primary, fallback) {
  const rates = { ...primary };
  const filled = [];
  for (const [model, rec] of Object.entries(fallback ?? {})) {
    if (rates[model]) continue;
    rates[model] = rec;
    filled.push(model);
  }
  return { rates, filled: filled.sort() };
}

async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}

/** 磁碟上最後一份可用的倍率，供 models.dev 短暫連不上時使用。 */
async function diskFastMultipliers() {
  for (const file of [PRICES_CACHE_FILE, PRICES_SNAPSHOT_FILE]) {
    try {
      const doc = await readJson(file);
      if (doc?.fastMultipliers && Object.keys(doc.fastMultipliers).length) return doc.fastMultipliers;
    } catch {
      // 試下一個檔案
    }
  }
  return null;
}

/**
 * 啟動時解析一次定價：LiteLLM -> 磁碟快取 -> 內建快照 -> models.dev。
 * 絕不拋錯；全部失敗時 `state.rates` 維持 null，costOf() 回傳 null，
 * UI 會顯示成「—」而不是誤導人的 $0。
 *
 * 前三條路徑「每一條」都會再讓 models.dev 補上它沒收錄的模型（withFallbackRates）：
 * 三者都會漏掉剛發布的模型，而漏掉的代價不是顯示成「—」，是整份總額靜默少報。
 *
 * 一個程序只跑一次。使用者在型錄補上新模型「之前」啟動的儀表板，要重開才會拿到
 * 新費率 —— 這正是那面 3.23% 橫幅會留在畫面上的原因。
 */
export async function initPricing() {
  resetUnknownFastModels();
  // 與費率抓取彼此獨立：models.dev 掛掉不該害我們拿不到 LiteLLM 的費率，反之亦然。
  // 缺少倍率這件事會透過 unknownFast 浮出來。
  let modelsDev = null;
  try {
    modelsDev = await fetchModelsDev();
  } catch (err) {
    state.error = `models.dev fetch failed: ${err.message}`;
  }
  // 測試時實際遇過：一次逾時的抓取，就讓每則 fast 訊息靜默地變成半價。
  // 加價倍率的變動速度遠比我們抓型錄的頻率慢，所以「最後一份可用的副本」
  // 遠比「沒有」要好得多。
  let fastMultipliers = modelsDev?.fastMultipliers ?? null;
  fastMultipliers ??= await diskFastMultipliers();

  try {
    const { rates, filled } = withFallbackRates(await fetchLiteLLM(), modelsDev?.rates);
    setState({
      rates,
      fastMultipliers,
      fallbackModels: filled,
      source: 'litellm',
      fetchedAt: new Date().toISOString(),
      error: state.error,
    });
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
      // 磁碟上的副本一樣會漏掉新模型 —— 打包時的快照更是如此（它是發版當天凍結的），
      // 所以這條路徑同樣讓 models.dev 補漏。
      const { rates, filled } = withFallbackRates(doc.rates ?? doc, modelsDev?.rates);
      setState({
        rates,
        // 即時抓到的 models.dev 仍然優先於磁碟上過期的副本。
        fastMultipliers: fastMultipliers ?? doc.fastMultipliers ?? null,
        fallbackModels: filled,
        source,
        fetchedAt: doc.fetchedAt ?? null,
        error: state.error,
      });
      return state;
    } catch {
      // 試下一個 fallback
    }
  }

  // 磁碟上兩份都讀不到，但 models.dev 還活著。它至少涵蓋每一個 Claude 模型，
  // 而這裡的替代選項是「完全沒有費率」—— 那會讓整個儀表板變成一排「—」。
  if (modelsDev?.rates && Object.keys(modelsDev.rates).length) {
    setState({
      rates: modelsDev.rates,
      fastMultipliers,
      fallbackModels: Object.keys(modelsDev.rates).sort(),
      source: 'models.dev',
      fetchedAt: new Date().toISOString(),
      error: state.error,
    });
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
    // 主來源沒收錄、由 models.dev 補上費率的模型。非空不是錯誤，但它是一個訊號：
    // 這些模型的金額走的是備用型錄。
    fallbackModels: state.fallbackModels ?? [],
    error: state.error,
  };
}

/**
 * fast 模式被建模成一個虛擬模型 `<base>-fast` —— 也是 ccusage 回報的名稱。
 * 它的費率是基礎費率表乘上公布的加價倍率，如此一來每個使用者（成本計算、
 * 5m/1h 快取寫入拆分、改善建議分頁的費率欄）都能保持一致，而不需要知道
 * fast 模式的存在。
 *
 * 沒有公布加價倍率時，我們以「基礎費率」計費，而不是把訊息丟掉：基礎費率是下限，
 * $0 則是謊話。該模型會被記錄下來，好讓 verify 大聲地失敗，而不是讓總額悄悄變便宜。
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

/** 單一模型在 fast 模式的價格倍率；未公布時回傳 null。 */
export function fastMultiplierFor(model) {
  const m = state.fastMultipliers?.[model];
  return typeof m === 'number' && m > 0 ? m : null;
}

/**
 * 單一則 assistant 訊息的成本。
 *
 * 這個公式已在 session ced37f19 上與 ccusage 驗證到小數點後 8 位
 * （opus 85.52876450、sonnet 1.36267350）。5m/1h 的快取建立拆分很重要：
 * 1 小時寫入約為 input 的 2 倍，5 分鐘寫入約 1.25 倍。
 *
 * `usage.speed === "fast"` 會解析到 `<model>-fast` 那份費率表，而它「已經」含了
 * 加價 —— 這裡沒有額外的倍率會被忘記乘。鍵是「逐一可計費部分」解析的，不是逐行解析，
 * 這正是讓 advisor 層保持正確的關鍵：fast 訊息內部的 `advisor_message` 迭代本身
 * 不帶 `speed`，而 ccusage 也同樣不對它收加價（實測：本語料唯一一筆這種迭代是 $0.85，
 * 比對帳最後落在的 $0.08 殘差高了一個數量級）。
 *
 * 無法定價的模型回傳 null，好讓呼叫端顯示「—」而不是 $0。
 */
export function costOf(usage, model) {
  const p = ratesFor(billingModelOf(usage, model));
  if (!p || !usage) return null;
  const cc = usage.cache_creation ?? {};
  const write5m = cc.ephemeral_5m_input_tokens ?? 0;
  const write1h = cc.ephemeral_1h_input_tokens ?? 0;
  const rate1h = cacheWrite1hRateOf(p);

  return (
    (usage.input_tokens ?? 0) * (p.input_cost_per_token ?? 0) +
    (usage.output_tokens ?? 0) * (p.output_cost_per_token ?? 0) +
    write5m * (p.cache_creation_input_token_cost ?? 0) +
    write1h * rate1h +
    (usage.cache_read_input_tokens ?? 0) * (p.cache_read_input_token_cost ?? 0)
  );
}

/**
 * 一筆記錄項目實際要計費的 (model, usage) 組合 —— 通常就只有它自己。
 *
 * 高強度的 turn 會諮詢 advisor 模型，並把那次請求記成 `usage.iterations[]` 裡
 * 額外一筆 type 為 `advisor_message` 的項目，帶著它自己的 `model`。這些 token
 * 「不在」頂層 usage 裡：本機 15,030 筆帶 iterations 的項目全部驗證過，頂層的數字
 * 恰好等於非 advisor 迭代的總和。ccusage 會對 advisor 計費；漏掉它會讓我們的總額
 * 少報 1.03%，而且全部都是 opus。
 */
export function billableParts(usage, model) {
  const parts = [{ model: billingModelOf(usage, model), usage }];
  for (const it of usage?.iterations ?? []) {
    // 逐一部分、而非逐行判斷：fast 訊息內部的 advisor 迭代本身不帶 speed，
    // 而 ccusage 也同樣不對它收加價。
    if (it?.type === 'advisor_message') {
      parts.push({ model: billingModelOf(it, it.model ?? model), usage: it });
    }
  }
  return parts;
}

/** 把一筆 usage 記錄拆成 UI 必須分開顯示的幾種 token 類別。 */
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

/** 把目前 LiteLLM 上我們用到的模型費率寫進內建快照。 */
export async function writeSnapshot(models) {
  if (!state.rates) throw new Error('no rates loaded');
  const rates = {};
  const fastMultipliers = {};
  for (const model of models) {
    // byModel 現在也會產生 fast 的鍵；快照存的是真實模型加上它的加價倍率，
    // ratesFor() 再從這兩者還原出變體。
    const m = model.endsWith(FAST_SUFFIX) ? model.slice(0, -FAST_SUFFIX.length) : model;
    if (state.rates[m]) rates[m] = state.rates[m];
    // 加價倍率也要一起打包，否則離線的桌面版會少報 fast 模式的成本。
    if (state.fastMultipliers?.[m]) fastMultipliers[m] = state.fastMultipliers[m];
  }
  const doc = { fetchedAt: state.fetchedAt ?? new Date().toISOString(), rates, fastMultipliers };
  await fsp.writeFile(PRICES_SNAPSHOT_FILE, JSON.stringify(doc, null, 2));
  return Object.keys(rates).length;
}

/** 同步載入快照 —— 供跳過 initPricing() 的單元測試使用。 */
export function loadSnapshotSync() {
  const doc = JSON.parse(fs.readFileSync(PRICES_SNAPSHOT_FILE, 'utf8'));
  setState({
    rates: doc.rates ?? doc,
    fastMultipliers: doc.fastMultipliers ?? null,
    fallbackModels: [],
    source: 'snapshot',
    fetchedAt: doc.fetchedAt ?? null,
    error: null,
  });
  return state;
}

export const _internal = { pickRates, RATE_FIELDS, path, fetchModelsDev, ratesFromModelsDev, withFallbackRates, FAST_SUFFIX };
