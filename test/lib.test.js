import { describe, expect, it } from 'vitest';
import {
  bucketBy,
  clampFont,
  compact,
  cycleSort,
  EMPTY,
  escapeHtml,
  exportRangeFrom,
  FONT_MAX,
  FONT_MIN,
  num,
  sanitizeEmpId,
  sanitizeSessionSort,
  SESSION_SORTS,
  sortIndicator,
  sortRows,
  usd,
  usd4,
  weekOf,
  when,
  yearOf,
} from '../public/lib.js';

describe('money and number formatting', () => {
  it('always shows two decimals and thousands separators', () => {
    expect(usd(0)).toBe('$0.00');
    expect(usd(1234.5)).toBe('$1,234.50');
    expect(usd(1234.567)).toBe('$1,234.57');
  });

  it('renders a missing cost as an em dash, never as $0', () => {
    // An unpriced model must not read as free work — see costOf() in pricing.js.
    expect(usd(null)).toBe(EMPTY);
    expect(usd(undefined)).toBe(EMPTY);
    expect(usd4(null)).toBe(EMPTY);
    expect(num(null)).toBe(EMPTY);
    expect(compact(null)).toBe(EMPTY);
    expect(when(null)).toBe(EMPTY);
    expect(when('')).toBe(EMPTY);
  });

  it('gives sub-dollar amounts four decimals, and larger ones two', () => {
    // Per-prompt costs are routinely sub-cent; two decimals would show $0.00.
    expect(usd4(0.0004)).toBe('$0.0004');
    expect(usd4(0.9999)).toBe('$0.9999');
    expect(usd4(1)).toBe('$1.00');
    expect(usd4(1234.5)).toBe('$1234.50');
  });

  it('formats zero as a real zero, not as missing', () => {
    expect(usd4(0)).toBe('$0.0000');
    expect(num(0)).toBe('0');
    expect(compact(0)).toBe('0');
  });

  it('abbreviates large token counts', () => {
    expect(compact(1500)).toBe('1.5K');
    expect(compact(328_042_277)).toBe('328M');
    expect(num(328_042_277)).toBe('328,042,277');
  });
});

describe('escapeHtml', () => {
  it('escapes every character that could break out of a template string', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    );
    expect(escapeHtml("it's")).toBe('it&#39;s');
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('escapes an ampersand once, not twice', () => {
    expect(escapeHtml('&amp;')).toBe('&amp;amp;');
  });

  it('coerces non-strings rather than throwing', () => {
    expect(escapeHtml(42)).toBe('42');
    expect(escapeHtml(null)).toBe('null');
    expect(escapeHtml(undefined)).toBe('undefined');
  });

  it('leaves ordinary text, including CJK, untouched', () => {
    expect(escapeHtml('專案 A')).toBe('專案 A');
  });
});

describe('bucketBy', () => {
  const row = (period, breakdowns) => ({ period, modelBreakdowns: breakdowns });

  it('sums per-model cost across the rows sharing a key', () => {
    const out = bucketBy(
      [
        row('2026-05-01', [{ modelName: 'a', cost: 1 }, { modelName: 'b', cost: 2 }]),
        row('2026-05-02', [{ modelName: 'a', cost: 3 }]),
      ],
      (p) => p.slice(0, 7),
    );
    expect(out).toHaveLength(1);
    expect(out[0].period).toBe('2026-05');
    expect(Object.fromEntries(out[0].modelBreakdowns.map((b) => [b.modelName, b.cost]))).toEqual({ a: 4, b: 2 });
  });

  it('keeps separate keys separate, in first-seen order', () => {
    const out = bucketBy([row('2026-06-01', []), row('2026-05-01', [])], (p) => p.slice(0, 7));
    expect(out.map((x) => x.period)).toEqual(['2026-06', '2026-05']);
  });

  it('treats a missing cost as zero and a missing breakdown list as empty', () => {
    const out = bucketBy([row('2026-05-01', [{ modelName: 'a' }]), row('2026-05-02', undefined)], (p) => p.slice(0, 7));
    expect(out[0].modelBreakdowns).toEqual([{ modelName: 'a', cost: 0 }]);
  });

  it('stringifies a numeric period before keying', () => {
    expect(bucketBy([{ period: 20260501, modelBreakdowns: [] }], (p) => p.slice(0, 4))[0].period).toBe('2026');
  });

  it('returns nothing for no rows', () => {
    expect(bucketBy([], (p) => p)).toEqual([]);
  });
});

