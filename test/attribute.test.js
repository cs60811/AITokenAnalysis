import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'prices.fixture.json');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aita-attr-'));

// 與 pricing 測試使用同一份費率表：歸因關心的是「一塊錢落在哪個 turn」，
// 所以金額只要可預測就好，不需要是真實數字。
vi.mock('../src/config.js', () => ({
  CACHE_DIR: TMP,
  PRICES_CACHE_FILE: path.join(TMP, 'prices-cache.json'),
  PRICES_SNAPSHOT_FILE: FIXTURE,
  LITELLM_PRICES_URL: 'https://litellm.test/prices.json',
  MODELSDEV_PRICES_URL: 'https://models.test/api.json',
  LITELLM_TIMEOUT_MS: 5000,
  PRICES_STALE_DAYS: 30,
  SNIPPET_CHARS: 120,
  CLAUDE_PROJECTS_DIR: path.join(TMP, 'projects'),
}));

const { analyzeAll, analyzeSession, UNATTRIBUTED } = await import('../src/attribute.js');
const { loadSnapshotSync } = await import('../src/pricing.js');
const { resetReadErrors } = await import('../src/parser.js');

beforeEach(() => {
  loadSnapshotSync();
  resetReadErrors();
});

/* ── 測試資料建構器 ───────────────────────────────────────────────────────── */

let seq = 0;
const dir = () => fs.mkdtempSync(path.join(TMP, `s${seq++}-`));

const jsonl = (file, lines) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'));
  return file;
};

/** 一行 assistant 記錄，在 test-opus 上的成本剛好是 `input` * 1e-5。 */
const asst = (uuid, parentUuid, input, over = {}) => ({
  type: 'assistant',
  uuid,
  parentUuid,
  requestId: `req-${uuid}`,
  timestamp: '2026-05-01T00:00:00.000Z',
  message: { id: `msg-${uuid}`, model: 'test-opus', usage: { input_tokens: input }, ...over.message },
  ...over,
});

const prompt = (uuid, text, over = {}) => ({
  type: 'user',
  uuid,
  parentUuid: null,
  timestamp: '2026-05-01T00:00:00.000Z',
  cwd: 'C:\\work\\myproj',
  gitBranch: 'main',
  message: { content: text },
  ...over,
});

/** 一筆 session 記錄，形狀與 discoverSessions() 產出的完全相同。 */
const session = (over = {}) => ({
  sessionId: 'sid-1',
  projectDir: 'proj',
  projectLabel: 'proj',
  main: null,
  subagents: [],
  workflows: new Map(),
  ...over,
});

const COST_PER_INPUT_TOKEN = 1e-5;
const dollars = (inputTokens) => inputTokens * COST_PER_INPUT_TOKEN;

const turnOf = (result, promptId) => result.turns.find((t) => t.promptId === promptId);

/* ── tests ────────────────────────────────────────────────────────────────── */

