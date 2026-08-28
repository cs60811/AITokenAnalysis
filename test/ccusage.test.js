import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CCUSAGE_TIMEOUT_MS = 60_000;
const CCUSAGE_MAX_BUFFER = 1 << 28;
const CCUSAGE_EXPORT_MAX_BUFFER = 1 << 24;

vi.mock('../src/config.js', () => ({
  CCUSAGE_TIMEOUT_MS,
  CCUSAGE_MAX_BUFFER,
  CCUSAGE_EXPORT_MAX_BUFFER,
  IS_DESKTOP: false,
}));

/** Captured execFile calls, and what the next one should do. */
const calls = [];
let behaviour = { stdout: '{}' };

vi.mock('node:child_process', () => ({
  execFile: (cmd, args, opts, cb) => {
    calls.push({ cmd, args, opts });
    const b = typeof behaviour === 'function' ? behaviour(calls.length) : behaviour;
    setImmediate(() => cb(b.err ?? null, b.stdout ?? '', b.stderr ?? ''));
  },
  spawn: vi.fn(),
}));

const {
  CcusageError,
  daily,
  exportClaudeDaily,
  modelTotalsFromDaily,
  monthly,
  sessions,
  version,
} = await import('../src/ccusage.js');

beforeEach(() => {
  calls.length = 0;
  behaviour = { stdout: '{}' };
});

afterEach(() => vi.restoreAllMocks());

const lastArgs = () => calls.at(-1).args;
/** ccusage's own args, with the resolver's leading cli.js path (if any) dropped. */
const ccusageArgs = () => {
  const args = lastArgs();
  return args[0]?.endsWith('.js') || args[0]?.endsWith('.mjs') ? args.slice(1) : args;
};

describe('spawn safety', () => {
  it('never uses a shell, and always hides the window with a timeout', async () => {
    await daily();
    // shell:true would trigger Node's DEP0190 and open a command-injection path
    // for the date arguments.
    expect(calls[0].opts).toMatchObject({
      shell: false,
      windowsHide: true,
      timeout: CCUSAGE_TIMEOUT_MS,
      maxBuffer: CCUSAGE_MAX_BUFFER,
    });
  });

  it('passes arguments as an array, never as a joined string', async () => {
    await daily({ since: '2026-05-01' });
    expect(Array.isArray(lastArgs())).toBe(true);
    expect(lastArgs().every((a) => typeof a === 'string')).toBe(true);
  });
});

describe('date arguments', () => {
  it('converts the UI YYYY-MM-DD form to the compact form ccusage wants', async () => {
    await daily({ since: '2026-05-01', until: '2026-05-31' });
    expect(ccusageArgs()).toEqual(['daily', '--since', '20260501', '--until', '20260531', '--json']);
  });

  it('omits any bound that was not given', async () => {
    await daily({});
    expect(ccusageArgs()).toEqual(['daily', '--json']);
    await daily({ since: '2026-05-01' });
    expect(ccusageArgs()).toEqual(['daily', '--since', '20260501', '--json']);
    await daily({ until: '2026-05-31' });
    expect(ccusageArgs()).toEqual(['daily', '--until', '20260531', '--json']);
  });

  it('passes a timezone through when given', async () => {
    await daily({ timezone: 'Asia/Taipei' });
    expect(ccusageArgs()).toEqual(['daily', '--timezone', 'Asia/Taipei', '--json']);
  });

  it('accepts the compact form unchanged', async () => {
    await daily({ since: '20260501' });
    expect(ccusageArgs()).toContain('20260501');
  });

  it('never passes --offline, which prices unknown models at $0', async () => {
    await daily({ since: '2026-05-01' });
    expect(lastArgs()).not.toContain('--offline');
    expect(lastArgs()).not.toContain('-O');
  });
});

describe('subcommands', () => {
  it('maps each exported reader to its ccusage subcommand', async () => {
    await daily();
    expect(ccusageArgs()[0]).toBe('daily');
    await monthly();
    expect(ccusageArgs()[0]).toBe('monthly');
    await sessions();
    expect(ccusageArgs()[0]).toBe('session');
  });

  it('asks for the version without --json and trims the answer', async () => {
    behaviour = { stdout: '  20.0.17\n' };
    expect(await version()).toBe('20.0.17');
    expect(lastArgs()).not.toContain('--json');
  });
});