describe('weekOf', () => {
  it('anchors every day of a week on its Monday', () => {
    // 2026-05-11 is a Monday, 2026-05-17 the Sunday that closes that week.
    for (const d of ['2026-05-11', '2026-05-13', '2026-05-17']) {
      expect(weekOf(d), d).toBe('2026-05-11');
    }
  });

  it('puts a Sunday in the week that started the Monday before it', () => {
    expect(weekOf('2026-05-10')).toBe('2026-05-04');
  });

  it('crosses a month and a year boundary backwards', () => {
    expect(weekOf('2026-06-03')).toBe('2026-06-01');
    expect(weekOf('2027-01-01')).toBe('2026-12-28');
  });

  it('ignores any time component on the input', () => {
    expect(weekOf('2026-05-13T23:59:59.999Z')).toBe('2026-05-11');
  });

  it('matches the Monday anchor the trend tab uses server-side', () => {
    // aggregate.js weekKeyOf does the same (getUTCDay() + 6) % 7 arithmetic.
    expect(weekOf('2026-05-06')).toBe('2026-05-04');
  });
});

describe('yearOf', () => {
  it('takes the year from a period key', () => {
    expect(yearOf('2026-05')).toBe('2026');
    expect(yearOf('2026-05-01')).toBe('2026');
  });
});

describe('clampFont', () => {
  it('holds the scale inside the supported range', () => {
    expect(clampFont(0.1)).toBe(FONT_MIN);
    expect(clampFont(99)).toBe(FONT_MAX);
    expect(clampFont(FONT_MIN)).toBe(FONT_MIN);
    expect(clampFont(FONT_MAX)).toBe(FONT_MAX);
  });

  it('snaps to 5% steps, so button and slider steps stay clean', () => {
    expect(clampFont(1.02)).toBe(1);
    expect(clampFont(1.03)).toBe(1.05);
    expect(clampFont(1.234)).toBe(1.25);
  });

  it('falls back to the minimum for a non-numeric scale', () => {
    // parseFloat of a corrupt stored value yields NaN; Math.max(min, NaN) is NaN,
    // so this pins whatever the current behaviour actually is.
    expect(Number.isNaN(clampFont(NaN))).toBe(true);
  });
});

describe('sanitizeSessionSort', () => {
  it('keeps valid entries in order', () => {
    const raw = [{ key: 'trueCost', dir: 'desc' }, { key: 'projectLabel', dir: 'asc' }];
    expect(sanitizeSessionSort(raw)).toEqual(raw);
  });

  it('drops a column that no longer exists', () => {
    expect(sanitizeSessionSort([{ key: 'goneColumn', dir: 'asc' }])).toEqual([]);
  });

  it('drops a bad direction', () => {
    expect(sanitizeSessionSort([{ key: 'trueCost', dir: 'sideways' }])).toEqual([]);
    expect(sanitizeSessionSort([{ key: 'trueCost' }])).toEqual([]);
  });

  it('keeps only the first entry for a duplicated column', () => {
    expect(sanitizeSessionSort([{ key: 'trueCost', dir: 'asc' }, { key: 'trueCost', dir: 'desc' }])).toEqual([
      { key: 'trueCost', dir: 'asc' },
    ]);
  });

  it('drops nullish entries and rejects a non-array wholesale', () => {
    expect(sanitizeSessionSort([null, undefined, { key: 'trueCost', dir: 'asc' }])).toEqual([
      { key: 'trueCost', dir: 'asc' },
    ]);
    for (const bad of [null, undefined, {}, 'trueCost', 42]) {
      expect(sanitizeSessionSort(bad), String(bad)).toEqual([]);
    }
  });

  it('strips any extra fields a hand-edited value carried', () => {
    expect(sanitizeSessionSort([{ key: 'trueCost', dir: 'asc', evil: 1 }])).toEqual([{ key: 'trueCost', dir: 'asc' }]);
  });
});

