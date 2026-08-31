import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CACHE_VERSION = 3;
const SCAN_TTL_MS = 1000;

vi.mock('../src/config.js', () => ({ CACHE_VERSION }));

/** 假的語料：session id -> 每個檔案的 { size, mtimeMs }。 */
let corpus = new Map();
const discoverSessions = vi.fn(() => corpus);
const allFilesOf = vi.fn((s) => s.files);
vi.mock('../src/discover.js', () => ({
  discoverSessions: (...a) => discoverSessions(...a),
  allFilesOf: (...a) => allFilesOf(...a),
}));

const analyzeAll = vi.fn(() => [{ sessionId: 'a', trueCost: 1 }]);
vi.mock('../src/attribute.js', () => ({ analyzeAll: (...a) => analyzeAll(...a) }));

let readErrors = [];
vi.mock('../src/parser.js', () => ({
  getReadErrors: () => readErrors,
  resetReadErrors: () => { readErrors = []; },
}));

const stats = new Map();
vi.mock('node:fs', () => ({
  default: {
    statSync: (f) => {
      const s = stats.get(f);
      if (!s) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return s;
    },
  },
}));

const { cacheStats, currentFingerprint, getAnalysis, invalidate } = await import('../src/cache.js');

const setCorpus = (files) => {
  corpus = new Map([['s1', { files: files.map((f) => f.path) }]]);
  stats.clear();
  for (const f of files) stats.set(f.path, { size: f.size, mtimeMs: f.mtimeMs });
};

beforeEach(() => {
  vi.useFakeTimers();
  invalidate();
  discoverSessions.mockClear();
  analyzeAll.mockClear();
  readErrors = [];
  setCorpus([{ path: 'a.jsonl', size: 100, mtimeMs: 1 }]);
});

afterEach(() => vi.useRealTimers());

describe('getAnalysis — memoization', () => {
  it('parses on the first call and reports it as uncached', () => {
    const r = getAnalysis();
    expect(r.cached).toBe(false);
    expect(r.sessions).toEqual([{ sessionId: 'a', trueCost: 1 }]);
    expect(r.fileCount).toBe(1);
    expect(analyzeAll).toHaveBeenCalledTimes(1);
  });

  it('serves the memo on an unchanged corpus, flagged as cached', () => {
    getAnalysis();
    const r = getAnalysis();
    expect(r.cached).toBe(true);
    expect(analyzeAll).toHaveBeenCalledTimes(1);
  });

  it('re-parses when force is set', () => {
    getAnalysis();
    expect(getAnalysis({ force: true }).cached).toBe(false);
    expect(analyzeAll).toHaveBeenCalledTimes(2);
  });

  it('re-parses when a transcript size or mtime changes', () => {
    getAnalysis();
    vi.setSystemTime(Date.now() + SCAN_TTL_MS + 1);
    setCorpus([{ path: 'a.jsonl', size: 200, mtimeMs: 1 }]);
    expect(getAnalysis().cached).toBe(false);

    vi.setSystemTime(Date.now() + SCAN_TTL_MS + 1);
    setCorpus([{ path: 'a.jsonl', size: 200, mtimeMs: 2 }]);
    expect(getAnalysis().cached).toBe(false);
    expect(analyzeAll).toHaveBeenCalledTimes(3);
  });

  it('re-parses when a transcript appears or disappears', () => {
    getAnalysis();
    vi.setSystemTime(Date.now() + SCAN_TTL_MS + 1);
    setCorpus([
      { path: 'a.jsonl', size: 100, mtimeMs: 1 },
      { path: 'b.jsonl', size: 50, mtimeMs: 1 },
    ]);
    expect(getAnalysis().cached).toBe(false);
    expect(getAnalysis().fileCount).toBe(2);
  });

  it('fingerprints a vanished file as missing rather than throwing', () => {
    corpus = new Map([['s1', { files: ['gone.jsonl'] }]]);
    stats.clear();
    expect(() => getAnalysis()).not.toThrow();
    expect(currentFingerprint()).toContain('gone.jsonl:missing');
  });

  it('includes the cache version, so a parser change invalidates every memo', () => {
    expect(currentFingerprint()).toContain(`v${CACHE_VERSION}`);
  });

  it('fingerprints in sorted file order, so directory order cannot change it', () => {
    setCorpus([
      { path: 'b.jsonl', size: 1, mtimeMs: 1 },
      { path: 'a.jsonl', size: 1, mtimeMs: 1 },
    ]);
    const first = currentFingerprint();
    invalidate();
    setCorpus([
      { path: 'a.jsonl', size: 1, mtimeMs: 1 },
      { path: 'b.jsonl', size: 1, mtimeMs: 1 },
    ]);
    expect(currentFingerprint()).toBe(first);
  });

  it('copies the read errors, so a later collector push cannot mutate the memo', () => {
    readErrors = [{ file: 'x.jsonl', code: 'EPERM' }];
    // resetReadErrors() 會在 analyzeAll 之前執行，所以要在分析「之內」種進去。
    analyzeAll.mockImplementationOnce(() => {
      readErrors = [{ file: 'x.jsonl', code: 'EPERM' }];
      return [];
    });
    const r = getAnalysis();
    expect(r.readErrors).toEqual([{ file: 'x.jsonl', code: 'EPERM' }]);

    readErrors.push({ file: 'later.jsonl', code: 'EACCES' });
    expect(getAnalysis().readErrors).toHaveLength(1);
  });
});

