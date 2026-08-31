import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aita-disc-'));
const ROOT = path.join(TMP, 'projects');

vi.mock('../src/config.js', () => ({ CLAUDE_PROJECTS_DIR: ROOT }));

const { allFilesOf, discoverSessions, projectLabelFromDirName } = await import('../src/discover.js');

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const touch = (...parts) => {
  const file = path.join(ROOT, ...parts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  return file;
};

const SID = '65ab2f04-2191-403b-973e-7a2d1dd6adfe';

describe('projectLabelFromDirName', () => {
  it('keeps everything after the repos- marker', () => {
    expect(projectLabelFromDirName('C--Users-me-source-repos-AITokenAnalysis')).toBe('AITokenAnalysis');
  });

  it('keeps a hyphenated project name intact rather than splitting on -', () => {
    // 這個編碼會把分隔符「和」原本就存在的連字號都換成 '-'，
    // 所以天真地用它去切，會把 "…repos-MS-Web" 變成 "Web"。
    expect(projectLabelFromDirName('C--Users-me-source-repos-MS-Web')).toBe('MS-Web');
  });

  it('falls back to the source- marker when there is no repos-', () => {
    expect(projectLabelFromDirName('C--Users-me-source-MyApp')).toBe('MyApp');
  });

  it('prefers repos- over source- when both are present', () => {
    expect(projectLabelFromDirName('C--source-x-repos-Real')).toBe('Real');
  });

  it('returns the name unchanged when neither marker appears', () => {
    expect(projectLabelFromDirName('C--tmp-scratch')).toBe('C--tmp-scratch');
  });
});

describe('discoverSessions', () => {
  it('returns an empty map when the root does not exist', () => {
    expect(discoverSessions().size).toBe(0);
  });

  it('finds a main transcript and derives the session id from the filename', () => {
    const main = touch('proj-a', `${SID}.jsonl`);
    const sessions = discoverSessions();
    expect([...sessions.keys()]).toEqual([SID]);
    expect(sessions.get(SID)).toMatchObject({
      sessionId: SID,
      projectDir: 'proj-a',
      main,
      subagents: [],
    });
    expect(sessions.get(SID).workflows.size).toBe(0);
  });

  it('tags subagent transcripts under <sid>/subagents/', () => {
    touch('proj-a', `${SID}.jsonl`);
    const a1 = touch('proj-a', SID, 'subagents', 'agent-1.jsonl');
    const a2 = touch('proj-a', SID, 'subagents', 'agent-2.jsonl');
    expect(discoverSessions().get(SID).subagents.sort()).toEqual([a1, a2].sort());
  });

  it('tags workflow transcripts by their runId directory', () => {
    touch('proj-a', `${SID}.jsonl`);
    const w1 = touch('proj-a', SID, 'subagents', 'workflows', 'wf_abc', 'agent-1.jsonl');
    const w2 = touch('proj-a', SID, 'subagents', 'workflows', 'wf_abc', 'agent-2.jsonl');
    const w3 = touch('proj-a', SID, 'subagents', 'workflows', 'wf_xyz', 'agent-1.jsonl');

    const wf = discoverSessions().get(SID).workflows;
    expect([...wf.keys()].sort()).toEqual(['wf_abc', 'wf_xyz']);
    expect(wf.get('wf_abc').sort()).toEqual([w1, w2].sort());
    expect(wf.get('wf_xyz')).toEqual([w3]);
    // workflow 那一層絕不能漏進 subagent 那一層：ccusage 會算 subagent 卻靜默地
    // 漏掉 workflow，所以這個區分必須保住。
    expect(discoverSessions().get(SID).subagents).toEqual([]);
  });

  it('keeps a session that has agent files but no main transcript', () => {
    const a = touch('proj-a', SID, 'subagents', 'agent-1.jsonl');
    const s = discoverSessions().get(SID);
    expect(s.main).toBeNull();
    expect(s.subagents).toEqual([a]);
  });

  it('skips the memory and tool-results directories', () => {
    touch('proj-a', `${SID}.jsonl`);
    touch('proj-a', 'memory', 'subagents', 'agent-1.jsonl');
    touch('proj-a', 'tool-results', 'subagents', 'agent-1.jsonl');
    expect(discoverSessions().size).toBe(1);
    expect(discoverSessions().get(SID).subagents).toEqual([]);
  });

  it('ignores a session directory with no subagents dir', () => {
    touch('proj-a', SID, 'notes', 'x.jsonl');
    expect(discoverSessions().size).toBe(0);
  });

  it('ignores non-jsonl files at every level', () => {
    touch('proj-a', 'README.md');
    touch('proj-a', SID, 'subagents', 'notes.txt');
    touch('proj-a', SID, 'subagents', 'workflows', 'wf_a', 'notes.txt');
    // 這筆記錄之所以存在，是因為 subagents/ 存在，但每一層都是空的 ——
    // 而 analyzeAll 正好會把這種形狀丟掉，所以它永遠不會出現在儀表板上。
    const s = discoverSessions().get(SID);
    expect(s.main).toBeNull();
    expect(s.subagents).toEqual([]);
    expect(s.workflows.size).toBe(0);
  });

  it('creates no record at all for a project holding only non-jsonl files', () => {
    touch('proj-a', 'README.md');
    expect(discoverSessions().size).toBe(0);
  });

  it('drops a workflow run directory that holds no jsonl at all', () => {
    touch('proj-a', `${SID}.jsonl`);
    touch('proj-a', SID, 'subagents', 'workflows', 'wf_empty', 'readme.md');
    expect(discoverSessions().get(SID).workflows.size).toBe(0);
  });

  it('ignores a plain file sitting where a workflow run directory would be', () => {
    touch('proj-a', `${SID}.jsonl`);
    touch('proj-a', SID, 'subagents', 'workflows', 'stray.jsonl');
    expect(discoverSessions().get(SID).workflows.size).toBe(0);
  });

  it('ignores loose files directly under the root', () => {
    touch('loose.jsonl');
    expect(discoverSessions().size).toBe(0);
  });

  it('merges the tiers of one session across a single project directory', () => {
    const main = touch('proj-a', `${SID}.jsonl`);
    const sub = touch('proj-a', SID, 'subagents', 'agent-1.jsonl');
    const wf = touch('proj-a', SID, 'subagents', 'workflows', 'wf_1', 'agent-1.jsonl');
    const s = discoverSessions().get(SID);
    expect(s).toMatchObject({ main, subagents: [sub] });
    expect(s.workflows.get('wf_1')).toEqual([wf]);
  });

  it('walks every project directory', () => {
    touch('proj-a', 'aaaaaaaa-0000-0000-0000-000000000001.jsonl');
    touch('proj-b', 'aaaaaaaa-0000-0000-0000-000000000002.jsonl');
    expect(discoverSessions().size).toBe(2);
  });

  it('labels a session from its project directory name', () => {
    touch('C--Users-me-source-repos-MS-Web', `${SID}.jsonl`);
    expect(discoverSessions().get(SID).projectLabel).toBe('MS-Web');
  });

  it('accepts an explicit root, overriding the configured one', () => {
    const other = path.join(TMP, 'other');
    const file = path.join(other, 'proj-x', `${SID}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    expect(discoverSessions(other).get(SID).main).toBe(file);
    expect(discoverSessions().size).toBe(0);
  });
});

describe('allFilesOf', () => {
  it('flattens all three tiers into one list', () => {
    const main = touch('proj-a', `${SID}.jsonl`);
    const sub = touch('proj-a', SID, 'subagents', 'agent-1.jsonl');
    const w1 = touch('proj-a', SID, 'subagents', 'workflows', 'wf_1', 'agent-1.jsonl');
    const w2 = touch('proj-a', SID, 'subagents', 'workflows', 'wf_2', 'agent-1.jsonl');
    expect(allFilesOf(discoverSessions().get(SID)).sort()).toEqual([main, sub, w1, w2].sort());
  });

  it('omits a missing main transcript rather than listing null', () => {
    touch('proj-a', SID, 'subagents', 'agent-1.jsonl');
    expect(allFilesOf(discoverSessions().get(SID))).toHaveLength(1);
  });

  it('returns an empty list for a session with no files', () => {
    expect(allFilesOf({ main: null, subagents: [], workflows: new Map() })).toEqual([]);
  });
});
