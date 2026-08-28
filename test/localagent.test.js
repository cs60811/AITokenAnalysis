import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'prices.fixture.json');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aita-local-'));
const AGENT_ROOT = path.join(TMP, 'local-agent-mode-sessions');

vi.mock('../src/config.js', () => ({
  CACHE_DIR: TMP,
  PRICES_CACHE_FILE: path.join(TMP, 'prices-cache.json'),
  PRICES_SNAPSHOT_FILE: FIXTURE,
  LITELLM_PRICES_URL: 'https://litellm.test/prices.json',
  MODELSDEV_PRICES_URL: 'https://models.test/api.json',
  LITELLM_TIMEOUT_MS: 5000,
  PRICES_STALE_DAYS: 30,
  SNIPPET_CHARS: 120,
  LOCAL_AGENT_DIR: AGENT_ROOT,
}));

const { localAgentDetail, localAgentSpend } = await import('../src/localagent.js');
const { loadSnapshotSync } = await import('../src/pricing.js');

const COST_PER_INPUT_TOKEN = 1e-5;
const dollars = (n) => n * COST_PER_INPUT_TOKEN;
const MANUAL = '（手動執行）';

beforeEach(() => {
  loadSnapshotSync();
  fs.rmSync(AGENT_ROOT, { recursive: true, force: true });
});

/* ── fixture builders ─────────────────────────────────────────────────────── */

const write = (file, lines) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'));
};

const asst = (id, input, ts = '2026-05-01T00:00:00.000Z', model = 'test-opus') => ({
  type: 'assistant',
  uuid: `u-${id}`,
  timestamp: ts,
  message: { id, model, usage: { input_tokens: input } },
});

const userLine = (text) => ({ type: 'user', uuid: `u-${text.length}`, message: { content: text } });

/**
 * One local-agent run at the layout this module reads:
 *   <root>/<workspace>/<conversation>/local_<id>/audit.jsonl
 *   <root>/<workspace>/<conversation>/local_<id>/.claude/projects/<enc>/<sid>.jsonl
 */
const run = (id, { audit = [], nested = null, workspace = 'ws1', conversation = 'conv1' } = {}) => {
  const base = path.join(AGENT_ROOT, workspace, conversation, `local_${id}`);
  if (audit.length) write(path.join(base, 'audit.jsonl'), audit);
  if (nested) write(path.join(base, '.claude', 'projects', 'enc-cwd', 'sid.jsonl'), nested);
  return base;
};

/* ── tests ────────────────────────────────────────────────────────────────── */

describe('localAgentSpend — availability', () => {
  it('reports unavailable, not an error, when the root does not exist', () => {
    const r = localAgentSpend();
    expect(r.available).toBe(false);
    expect(r.error).toBeNull();
    expect(r.cost).toBe(0);
    expect(r.dataDir).toBe(AGENT_ROOT);
    expect(r.scan.rootEntries).toBe(0);
  });

  it('reports unavailable when the root exists but holds no runs', () => {
    fs.mkdirSync(path.join(AGENT_ROOT, 'ws1', 'conv1'), { recursive: true });
    expect(localAgentSpend().available).toBe(false);
  });

  it('ignores a directory that is not named local_*', () => {
    write(path.join(AGENT_ROOT, 'ws1', 'conv1', 'notarun', 'audit.jsonl'), [asst('m1', 1000)]);
    expect(localAgentSpend().available).toBe(false);
  });

  it('surfaces a scan failure as an error rather than as "no data"', () => {
    run('a', { audit: [asst('m1', 1000)] });
    // A permission-class failure must not read as an empty machine: the card
    // would vanish and take the explanation with it.
    const spy = vi.spyOn(fs, 'readdirSync').mockImplementation(() => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    });
    const r = localAgentSpend();
    spy.mockRestore();

    expect(r.available).toBe(false);
    expect(r.error).toMatch(/EACCES/);
    expect(r.cost).toBe(0);
  });

  it('still reports a detail payload shape on a scan failure', () => {
    run('a', { audit: [asst('m1', 1000)] });
    const spy = vi.spyOn(fs, 'readdirSync').mockImplementation(() => {
      throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' });
    });
    const r = localAgentDetail();
    spy.mockRestore();

    expect(r.available).toBe(false);
    expect(r.error).toMatch(/EACCES/);
    expect(r.runs).toEqual([]);
    expect(r.byTask).toEqual([]);
  });
});