describe('error mapping', () => {
  it('maps ENOENT to a not_found error', async () => {
    behaviour = { err: Object.assign(new Error('spawn failed'), { code: 'ENOENT' }) };
    await expect(daily()).rejects.toMatchObject({ name: 'CcusageError', kind: 'not_found' });
  });

  it('maps a killed process to a timeout error naming the limit', async () => {
    behaviour = { err: Object.assign(new Error('killed'), { killed: true }) };
    await expect(daily()).rejects.toMatchObject({ kind: 'timeout' });
    behaviour = { err: Object.assign(new Error('term'), { signal: 'SIGTERM' }) };
    await expect(daily()).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('maps a non-zero exit to an exit error carrying stderr as detail', async () => {
    behaviour = { err: Object.assign(new Error('bad'), { code: 2 }), stderr: 'usage: ccusage' };
    await expect(daily()).rejects.toMatchObject({ kind: 'exit', detail: 'usage: ccusage' });
  });

  it('falls back to the error message when stderr is empty', async () => {
    behaviour = { err: Object.assign(new Error('inner detail'), { code: 2 }), stderr: '' };
    await expect(daily()).rejects.toMatchObject({ kind: 'exit', detail: 'inner detail' });
  });

  it('maps unparsable output to a parse error, keeping a bounded excerpt', async () => {
    behaviour = { stdout: 'x'.repeat(1000) };
    await expect(daily()).rejects.toMatchObject({ kind: 'parse' });
    await daily().catch((e) => expect(e.detail).toHaveLength(500));
  });

  it('is an Error subclass, so it survives normal error handling', async () => {
    behaviour = { stdout: 'not json' };
    const err = await daily().catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CcusageError);
  });
});

describe('exportClaudeDaily', () => {
  it('returns raw stdout, unparsed, so the download is byte-for-byte ccusage output', async () => {
    behaviour = { stdout: '{ "daily": [] }\n' };
    expect(await exportClaudeDaily({ since: '2026-05-01', until: '2026-05-31' })).toBe('{ "daily": [] }\n');
  });

  it('asks for the claude-only calculate-mode breakdown', async () => {
    await exportClaudeDaily({ since: '2026-05-01', until: '2026-05-31' });
    expect(ccusageArgs()).toEqual([
      'claude',
      'daily',
      '--since',
      '20260501',
      '--until',
      '20260531',
      '--mode',
      'calculate',
      '--breakdown',
      '--json',
    ]);
  });

  it('uses the smaller export buffer, not the 256 MB general ceiling', async () => {
    await exportClaudeDaily({ since: '2026-05-01', until: '2026-05-31' });
    expect(calls.at(-1).opts.maxBuffer).toBe(CCUSAGE_EXPORT_MAX_BUFFER);
  });

  it('dedups concurrent requests for the same range into one process', async () => {
    let release;
    behaviour = { stdout: 'ok' };
    const range = { since: '2026-05-01', until: '2026-05-31' };
    const before = calls.length;
    const [a, b] = await Promise.all([exportClaudeDaily(range), exportClaudeDaily(range)]);
    expect(a).toBe(b);
    expect(calls.length - before).toBe(1);
    void release;
  });

  it('does not dedup across different ranges', async () => {
    const before = calls.length;
    await Promise.all([
      exportClaudeDaily({ since: '2026-05-01', until: '2026-05-31' }),
      exportClaudeDaily({ since: '2026-06-01', until: '2026-06-30' }),
    ]);
    expect(calls.length - before).toBe(2);
  });

  it('releases the dedup slot after a failure, so a retry re-runs', async () => {
    const range = { since: '2026-05-01', until: '2026-05-31' };
    behaviour = { err: Object.assign(new Error('boom'), { code: 2 }) };
    await expect(exportClaudeDaily(range)).rejects.toThrow();
    behaviour = { stdout: 'second try' };
    expect(await exportClaudeDaily(range)).toBe('second try');
  });
});

describe('modelTotalsFromDaily', () => {
  const bd = (modelName, over = {}) => ({
    modelName,
    cost: 1,
    inputTokens: 10,
    outputTokens: 20,
    cacheCreationTokens: 30,
    cacheReadTokens: 40,
    ...over,
  });

  it('flattens per-day breakdowns into per-model totals', () => {
    const doc = {
      daily: [
        { modelBreakdowns: [bd('claude-opus-5'), bd('gpt-5.5')] },
        { modelBreakdowns: [bd('claude-opus-5')] },
      ],
    };
    const r = modelTotalsFromDaily(doc);
    const opus = r.models.find((m) => m.model === 'claude-opus-5');
    expect(opus).toEqual({ model: 'claude-opus-5', cost: 2, input: 20, output: 40, cacheWrite: 60, cacheRead: 80 });
  });

  it('splits claude cost from every other agent', () => {
    const doc = {
      daily: [{ modelBreakdowns: [bd('claude-opus-5', { cost: 7 }), bd('gemini-2.5-pro', { cost: 2 }), bd('gpt-5.5', { cost: 1 })] }],
    };
    const r = modelTotalsFromDaily(doc);
    expect(r.claudeCost).toBe(7);
    expect(r.otherCost).toBe(3);
    expect(r.totalCost).toBe(10);
  });

  it('sorts models by cost, descending', () => {
    const doc = { daily: [{ modelBreakdowns: [bd('a', { cost: 1 }), bd('b', { cost: 9 }), bd('c', { cost: 5 })] }] };
    expect(modelTotalsFromDaily(doc).models.map((m) => m.model)).toEqual(['b', 'c', 'a']);
  });

  it('treats missing numeric fields as zero rather than NaN', () => {
    const r = modelTotalsFromDaily({ daily: [{ modelBreakdowns: [{ modelName: 'sparse' }] }] });
    expect(r.models[0]).toEqual({ model: 'sparse', cost: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
    expect(r.totalCost).toBe(0);
  });

  it('handles an empty document and a day with no breakdowns', () => {
    for (const doc of [{}, { daily: [] }, { daily: [{}] }]) {
      expect(modelTotalsFromDaily(doc)).toEqual({ models: [], claudeCost: 0, otherCost: 0, totalCost: 0 });
    }
  });

  it('uses our internal token names, not ccusage wire names', () => {
    // aggregate.js and the overview card read cacheWrite/cacheRead; the wire
    // names (cacheCreationTokens/cacheReadTokens) stop here.
    const r = modelTotalsFromDaily({ daily: [{ modelBreakdowns: [bd('m')] }] });
    expect(Object.keys(r.models[0]).sort()).toEqual([
      'cacheRead',
      'cacheWrite',
      'cost',
      'input',
      'model',
      'output',
    ]);
  });
});