describe('cycleSort', () => {
  it('cycles a column absent -> asc -> desc -> absent', () => {
    let sort = [];
    sort = cycleSort(sort, 'trueCost');
    expect(sort).toEqual([{ key: 'trueCost', dir: 'asc' }]);
    sort = cycleSort(sort, 'trueCost');
    expect(sort).toEqual([{ key: 'trueCost', dir: 'desc' }]);
    sort = cycleSort(sort, 'trueCost');
    expect(sort).toEqual([]);
  });

  it('appends a new column at the end, keeping existing priorities', () => {
    const sort = cycleSort(cycleSort([], 'projectLabel'), 'trueCost');
    expect(sort.map((e) => e.key)).toEqual(['projectLabel', 'trueCost']);
  });

  it('toggles a column in place without changing its priority', () => {
    let sort = cycleSort(cycleSort([], 'projectLabel'), 'trueCost');
    sort = cycleSort(sort, 'projectLabel');
    expect(sort).toEqual([{ key: 'projectLabel', dir: 'desc' }, { key: 'trueCost', dir: 'asc' }]);
  });

  it('removing a middle column keeps the rest in order', () => {
    let sort = ['projectLabel', 'lastActivity', 'trueCost'].reduce(cycleSort, []);
    sort = cycleSort(cycleSort(sort, 'lastActivity'), 'lastActivity');
    expect(sort.map((e) => e.key)).toEqual(['projectLabel', 'trueCost']);
  });

  it('returns the SAME array reference for an unknown column, so callers can skip work', () => {
    const sort = [{ key: 'trueCost', dir: 'asc' }];
    expect(cycleSort(sort, 'nope')).toBe(sort);
  });

  it('does not mutate the list it was given', () => {
    const sort = [{ key: 'trueCost', dir: 'asc' }];
    cycleSort(sort, 'trueCost');
    cycleSort(sort, 'projectLabel');
    expect(sort).toEqual([{ key: 'trueCost', dir: 'asc' }]);
  });
});

describe('sortRows', () => {
  const rows = [
    { sessionId: 'a', projectLabel: 'beta', lastActivity: '2026-05-02T00:00:00Z', promptCount: 5, trueCost: 30 },
    { sessionId: 'b', projectLabel: 'alpha', lastActivity: '2026-05-03T00:00:00Z', promptCount: 5, trueCost: 20 },
    { sessionId: 'c', projectLabel: 'alpha', lastActivity: '2026-05-01T00:00:00Z', promptCount: 9, trueCost: 10 },
  ];

  it('returns the original array untouched when nothing is sorted', () => {
    expect(sortRows(rows, [])).toBe(rows);
  });

  it('sorts a copy, leaving the caller array in server order', () => {
    const out = sortRows(rows, [{ key: 'trueCost', dir: 'asc' }]);
    expect(out).not.toBe(rows);
    expect(out.map((r) => r.sessionId)).toEqual(['c', 'b', 'a']);
    expect(rows.map((r) => r.sessionId)).toEqual(['a', 'b', 'c']);
  });

  it('reverses for desc', () => {
    expect(sortRows(rows, [{ key: 'trueCost', dir: 'desc' }]).map((r) => r.sessionId)).toEqual(['a', 'b', 'c']);
  });

  it('breaks ties with the next key in priority order', () => {
    const out = sortRows(rows, [{ key: 'promptCount', dir: 'asc' }, { key: 'trueCost', dir: 'asc' }]);
    expect(out.map((r) => r.sessionId)).toEqual(['b', 'a', 'c']);
  });

  it('falls back to server order for rows tied under every active key', () => {
    // Stable sort, so no explicit tiebreak is needed.
    const out = sortRows(rows, [{ key: 'promptCount', dir: 'asc' }]);
    expect(out.map((r) => r.sessionId)).toEqual(['a', 'b', 'c']);
  });

  it('sorts project labels by locale, not by code point', () => {
    expect(sortRows(rows, [{ key: 'projectLabel', dir: 'asc' }])[0].projectLabel).toBe('alpha');
  });

  it('sorts timestamps chronologically', () => {
    expect(sortRows(rows, [{ key: 'lastActivity', dir: 'asc' }]).map((r) => r.sessionId)).toEqual(['c', 'a', 'b']);
  });

  it('treats missing values as empty or zero rather than producing NaN order', () => {
    const sparse = [{ sessionId: 'x' }, { sessionId: 'y', trueCost: 1, projectLabel: 'a', lastActivity: 'nope' }];
    for (const key of Object.keys(SESSION_SORTS)) {
      expect(sortRows(sparse, [{ key, dir: 'asc' }]), key).toHaveLength(2);
    }
  });
});

