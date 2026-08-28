/**
 * The dashboard's pure logic: formatting, bucketing, sorting, validation.
 *
 * Split out of app.js so it can be unit-tested. Nothing here touches the DOM,
 * localStorage, or fetch — every function takes values and returns values. The
 * side-effecting halves (read the stored sort, re-render the table, persist the
 * choice) stay in app.js and call into this.
 */

/* ── formatting ───────────────────────────────────────────────────────────── */

/** Every "no value" renders as an em dash, never as $0 or 0 — see costOf(). */
export const EMPTY = '—';

export const usd = (n) =>
  n == null ? EMPTY : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Four decimals below a dollar: per-prompt costs are routinely sub-cent. */
export const usd4 = (n) => (n == null ? EMPTY : `$${n.toFixed(n < 1 ? 4 : 2)}`);

export const num = (n) => (n == null ? EMPTY : n.toLocaleString('en-US'));

export const compact = (n) =>
  n == null ? EMPTY : Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);

export const when = (ts) => (ts ? new Date(ts).toLocaleString('zh-TW', { hour12: false }) : EMPTY);

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Every interpolation into a template string goes through this. */
export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

/* ── period bucketing ─────────────────────────────────────────────────────── */

/** Re-bucket ccusage rows: sum modelBreakdowns per keyOf(period). */
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

/** Monday of the week containing an ISO date — same anchor as the 趨勢 tab. */
export const weekOf = (iso) => {
  const dt = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
  return dt.toISOString().slice(0, 10);
};

export const yearOf = (period) => period.slice(0, 4);

/* ── font zoom ────────────────────────────────────────────────────────────── */

export const FONT_MIN = 0.8;
export const FONT_MAX = 1.6;
export const FONT_STEP = 0.1;

/** 5% granularity: matches the slider step and keeps ±10% steps clean. */
const FONT_GRANULARITY = 20;

export function clampFont(v) {
  return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(v * FONT_GRANULARITY) / FONT_GRANULARITY));
}

/* ── session table sorting ────────────────────────────────────────────────── */

/**
 * Multi-column sort for the session table. Each header click cycles that column
 * asc -> desc -> off; a column already in the list toggles in place and keeps its
 * priority, a new one is appended at the end. An empty list means "server order"
 * (trueCost desc) — which is what the third click restores.
 */
export const SESSION_SORTS = {
  projectLabel: { cmp: (a, b) => String(a.projectLabel ?? '').localeCompare(String(b.projectLabel ?? ''), 'zh-TW') },
  lastActivity: { cmp: (a, b) => (Date.parse(a.lastActivity) || 0) - (Date.parse(b.lastActivity) || 0) },
  promptCount: { cmp: (a, b) => (a.promptCount ?? 0) - (b.promptCount ?? 0) },
  trueCost: { cmp: (a, b) => (a.trueCost ?? 0) - (b.trueCost ?? 0) },
};

const DIRECTIONS = new Set(['asc', 'desc']);

/**
 * A stored sort list, reduced to the entries that still make sense.
 *
 * A stale or hand-edited stored value must not take the whole tab down with it:
 * unknown columns (renamed or removed since), bad directions and duplicates are
 * dropped rather than trusted.
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
 * The sort list after clicking `key`: absent -> asc -> desc -> absent.
 * Returns a new list; an unknown key leaves the current one untouched.
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
 * Rows in the requested order.
 *
 * Sorts a COPY: the caller's array stays in server order, which the overview tab
 * and the "cancel sort" state both read. Array.prototype.sort is stable, so ties
 * under the active keys fall back to that server order with no explicit tiebreak.
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

/** How one column should render its header: active direction, arrow, priority. */
export function sortIndicator(sort, key) {
  const i = sort.findIndex((e) => e.key === key);
  if (i < 0) return { active: false, aria: 'none', arrow: '', rank: null };
  const asc = sort[i].dir === 'asc';
  return {
    active: true,
    aria: asc ? 'ascending' : 'descending',
    arrow: asc ? '▲' : '▼',
    // Priority index only earns its space once there is more than one key.
    rank: sort.length > 1 ? i + 1 : null,
  };
}

/* ── export dialog ────────────────────────────────────────────────────────── */

/**
 * Same cleanup as the server: no path chars, no quotes, and no `_` — that is the
 * field separator in the export filename, so one inside the 工號 would split it.
 */
export const sanitizeEmpId = (raw) => String(raw ?? '').replace(/["'\\/:*?<>|_]/g, '').trim();

/**
 * The range to export: whatever the user picked, falling back per-side to the
 * first and last day the data actually covers.
 */
export function exportRangeFrom({ since, until }, periods) {
  const days = [...periods].sort();
  return { since: since || days[0], until: until || days[days.length - 1] };
}