describe('analyzeSession — main transcript attribution', () => {
  it('charges an assistant message to the prompt it descends from', () => {
    const d = dir();
    const main = jsonl(path.join(d, 'sid-1.jsonl'), [
      prompt('p1', 'first prompt'),
      asst('a1', 'p1', 1000),
      asst('a2', 'a1', 2000),
      prompt('p2', 'second prompt'),
      asst('a3', 'p2', 500),
    ]);
    const r = analyzeSession(session({ main }));

    expect(turnOf(r, 'p1').ownCost).toBeCloseTo(dollars(3000), 12);
    expect(turnOf(r, 'p2').ownCost).toBeCloseTo(dollars(500), 12);
    expect(r.ownCost).toBeCloseTo(dollars(3500), 12);
    expect(r.promptCount).toBe(2);
  });

  it('walks a long parentUuid chain up to the owning prompt', () => {
    const d = dir();
    const lines = [prompt('p1', 'deep')];
    for (let i = 0; i < 30; i++) lines.push(asst(`a${i}`, i === 0 ? 'p1' : `a${i - 1}`, 100));
    const r = analyzeSession(session({ main: jsonl(path.join(d, 'sid-1.jsonl'), lines) }));
    expect(turnOf(r, 'p1').ownCost).toBeCloseTo(dollars(3000), 12);
  });

  it('sends cost with no reachable prompt to the UNATTRIBUTED bucket', () => {
    const d = dir();
    const main = jsonl(path.join(d, 'sid-1.jsonl'), [asst('a1', 'ghost-parent', 1000)]);
    const r = analyzeSession(session({ main }));
    expect(turnOf(r, UNATTRIBUTED).ownCost).toBeCloseTo(dollars(1000), 12);
  });

  it('drops the UNATTRIBUTED row entirely when it carries no cost and no tokens', () => {
    const d = dir();
    const main = jsonl(path.join(d, 'sid-1.jsonl'), [prompt('p1', 'x'), asst('a1', 'p1', 100)]);
    const r = analyzeSession(session({ main }));
    expect(turnOf(r, UNATTRIBUTED)).toBeUndefined();
    expect(r.turns).toHaveLength(1);
  });

  it('does NOT open a turn for a machine-generated user line', () => {
    const d = dir();
    const main = jsonl(path.join(d, 'sid-1.jsonl'), [
      prompt('p1', 'real prompt'),
      prompt('n1', '<system-reminder>noise</system-reminder>', { parentUuid: 'p1' }),
      asst('a1', 'n1', 1000),
    ]);
    const r = analyzeSession(session({ main }));
    expect(r.promptCount).toBe(1);
    expect(turnOf(r, 'p1').ownCost).toBeCloseTo(dollars(1000), 12);
  });

  it('counts a streamed message once, at its final usage', () => {
    const d = dir();
    const streamed = (out) => ({
      type: 'assistant',
      uuid: 'a1',
      parentUuid: 'p1',
      requestId: 'r1',
      message: { id: 'm1', model: 'test-opus', usage: { input_tokens: 100, output_tokens: out } },
    });
    const main = jsonl(path.join(d, 'sid-1.jsonl'), [prompt('p1', 'x'), streamed(3), streamed(3), streamed(276)]);
    const r = analyzeSession(session({ main }));
    expect(turnOf(r, 'p1').tokens.output).toBe(276);
    expect(turnOf(r, 'p1').tokens.input).toBe(100);
  });

  it('records an unpriced model instead of silently costing it zero', () => {
    const d = dir();
    const main = jsonl(path.join(d, 'sid-1.jsonl'), [
      prompt('p1', 'x'),
      asst('a1', 'p1', 1000, { message: { id: 'm1', model: 'ghost-model', usage: { input_tokens: 1000 } } }),
    ]);
    const r = analyzeSession(session({ main }));
    expect(r.unpricedModels).toEqual(['ghost-model']);
    expect(r.ownCost).toBe(0);
    expect(r.tokens.input).toBe(1000); // token 仍然有被計算
  });

  it('bills an advisor iteration as its own byModel row', () => {
    const d = dir();
    const main = jsonl(path.join(d, 'sid-1.jsonl'), [
      prompt('p1', 'x'),
      asst('a1', 'p1', 1000, {
        message: {
          id: 'm1',
          model: 'test-opus',
          usage: { input_tokens: 1000, iterations: [{ type: 'advisor_message', model: 'test-no1h', input_tokens: 400 }] },
        },
      }),
    ]);
    const r = analyzeSession(session({ main }));
    expect(r.ownCost).toBeCloseTo(dollars(1400), 12);
    expect(r.byModel.map((m) => m.model).sort()).toEqual(['test-no1h', 'test-opus']);
  });

  it('sorts byModel by cost, descending', () => {
    const d = dir();
    const main = jsonl(path.join(d, 'sid-1.jsonl'), [
      prompt('p1', 'x'),
      asst('a1', 'p1', 100, { message: { id: 'm1', model: 'test-no1h', usage: { input_tokens: 100 } } }),
      asst('a2', 'a1', 900, { message: { id: 'm2', model: 'test-opus', usage: { input_tokens: 900 } } }),
    ]);
    const r = analyzeSession(session({ main }));
    expect(r.byModel[0].model).toBe('test-opus');
  });
});

