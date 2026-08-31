/**
 * 儀表板的純邏輯：格式化、分桶、排序、驗證。
 *
 * 從 app.js 拆出來，好讓它可以被單元測試。這裡完全不碰 DOM、localStorage 或 fetch ——
 * 每個函式都是吃值、回值。有副作用的那一半（讀取儲存的排序、重繪表格、寫回選擇）
 * 留在 app.js，由它呼叫這裡。
 */

/* ── 格式化 ───────────────────────────────────────────────────────────────── */

/** 所有「沒有數值」一律顯示破折號，絕不顯示 $0 或 0 —— 見 costOf()。 */
export const EMPTY = '—';

export const usd = (n) =>
  n == null ? EMPTY : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** 未滿 1 美元顯示到小數第四位：單一語句的成本經常不到 1 分錢。 */
export const usd4 = (n) => (n == null ? EMPTY : `$${n.toFixed(n < 1 ? 4 : 2)}`);

export const num = (n) => (n == null ? EMPTY : n.toLocaleString('en-US'));

export const compact = (n) =>
  n == null ? EMPTY : Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);

export const when = (ts) => (ts ? new Date(ts).toLocaleString('zh-TW', { hour12: false }) : EMPTY);

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** 每一個要插進樣板字串的值都必須經過這裡。 */
export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

/* ── 期間分桶 ─────────────────────────────────────────────────────────────── */

/** 重新分桶 ccusage 的資料列：依 keyOf(period) 把 modelBreakdowns 加總。 */
export function bucketBy(src, keyOf) {
  const map = new Map();
  for (const r of src) {
    const k = keyOf(String(r.period));
    let agg = map.get(k);
    if (!agg) {
      agg = { period: k, modelBreakdowns: new Map() };
      map.set(k, agg);
    }
    for (const b of r.modelBreakdowns ?? []) {
      agg.modelBreakdowns.set(b.modelName, (agg.modelBreakdowns.get(b.modelName) ?? 0) + (b.cost ?? 0));
    }
  }
  return [...map.values()].map((a) => ({
    period: a.period,
    modelBreakdowns: [...a.modelBreakdowns.entries()].map(([modelName, cost]) => ({ modelName, cost })),
  }));
}

/** 某個 ISO 日期所在那一週的星期一 —— 與「趨勢」分頁用同一個基準。 */
export const weekOf = (iso) => {
  const dt = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
  return dt.toISOString().slice(0, 10);
};

export const yearOf = (period) => period.slice(0, 4);

/* ── 字體縮放 ─────────────────────────────────────────────────────────────── */

export const FONT_MIN = 0.8;
export const FONT_MAX = 1.6;
export const FONT_STEP = 0.1;

/** 以 5% 為級距：與滑桿的步進一致，也讓 ±10% 的按鍵調整維持整齊。 */
const FONT_GRANULARITY = 20;

export function clampFont(v) {
  return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(v * FONT_GRANULARITY) / FONT_GRANULARITY));
}

/* ── session 表格排序 ─────────────────────────────────────────────────────── */

/**
 * session 表格的多欄排序。每次點擊標頭會讓該欄在「升冪 -> 降冪 -> 取消」之間循環；
 * 已經在清單裡的欄位會就地切換並保留它的優先序，新的欄位則接在最後面。
 * 空清單代表「伺服器順序」（trueCost 遞減）—— 那也正是第三次點擊要還原的狀態。
 */
export const SESSION_SORTS = {
  projectLabel: { cmp: (a, b) => String(a.projectLabel ?? '').localeCompare(String(b.projectLabel ?? ''), 'zh-TW') },
  lastActivity: { cmp: (a, b) => (Date.parse(a.lastActivity) || 0) - (Date.parse(b.lastActivity) || 0) },
  promptCount: { cmp: (a, b) => (a.promptCount ?? 0) - (b.promptCount ?? 0) },
  trueCost: { cmp: (a, b) => (a.trueCost ?? 0) - (b.trueCost ?? 0) },
};

const DIRECTIONS = new Set(['asc', 'desc']);

/**
 * 把儲存下來的排序清單，篩成仍然合理的那些項目。
 *
 * 一個過期或被手動改過的儲存值，絕不該把整個分頁一起拖垮：
 * 不認識的欄位（後來被改名或移除的）、錯誤的排序方向、重複項目，一律丟掉而不是信任它。
 */
export function sanitizeSessionSort(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const e of raw) {
    if (!e || !SESSION_SORTS[e.key] || !DIRECTIONS.has(e.dir) || seen.has(e.key)) continue;
    seen.add(e.key);
    out.push({ key: e.key, dir: e.dir });
  }
  return out;
}

/**
 * 點擊 `key` 之後的排序清單：不存在 -> 升冪 -> 降冪 -> 不存在。
 * 回傳一份新的清單；不認識的鍵則原封不動回傳目前這份。
 */
export function cycleSort(current, key) {
  if (!SESSION_SORTS[key]) return current;
  const next = current.map((e) => ({ ...e }));
  const i = next.findIndex((e) => e.key === key);
  if (i < 0) next.push({ key, dir: 'asc' });
  else if (next[i].dir === 'asc') next[i] = { key, dir: 'desc' };
  else next.splice(i, 1);
  return next;
}

/**
 * 依指定順序排好的資料列。
 *
 * 排序的是一份「副本」：呼叫端的陣列維持伺服器順序，而總覽分頁與「取消排序」
 * 的狀態都會讀它。Array.prototype.sort 是穩定排序，所以在所有作用中的鍵上都相等的
 * 資料列，自然會落回那個伺服器順序，不需要額外寫決勝條件。
 */
export function sortRows(rows, sort) {
  if (!sort.length) return rows;
  return [...rows].sort((a, b) => {
    for (const { key, dir } of sort) {
      const v = SESSION_SORTS[key].cmp(a, b);
      if (v) return dir === 'asc' ? v : -v;
    }
    return 0;
  });
}

/** 單一欄位的標頭該怎麼呈現：目前的排序方向、箭頭、優先序。 */
export function sortIndicator(sort, key) {
  const i = sort.findIndex((e) => e.key === key);
  if (i < 0) return { active: false, aria: 'none', arrow: '', rank: null };
  const asc = sort[i].dir === 'asc';
  return {
    active: true,
    aria: asc ? 'ascending' : 'descending',
    arrow: asc ? '▲' : '▼',
    // 只有在作用中的鍵超過一個時，優先序數字才值得佔那個版面。
    rank: sort.length > 1 ? i + 1 : null,
  };
}

/* ── 匯出對話框 ───────────────────────────────────────────────────────────── */

/**
 * 與伺服器端相同的清理：不留路徑字元、不留引號、也不留 `_` —— 那是匯出檔名裡的
 * 欄位分隔符，工號裡若含有它就會把檔名切錯。
 */
export const sanitizeEmpId = (raw) => String(raw ?? '').replace(/["'\\/:*?<>|_]/g, '').trim();

/**
 * 要匯出的區間：以使用者選的為準，任一側沒選就分別退回資料實際涵蓋的第一天與最後一天。
 */
export function exportRangeFrom({ since, until }, periods) {
  const days = [...periods].sort();
  return { since: since || days[0], until: until || days[days.length - 1] };
}