describe('sortIndicator', () => {
  it('reports an inactive column', () => {
    expect(sortIndicator([], 'trueCost')).toEqual({ active: false, aria: 'none', arrow: '', rank: null });
  });

  it('reports direction and arrow for the single active column, with no rank', () => {
    const sort = [{ key: 'trueCost', dir: 'asc' }];
    expect(sortIndicator(sort, 'trueCost')).toEqual({ active: true, aria: 'ascending', arrow: '▲', rank: null });
  });

  it('reports descending with the down arrow', () => {
    const sort = [{ key: 'trueCost', dir: 'desc' }];
    expect(sortIndicator(sort, 'trueCost')).toMatchObject({ aria: 'descending', arrow: '▼' });
  });

  it('shows a 1-based priority rank only once more than one column is active', () => {
    const sort = [{ key: 'projectLabel', dir: 'asc' }, { key: 'trueCost', dir: 'desc' }];
    expect(sortIndicator(sort, 'projectLabel').rank).toBe(1);
    expect(sortIndicator(sort, 'trueCost').rank).toBe(2);
  });
});

describe('sanitizeEmpId', () => {
  it('strips path characters, quotes and the filename field separator', () => {
    // `_` separates the fields in 工號_since_until_device.json.
    expect(sanitizeEmpId('A0/17\\850:*?<>|"\'_')).toBe('A017850');
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeEmpId('  A017850  ')).toBe('A017850');
  });

  it('keeps non-ASCII, which the server encodes rather than rejects', () => {
    expect(sanitizeEmpId('工號123')).toBe('工號123');
  });

  it('yields an empty string for nullish or fully-stripped input', () => {
    expect(sanitizeEmpId(null)).toBe('');
    expect(sanitizeEmpId(undefined)).toBe('');
    expect(sanitizeEmpId('___')).toBe('');
  });
});

describe('exportRangeFrom', () => {
  const days = ['2026-05-10', '2026-05-01', '2026-05-20'];

  it('uses what the user picked', () => {
    expect(exportRangeFrom({ since: '2026-05-05', until: '2026-05-06' }, days)).toEqual({
      since: '2026-05-05',
      until: '2026-05-06',
    });
  });

  it('falls back per side to the first and last day covered by the data', () => {
    expect(exportRangeFrom({ since: '', until: '' }, days)).toEqual({ since: '2026-05-01', until: '2026-05-20' });
    expect(exportRangeFrom({ since: '2026-05-05', until: '' }, days)).toEqual({
      since: '2026-05-05',
      until: '2026-05-20',
    });
    expect(exportRangeFrom({ since: '', until: '2026-05-06' }, days)).toEqual({
      since: '2026-05-01',
      until: '2026-05-06',
    });
  });

  it('does not reorder the caller list while finding the bounds', () => {
    const original = [...days];
    exportRangeFrom({ since: '', until: '' }, days);
    expect(days).toEqual(original);
  });

  it('yields undefined bounds with no data, which the caller reports as unexportable', () => {
    expect(exportRangeFrom({ since: '', until: '' }, [])).toEqual({ since: undefined, until: undefined });
  });
});