describe('analyzeSession — session metadata', () => {
  it('takes projectLabel from the basename of cwd, overriding the dir-name guess', () => {
    const d = dir();
    const main = jsonl(path.join(d, 'sid-1.jsonl'), [prompt('p1', 'x'), asst('a1', 'p1', 100)]);
    const r = analyzeSession(session({ main, projectLabel: 'guessed' }));
    expect(r.projectLabel).toBe('myproj');
    expect(r.projectPath).toBe('C:\\work\\myproj');
    expect(r.gitBranch).toBe('main');
  });

  it('falls back to the discovered label when no line carries a cwd', () => {
    const d = dir();
    const main = jsonl(path.join(d, 'sid-1.jsonl'), [
      prompt('p1', 'x', { cwd: undefined, gitBranch: undefined }),
      asst('a1', 'p1', 100),
    ]);
    const r = analyzeSession(session({ main, projectLabel: 'fallback-label' }));
    expect(r.projectLabel).toBe('fallback-label');
    expect(r.projectPath).toBeNull();
  });

  it('reports lastActivity as the newest timestamp on any line', () => {
    const d = dir();
    const main = jsonl(path.join(d, 'sid-1.jsonl'), [
      prompt('p1', 'x', { timestamp: '2026-05-01T00:00:00.000Z' }),
      asst('a1', 'p1', 100, { timestamp: '2026-05-09T10:00:00.000Z' }),
      asst('a2', 'a1', 100, { timestamp: '2026-05-03T00:00:00.000Z' }),
    ]);
    expect(analyzeSession(session({ main })).lastActivity).toBe('2026-05-09T10:00:00.000Z');
  });

  it('handles a session with no main transcript at all', () => {
    const r = analyzeSession(session({ main: null }));
    expect(r.promptCount).toBe(0);
    expect(r.trueCost).toBe(0);
    expect(r.lastActivity).toBeNull();
    expect(r.turns).toEqual([]);
  });

  it('totals tokens across all five classes', () => {
    const d = dir();
    const main = jsonl(path.join(d, 'sid-1.jsonl'), [
      prompt('p1', 'x'),
      asst('a1', 'p1', 0, {
        message: {
          id: 'm1',
          model: 'test-opus',
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            cache_read_input_tokens: 8,
            cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 16 },
          },
        },
      }),
    ]);
    const r = analyzeSession(session({ main }));
    expect(r.tokens).toEqual({ input: 1, output: 2, cacheWrite5m: 4, cacheWrite1h: 16, cacheRead: 8 });
    expect(r.totalTokens).toBe(31);
  });
});