describe('localAgentSpend — costing', () => {
  it('costs a single run from its audit transcript', () => {
    run('a', { audit: [asst('m1', 1000), asst('m2', 500)] });
    const r = localAgentSpend();
    expect(r.available).toBe(true);
    expect(r.cost).toBeCloseTo(dollars(1500), 12);
    expect(r.runs).toBe(1);
    expect(r.tokens).toBe(1500);
  });

  it('counts a message recorded in both copies once, at the larger cost', () => {
    // Both copies are written while the response streams; the complete one is
    // the one that was billed. Keyed on message.id, because the audit copy
    // carries no requestId.
    run('a', {
      audit: [asst('m1', 100)],
      nested: [asst('m1', 900)],
    });
    const r = localAgentSpend();
    expect(r.cost).toBeCloseTo(dollars(900), 12);
    expect(r.tokens).toBe(900);
  });

  it('is order-independent about which copy is larger', () => {
    run('a', { audit: [asst('m1', 900)], nested: [asst('m1', 100)] });
    expect(localAgentSpend().cost).toBeCloseTo(dollars(900), 12);
  });

  it('skips a model with no rates rather than costing it zero silently', () => {
    run('a', { audit: [asst('m1', 1000, '2026-05-01T00:00:00.000Z', 'ghost-model')] });
    const r = localAgentSpend();
    expect(r.available).toBe(true);
    expect(r.cost).toBe(0);
  });

  it('reports what the scan actually saw, so failure modes stay distinguishable', () => {
    run('a', { audit: [asst('m1', 1000)], nested: [asst('m2', 10)] });
    const r = localAgentSpend();
    expect(r.scan).toMatchObject({ rootEntries: 1, files: 2, filesRead: 2, billableLines: 2 });
    expect(r.scan.readErrors).toEqual([]);
  });

  it('reports read errors in its own collector, not the transcript analysis one', async () => {
    const { getReadErrors, resetReadErrors } = await import('../src/parser.js');
    resetReadErrors();
    const base = run('a', { audit: [asst('m1', 100)] });
    // A directory where a .jsonl is expected fails to read as a file.
    fs.mkdirSync(path.join(base, '.claude', 'projects', 'enc', 'bad.jsonl'), { recursive: true });

    const r = localAgentSpend();
    expect(r.scan.readErrors).toHaveLength(1);
    expect(getReadErrors()).toEqual([]);
  });
});

describe('localAgentSpend — range filtering', () => {
  const threeDays = () => {
    run('may01', { audit: [asst('m1', 100, '2026-05-01T10:00:00.000Z')] });
    run('may10', { audit: [asst('m2', 200, '2026-05-10T10:00:00.000Z')] });
    run('may20', { audit: [asst('m3', 400, '2026-05-20T10:00:00.000Z')] });
  };

  it('filters runs by day, inclusively at both ends', () => {
    threeDays();
    expect(localAgentSpend({ since: '2026-05-10', until: '2026-05-10' }).runs).toBe(1);
    expect(localAgentSpend({ since: '2026-05-10' }).runs).toBe(2);
    expect(localAgentSpend({ until: '2026-05-10' }).runs).toBe(2);
    expect(localAgentSpend().runs).toBe(3);
  });

  it('reports the unfiltered total alongside the filtered one', () => {
    threeDays();
    const r = localAgentSpend({ since: '2026-06-01' });
    expect(r.runs).toBe(0);
    expect(r.cost).toBe(0);
    expect(r.totalRuns).toBe(3);
    expect(r.totalCost).toBeCloseTo(dollars(700), 12);
    // So an empty range can point at where the data actually is.
    expect(r.firstDay).toBe('2026-05-01');
    expect(r.lastDay).toBe('2026-05-20');
  });
});

