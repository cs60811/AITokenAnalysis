import fs from 'node:fs';
import { analyzeAll } from './attribute.js';
import { allFilesOf, discoverSessions } from './discover.js';
import { CACHE_VERSION } from './config.js';

/**
 * Whole-corpus memo, invalidated by a fingerprint over every transcript's
 * (path, size, mtime).
 *
 * The design plan called for a per-session incremental cache, but that turned out
 * to be unsound: dedup has to run globally across sessions (a resumed session
 * replays 592 messages worth $133.64 that also live in the original transcript),
 * so one session's result depends on the others. Caching them independently would
 * let stale neighbours change a session's cost.
 *
 * A full re-analysis of all 340 files / 103 MB measures ~650ms, and fingerprinting
 * costs ~9ms, so caching the whole result is both simpler and always correct.
 */
let memo = null;

function fingerprint(sessions) {
  const parts = [`v${CACHE_VERSION}`];
  const files = [];
  for (const s of sessions.values()) files.push(...allFilesOf(s));
  files.sort();
  for (const f of files) {
    try {
      const st = fs.statSync(f);
      parts.push(`${f}:${st.size}:${st.mtimeMs}`);
    } catch {
      parts.push(`${f}:missing`);
    }
  }
  return parts.join('|');
}

/** Analysis of every session, recomputed only when a transcript actually changes. */
export function getAnalysis({ force = false } = {}) {
  const sessions = discoverSessions();
  const fp = fingerprint(sessions);

  if (!force && memo && memo.fingerprint === fp) {
    return { ...memo.data, cached: true };
  }

  const started = Date.now();
  const sessionList = analyzeAll(sessions);
  const data = {
    sessions: sessionList,
    generatedAt: new Date().toISOString(),
    parseMs: Date.now() - started,
    fileCount: [...sessions.values()].reduce((n, s) => n + allFilesOf(s).length, 0),
  };
  memo = { fingerprint: fp, data };
  return { ...data, cached: false };
}

export function invalidate() {
  memo = null;
}