describe('analyzeSession — the three cost tiers', () => {
  const withAgent = (agentId, agentInput, { link = 'agentId' } = {}) => {
    const d = dir();
    const main = jsonl(path.join(d, 'sid-1.jsonl'), [
      prompt('p1', 'spawn an agent'),
      { type: 'user', uuid: 'tr1', parentUuid: 'p1', message: { content: [{ type: 'tool_result' }] }, toolUseResult: { [link]: agentId } },
    ]);
    const agentFile = jsonl(path.join(d, 'subagents', `agent-${agentId}.jsonl`), [
      asst('b1', null, agentInput, { message: { id: `am-${agentId}`, model: 'test-opus', usage: { input_tokens: agentInput } } }),
    ]);
    return { main, agentFile, d };
  };

  it('rolls a subagent file up into the turn that spawned it, as subagentCost', () => {
    const { main, agentFile } = withAgent('ag1', 5000);
    const r = analyzeSession(session({ main, subagents: [agentFile] }));
    expect(turnOf(r, 'p1').subagentCost).toBeCloseTo(dollars(5000), 12);
    expect(turnOf(r, 'p1').workflowCost).toBe(0);
    expect(r.subagentCost).toBeCloseTo(dollars(5000), 12);
  });

  it('keeps workflow cost in its own tier — the one ccusage session drops', () => {
    const { main, agentFile } = withAgent('run-9', 7000, { link: 'runId' });
    const r = analyzeSession(session({ main, workflows: new Map([['run-9', [agentFile]]]) }));
    expect(turnOf(r, 'p1').workflowCost).toBeCloseTo(dollars(7000), 12);
    expect(r.workflowCost).toBeCloseTo(dollars(7000), 12);
    expect(r.ccusageCost).toBe(0); // ccusage 只算 main + subagent
    expect(r.trueCost).toBeCloseTo(dollars(7000), 12);
    expect(r.workflowRunCount).toBe(1);
  });

  it('defines ccusageCost as own+subagent and trueCost as that plus workflow', () => {
    const d = dir();
    const main = jsonl(path.join(d, 'sid-1.jsonl'), [
      prompt('p1', 'x'),
      { type: 'user', uuid: 't1', parentUuid: 'p1', message: { content: [{ type: 'tool_result' }] }, toolUseResult: { agentId: 'ag1', runId: 'run-1' } },
      asst('a1', 'p1', 1000),
    ]);
    const sub = jsonl(path.join(d, 'subagents', 'agent-ag1.jsonl'), [
      asst('b1', null, 2000, { message: { id: 'bm1', model: 'test-opus', usage: { input_tokens: 2000 } } }),
    ]);
    const wf = jsonl(path.join(d, 'wf', 'agent-1.jsonl'), [
      asst('c1', null, 4000, { message: { id: 'cm1', model: 'test-opus', usage: { input_tokens: 4000 } } }),
    ]);
    const r = analyzeSession(session({ main, subagents: [sub], workflows: new Map([['run-1', [wf]]]) }));

    expect(r.ownCost).toBeCloseTo(dollars(1000), 12);
    expect(r.subagentCost).toBeCloseTo(dollars(2000), 12);
    expect(r.workflowCost).toBeCloseTo(dollars(4000), 12);
    expect(r.ccusageCost).toBeCloseTo(dollars(3000), 12);
    expect(r.trueCost).toBeCloseTo(dollars(7000), 12);
  });

  it('recovers an unlinked agent through its <task-id> notification', () => {
    const d = dir();
    const main = jsonl(path.join(d, 'sid-1.jsonl'), [
      prompt('p1', 'background task'),
      {
        type: 'user',
        uuid: 'n1',
        parentUuid: 'p1',
        message: { content: '<task-notification><task-id>ag-bg</task-id></task-notification>' },
      },
    ]);
    const agent = jsonl(path.join(d, 'subagents', 'agent-ag-bg.jsonl'), [
      asst('b1', null, 3000, { message: { id: 'bm1', model: 'test-opus', usage: { input_tokens: 3000 } } }),
    ]);
    const r = analyzeSession(session({ main, subagents: [agent] }));
    expect(turnOf(r, 'p1').subagentCost).toBeCloseTo(dollars(3000), 12);
  });

  it('ignores a task-notification on a line with no uuid — it has no tree position', () => {
    const d = dir();
    const main = jsonl(path.join(d, 'sid-1.jsonl'), [
      prompt('p1', 'x'),
      { type: 'queue-operation', message: { content: '<task-notification><task-id>ag-q</task-id></task-notification>' } },
    ]);
    const agent = jsonl(path.join(d, 'subagents', 'agent-ag-q.jsonl'), [
      asst('b1', null, 1000, { message: { id: 'bm1', model: 'test-opus', usage: { input_tokens: 1000 } } }),
    ]);
    const r = analyzeSession(session({ main, subagents: [agent] }));
    expect(turnOf(r, UNATTRIBUTED).subagentCost).toBeCloseTo(dollars(1000), 12);
  });

  it('leaves a genuinely unlinkable agent unattributed rather than guessing', () => {
    const d = dir();
    const main = jsonl(path.join(d, 'sid-1.jsonl'), [prompt('p1', 'x')]);
    const orphan = jsonl(path.join(d, 'subagents', 'agent-nolink.jsonl'), [
      asst('b1', null, 2000, { message: { id: 'bm1', model: 'test-opus', usage: { input_tokens: 2000 } } }),
    ]);
    const r = analyzeSession(session({ main, subagents: [orphan] }));
    expect(turnOf(r, 'p1').subagentCost).toBe(0);
    expect(turnOf(r, UNATTRIBUTED).subagentCost).toBeCloseTo(dollars(2000), 12);
  });

  it('falls back to UNATTRIBUTED when the linking line is itself unattributable', () => {
    const d = dir();
    const main = jsonl(path.join(d, 'sid-1.jsonl'), [
      { type: 'user', uuid: 't1', parentUuid: 'ghost', message: { content: [{ type: 'tool_result' }] }, toolUseResult: { agentId: 'ag1' } },
    ]);
    const agent = jsonl(path.join(d, 'subagents', 'agent-ag1.jsonl'), [
      asst('b1', null, 1000, { message: { id: 'bm1', model: 'test-opus', usage: { input_tokens: 1000 } } }),
    ]);
    const r = analyzeSession(session({ main, subagents: [agent] }));
    expect(turnOf(r, UNATTRIBUTED).subagentCost).toBeCloseTo(dollars(1000), 12);
  });

  it('propagates an unpriced model out of an agent file to turn and session', () => {
    const d = dir();
    const main = jsonl(path.join(d, 'sid-1.jsonl'), [
      prompt('p1', 'x'),
      { type: 'user', uuid: 't1', parentUuid: 'p1', message: { content: [{ type: 'tool_result' }] }, toolUseResult: { agentId: 'ag1' } },
    ]);
    const agent = jsonl(path.join(d, 'subagents', 'agent-ag1.jsonl'), [
      asst('b1', null, 500, { message: { id: 'bm1', model: 'ghost-model', usage: { input_tokens: 500 } } }),
      asst('b2', null, 300, { message: { id: 'bm2', model: 'test-opus', usage: { input_tokens: 300 } } }),
    ]);
    const r = analyzeSession(session({ main, subagents: [agent] }));

    expect(r.unpricedModels).toEqual(['ghost-model']);
    expect(turnOf(r, 'p1').unpricedModels).toEqual(['ghost-model']);
    // 有定價的那一半仍然照常計費；沒有定價的那一半只貢獻 token。
    expect(r.subagentCost).toBeCloseTo(dollars(300), 12);
    expect(r.tokens.input).toBe(800);
  });

  it('counts every agent file across both tiers in agentFileCount', () => {
    const d = dir();
    const main = jsonl(path.join(d, 'sid-1.jsonl'), [prompt('p1', 'x')]);
    const mk = (n) => jsonl(path.join(d, `a${n}.jsonl`), [prompt(`x${n}`, 'noop')]);
    const r = analyzeSession(
      session({ main, subagents: [mk(1), mk(2)], workflows: new Map([['r1', [mk(3)]], ['r2', [mk(4), mk(5)]]]) }),
    );
    expect(r.agentFileCount).toBe(5);
    expect(r.workflowRunCount).toBe(2);
  });

  it('spreads every file of a multi-file workflow run onto the same owning turn', () => {
    const d = dir();
    const main = jsonl(path.join(d, 'sid-1.jsonl'), [
      prompt('p1', 'x'),
      { type: 'user', uuid: 't1', parentUuid: 'p1', message: { content: [{ type: 'tool_result' }] }, toolUseResult: { runId: 'r1' } },
    ]);
    const mk = (n, cost) =>
      jsonl(path.join(d, `wf${n}.jsonl`), [
        asst(`c${n}`, null, cost, { message: { id: `cm${n}`, model: 'test-opus', usage: { input_tokens: cost } } }),
      ]);
    const r = analyzeSession(session({ main, workflows: new Map([['r1', [mk(1, 1000), mk(2, 2000)]]]) }));
    expect(turnOf(r, 'p1').workflowCost).toBeCloseTo(dollars(3000), 12);
  });
});