describe('localAgentDetail', () => {
  it('names an automated run from its scheduled-task envelope', () => {
    run('a', { audit: [userLine('<scheduled-task name="nightly report" cron="0 3 * * *">go'), asst('m1', 1000)] });
    const r = localAgentDetail();
    expect(r.runs[0]).toMatchObject({ task: 'nightly report', scheduled: true });
  });

  it('labels a run with no task envelope as manual', () => {
    run('a', { audit: [userLine('just do this by hand'), asst('m1', 1000)] });
    const r = localAgentDetail();
    expect(r.runs[0]).toMatchObject({ task: MANUAL, scheduled: false, prompt: 'just do this by hand' });
  });

  it('collapses whitespace and truncates the recorded prompt', () => {
    run('a', { audit: [userLine(`x\n\ny   ${'z'.repeat(200)}`), asst('m1', 100)] });
    expect(localAgentDetail().runs[0].prompt).toHaveLength(90);
    expect(localAgentDetail().runs[0].prompt.startsWith('x y z')).toBe(true);
  });

  it('ignores meta and sidechain user lines when naming a run', () => {
    run('a', {
      audit: [
        { type: 'user', uuid: 'u1', isMeta: true, message: { content: '<scheduled-task name="wrong">' } },
        { type: 'user', uuid: 'u2', isSidechain: true, message: { content: 'wrong too' } },
        userLine('the real prompt'),
        asst('m1', 100),
      ],
    });
    expect(localAgentDetail().runs[0]).toMatchObject({ task: MANUAL, prompt: 'the real prompt' });
  });

  it('lists newest run first and records each run models', () => {
    run('old', { audit: [asst('m1', 100, '2026-05-01T00:00:00.000Z')] });
    run('new', {
      audit: [
        asst('m2', 100, '2026-05-09T00:00:00.000Z'),
        asst('m3', 100, '2026-05-09T00:01:00.000Z', 'test-no1h'),
      ],
    });
    const r = localAgentDetail();
    expect(r.runs.map((x) => x.id)).toEqual(['local_new', 'local_old']);
    expect(r.runs[0].models).toEqual(['test-no1h', 'test-opus']);
  });

  it('groups runs by task, with an average and the last run time', () => {
    const task = (id, ts, input) =>
      run(id, { audit: [userLine('<scheduled-task name="daily digest">go'), asst(`m-${id}`, input, ts)] });
    task('r1', '2026-05-01T00:00:00.000Z', 1000);
    task('r2', '2026-05-03T00:00:00.000Z', 3000);
    run('manual', { audit: [userLine('by hand'), asst('m-manual', 500, '2026-05-02T00:00:00.000Z')] });

    const r = localAgentDetail();
    expect(r.byTask.map((t) => t.task)).toEqual(['daily digest', MANUAL]);
    const digest = r.byTask[0];
    expect(digest).toMatchObject({ runs: 2, scheduled: true, lastRun: '2026-05-03T00:00:00.000Z' });
    expect(digest.cost).toBeCloseTo(dollars(4000), 12);
    expect(digest.avgCost).toBeCloseTo(dollars(2000), 12);
    expect(digest.models).toEqual(['test-opus']);
  });

  it('sorts task groups by cost, descending', () => {
    run('cheap', { audit: [userLine('<scheduled-task name="cheap">go'), asst('m1', 100)] });
    run('dear', { audit: [userLine('<scheduled-task name="dear">go'), asst('m2', 9000)] });
    expect(localAgentDetail().byTask.map((t) => t.task)).toEqual(['dear', 'cheap']);
  });

  it('applies the same range filter to runs as to the rollup', () => {
    run('in', { audit: [asst('m1', 100, '2026-05-10T00:00:00.000Z')] });
    run('out', { audit: [asst('m2', 100, '2026-06-10T00:00:00.000Z')] });
    const r = localAgentDetail({ since: '2026-05-01', until: '2026-05-31' });
    expect(r.runs.map((x) => x.id)).toEqual(['local_in']);
    expect(r.byTask[0].runs).toBe(1);
  });

  it('returns an unavailable payload with empty lists when there are no runs', () => {
    const r = localAgentDetail();
    expect(r).toMatchObject({ available: false, runs: [], byTask: [] });
  });

  it('walks every workspace and conversation under the root', () => {
    run('a', { audit: [asst('m1', 100)], workspace: 'ws1', conversation: 'c1' });
    run('b', { audit: [asst('m2', 100)], workspace: 'ws1', conversation: 'c2' });
    run('c', { audit: [asst('m3', 100)], workspace: 'ws2', conversation: 'c1' });
    const r = localAgentDetail();
    expect(r.runs).toHaveLength(3);
    expect(r.scan.rootEntries).toBe(2);
  });
});

describe('memoization', () => {
  it('serves an unchanged corpus from the memo, carrying the scan counts forward', () => {
    run('a', { audit: [asst('m1', 1000)] });
    const first = localAgentSpend();
    const second = localAgentSpend();
    expect(second.cost).toBeCloseTo(first.cost, 12);
    // A healthy memo hit must not report "files found, none read".
    expect(second.scan).toMatchObject({ files: 1, filesRead: 1, billableLines: 1 });
  });

  it('re-parses once a transcript changes', () => {
    const base = run('a', { audit: [asst('m1', 1000)] });
    expect(localAgentSpend().cost).toBeCloseTo(dollars(1000), 12);

    write(path.join(base, 'audit.jsonl'), [asst('m1', 1000), asst('m2', 2000)]);
    expect(localAgentSpend().cost).toBeCloseTo(dollars(3000), 12);
  });

  it('re-parses once a run is added', () => {
    run('a', { audit: [asst('m1', 1000)] });
    expect(localAgentSpend().runs).toBe(1);
    run('b', { audit: [asst('m2', 1000)] });
    expect(localAgentSpend().runs).toBe(2);
  });
});