describe('the shared scan', () => {
  it('shares one scan across a burst inside the TTL', () => {
    // 一次重新整理會觸發九個並行的分頁請求；它們必須對同一個指紋達成共識，
    // 否則每一個都會沒命中快取，各自把整份語料重新解析一遍。
    for (let i = 0; i < 9; i++) getAnalysis();
    expect(discoverSessions).toHaveBeenCalledTimes(1);
    expect(analyzeAll).toHaveBeenCalledTimes(1);
    expect(cacheStats()).toMatchObject({ scans: 1, parses: 1 });
  });

  it('rescans once the TTL has passed', () => {
    getAnalysis();
    vi.setSystemTime(Date.now() + SCAN_TTL_MS + 1);
    getAnalysis();
    expect(discoverSessions).toHaveBeenCalledTimes(2);
    expect(cacheStats().scans).toBe(2);
  });

  it('restarts the TTL clock from the END of a parse', () => {
    // 解析本身耗時超過 TTL，所以若不重新打時間戳，同一叢請求裡的下一個就會
    // 重新掃描，甚至可能整個再解析一次。
    analyzeAll.mockImplementationOnce(() => {
      vi.setSystemTime(Date.now() + SCAN_TTL_MS * 5);
      return [];
    });
    getAnalysis();
    expect(discoverSessions).toHaveBeenCalledTimes(1);
    getAnalysis();
    expect(discoverSessions).toHaveBeenCalledTimes(1);
    expect(analyzeAll).toHaveBeenCalledTimes(1);
  });

  it('always rescans after invalidate, so a user-requested refresh is never hidden', () => {
    getAnalysis();
    invalidate();
    getAnalysis();
    expect(discoverSessions).toHaveBeenCalledTimes(2);
    expect(analyzeAll).toHaveBeenCalledTimes(2);
  });
});

describe('cacheStats', () => {
  it('counts scans and parses since the last invalidate', () => {
    getAnalysis();
    vi.setSystemTime(Date.now() + SCAN_TTL_MS + 1);
    getAnalysis();
    expect(cacheStats()).toMatchObject({ scans: 2, parses: 1 });
  });

  it('resets to zero on invalidate', () => {
    getAnalysis();
    invalidate();
    expect(cacheStats()).toEqual({ scans: 0, parses: 0, scanMs: 0 });
  });

  it('returns a copy, so a caller cannot corrupt the counters', () => {
    getAnalysis();
    cacheStats().parses = 999;
    expect(cacheStats().parses).toBe(1);
  });
});