describe('analyzeSession — dedup via the shared seen set', () => {
  it('never counts the same message twice inside one session', () => {
    const d = dir();
    const dup = asst('a1', 'p1', 1000);
    const main = jsonl(path.join(d, 'sid-1.jsonl'), [prompt('p1', 'x'), dup, { ...dup, uuid: 'a2', parentUuid: 'a1' }]);
    const r = analyzeSession(session({ main }));
    expect(r.ownCost).toBeCloseTo(dollars(1000), 12);
  });

  it('gives a replayed message to the FIRST session to claim it, not the second', () => {
    const d = dir();
    const shared = asst('a1', 'p1', 1000);
    const mainA = jsonl(path.join(d, 'A.jsonl'), [prompt('p1', 'x'), shared]);
    const mainB = jsonl(path.join(d, 'B.jsonl'), [prompt('p1', 'x'), shared, asst('a9', 'p1', 500)]);

    const seen = new Set();
    const a = analyzeSession(session({ sessionId: 'A', main: mainA }), seen);
    const b = analyzeSession(session({ sessionId: 'B', main: mainB }), seen);

    expect(a.ownCost).toBeCloseTo(dollars(1000), 12);
    expect(b.ownCost).toBeCloseTo(dollars(500), 12); // 只有它真正新增的那則訊息
  });

  it('dedups a message shared between a main file and an agent file', () => {
    const d = dir();
    const shared = asst('a1', 'p1', 1000);
    const main = jsonl(path.join(d, 'sid-1.jsonl'), [prompt('p1', 'x'), shared]);
    const agent = jsonl(path.join(d, 'subagents', 'agent-ag1.jsonl'), [shared]);
    const r = analyzeSession(session({ main, subagents: [agent] }));
    expect(r.trueCost).toBeCloseTo(dollars(1000), 12);
  });
});

