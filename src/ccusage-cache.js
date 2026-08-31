import { daily as ccusageDaily, version as ccusageVersion } from './ccusage.js';
import { currentFingerprint } from './cache.js';
import { CCUSAGE_SWR_MS } from './config.js';

/**
 * 全區間 `ccusage daily` 文件的快取。
 *
 * ccusage 每跑一次就會把所有記錄重新解析一遍（在這份語料上實測約 4 秒），
 * 而以前每次載入頁面會呼叫它三次（總覽的 daily + monthly、健康狀態的 daily）。
 * 現在改成「不帶日期區間」跑一次、把文件快取起來，之後每個區間請求都用篩選
 * 每日資料列來服務 —— 數字完全相同，成本只有一次陣列篩選。`monthly` 也是從
 * 同一批資料列合成的，這同樣與 ccusage 一致（它也是先篩日期再分桶）。
 *
 * 失效機制：
 * - 對 Claude 記錄算指紋（就是 cache.js 用的那個約 9 毫秒的掃描）：
 *   我們自己產生的新用量會觸發一次阻塞式重跑，所以對帳閘門比較的數字，
 *   相對於我們的解析器永遠不會是過期的。
 * - ccusage 另外還會讀其他 agent 的記錄，那是指紋看不到的，所以文件只要超過
 *   CCUSAGE_SWR_MS 就先回舊的，同時在背景重新抓（偏差有上限，且永遠不必等那 4 秒）。
 */
let memo = null; // { fp, at, doc }
let inflight = null; // 讓並行的冷啟動合併成一次（總覽 + 健康狀態）

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
 * ccusage 的版本在我們執行期間不可能改變 —— 每個程序只問一次。
 *
 * 成功的結果永久快取；失敗則不快取。以前啟動時只要出一次小狀況，健康狀態卡就會
 * 一直卡在「無法取得」直到 app 重啟，因為那個失敗被固化進這個 promise 裡了
 * （而且 version() 還把它藏在一個字串裡）。
 */
export function cachedVersion() {
  versionPromise ??= ccusageVersion().catch((err) => {
    versionPromise = null; // 讓下一個請求可以再試一次
    return `unavailable (${err?.kind ?? 'error'})`;
  });
  return versionPromise;
}

/** 每日資料列本身已是彙總值，所以區間篩選就只是字串比較。 */
export function filterDaily(doc, { since, until } = {}) {
  let rows = doc.daily ?? [];
  if (since) rows = rows.filter((r) => String(r.period) >= since);
  if (until) rows = rows.filter((r) => String(r.period) <= until);
  return { ...doc, daily: rows };
}

/**
 * 刻意使用 ccusage「自己」的明細欄位名稱。
 *
 * 這些資料列是用來代替 `ccusage monthly` 的輸出，所以形狀必須跟 ccusage 一致。
 * modelTotalsFromDaily（ccusage.js）看起來是同一種彙總，其實不是：它會轉換成我們
 * 內部的 cacheWrite/cacheRead 名稱。兩套結構、兩種使用對象 —— 不要把它們合併。
 */
const BREAKDOWN_FIELDS = ['cost', 'inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens'];

/** `period` 是 ccusage 在每日資料列輸出的帶連字號 YYYY-MM-DD 格式。 */
const monthKeyOf = (period) => String(period).slice(0, 'YYYY-MM'.length);

/** 從每日資料列合成 `ccusage monthly` 的資料列（依 YYYY-MM 加總）。 */
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