describe('analyzeAll', () => {
  const mkSession = (id, firstTs, input) => {
    const d = dir();
    return session({
      sessionId: id,
      main: jsonl(path.join(d, `${id}.jsonl`), [
        prompt(`p-${id}`, `prompt ${id}`, { timestamp: firstTs }),
        asst(`a-${id}`, `p-${id}`, input, {
          timestamp: firstTs,
          message: { id: `m-${id}`, model: 'test-opus', usage: { input_tokens: input } },
        }),
      ]),
    });
  };

  it('returns sessions ordered by trueCost, most expensive first', () => {
    const out = analyzeAll(
      new Map([
        ['cheap', mkSession('cheap', '2026-05-01T00:00:00Z', 100)],
        ['dear', mkSession('dear', '2026-05-02T00:00:00Z', 9000)],
      ]),
    );
    expect(out.map((s) => s.sessionId)).toEqual(['dear', 'cheap']);
  });

  it('drops sessions that have no files in any tier', () => {
    const out = analyzeAll(new Map([['empty', session({ sessionId: 'empty' })]]));
    expect(out).toEqual([]);
  });

  it('processes chronologically so a resumed session does not re-spend the money', () => {
    const d = dir();
    const replayed = asst('shared', 'p-old', 5000, {
      timestamp: '2026-05-01T00:00:00Z',
      message: { id: 'm-shared', model: 'test-opus', usage: { input_tokens: 5000 } },
    });
    const older = session({
      sessionId: 'older',
      main: jsonl(path.join(d, 'older.jsonl'), [
        prompt('p-old', 'original', { timestamp: '2026-05-01T00:00:00Z' }),
        replayed,
      ]),
    });
    const resumed = session({
      sessionId: 'resumed',
      main: jsonl(path.join(d, 'resumed.jsonl'), [
        prompt('p-old', 'original', { timestamp: '2026-06-01T00:00:00Z' }),
        replayed,
        asst('fresh', 'p-old', 100, {
          timestamp: '2026-06-01T00:00:00Z',
          message: { id: 'm-fresh', model: 'test-opus', usage: { input_tokens: 100 } },
        }),
      ]),
    });

    // 插入順序刻意把「被續接的」session 放前面：應該只有 firstTimestamp 的排序
    // 能決定誰保住那筆被重播的成本。
    const out = analyzeAll(new Map([['resumed', resumed], ['older', older]]));
    const byId = Object.fromEntries(out.map((s) => [s.sessionId, s]));
    expect(byId.older.trueCost).toBeCloseTo(dollars(5000), 12);
    expect(byId.resumed.trueCost).toBeCloseTo(dollars(100), 12);
    expect(out.reduce((n, s) => n + s.trueCost, 0)).toBeCloseTo(dollars(5100), 12);
  });

  it('sorts a session whose main file has no timestamp to the very end', () => {
    const d = dir();
    const noTs = session({
      sessionId: 'nots',
      main: jsonl(path.join(d, 'nots.jsonl'), [
        { type: 'user', uuid: 'p', parentUuid: null, message: { content: 'x' } },
        asst('a', 'p', 5000, { timestamp: undefined, message: { id: 'mn', model: 'test-opus', usage: { input_tokens: 5000 } } }),
      ]),
    });
    // 與那個沒有時間戳的 session 用同一個 message id：先被處理的一方會保住它，
    // 所以這裡斷言的是「順序」，而不只是總額。
    const dated = session({
      sessionId: 'dated',
      main: jsonl(path.join(d, 'dated.jsonl'), [
        prompt('p2', 'x', { timestamp: '2026-05-01T00:00:00Z' }),
        asst('a', 'p2', 5000, {
          timestamp: '2026-05-01T00:00:00Z',
          message: { id: 'mn', model: 'test-opus', usage: { input_tokens: 5000 } },
        }),
      ]),
    });
    const out = analyzeAll(new Map([['nots', noTs], ['dated', dated]]));
    const byId = Object.fromEntries(out.map((s) => [s.sessionId, s]));
    expect(byId.dated.trueCost).toBeCloseTo(dollars(5000), 12);
    expect(byId.nots.trueCost).toBe(0);
  });

  it('keeps a session that has agent files but no main transcript', () => {
    const d = dir();
    const agent = jsonl(path.join(d, 'agent-x.jsonl'), [
      asst('b1', null, 1000, { message: { id: 'bm1', model: 'test-opus', usage: { input_tokens: 1000 } } }),
    ]);
    const out = analyzeAll(new Map([['s', session({ sessionId: 's', subagents: [agent] })]]));
    expect(out).toHaveLength(1);
    expect(out[0].trueCost).toBeCloseTo(dollars(1000), 12);
  });
});

describe('analyzeSession — turn payload shape', () => {
  it('exposes the fields the prompt ranking needs, text included', () => {
    const d = dir();
    const main = jsonl(path.join(d, 'sid-1.jsonl'), [
      prompt('p1', '  a long   prompt with   whitespace  '),
      asst('a1', 'p1', 100),
    ]);
    const t = turnOf(analyzeSession(session({ main })), 'p1');
    expect(t).toMatchObject({
      promptId: 'p1',
      sessionId: 'sid-1',
      text: 'a long   prompt with   whitespace',
      snippet: 'a long prompt with whitespace',
      timestamp: '2026-05-01T00:00:00.000Z',
      gitBranch: 'main',
    });
    expect(t.byModel[0]).toMatchObject({ model: 'test-opus' });
  });

  it('renders a slash command as name + args on the turn', () => {
    const d = dir();
    const main = jsonl(path.join(d, 'sid-1.jsonl'), [
      prompt('p1', '<command-name>/goal</command-name>\n<command-args>ship it</command-args>'),
      asst('a1', 'p1', 100),
    ]);
    expect(turnOf(analyzeSession(session({ main })), 'p1').snippet).toBe('/goal ship it');
  });
});
