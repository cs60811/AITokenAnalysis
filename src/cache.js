import fs from 'node:fs';
import { analyzeAll } from './attribute.js';
import { allFilesOf, discoverSessions } from './discover.js';
import { CACHE_VERSION } from './config.js';
import { getReadErrors, resetReadErrors } from './parser.js';

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
 * A full re-analysis of all 409 files / 171 MB measures ~1.4s, and fingerprinting
 * costs ~20ms, so caching the whole result is both simpler and always correct.
 */
let memo = null;

/**
 * The scan (directory walk + one statSync per transcript) behind the fingerprint,
 * shared by everything that asks within SCAN_TTL_MS.
 *
 * Without this, one 重新整理 cost ~12 independent scans — every aggregate entry
 * point re-walks the tree, and /api/health does it four times. Worse, while a
 * Claude Code session is writing, each scan produced a DIFFERENT fingerprint, so
 * all nine parallel requests missed the memo and each re-parsed the whole corpus:
 * ~13s of blocked event loop instead of one 1.4s pass. Sharing the scan makes the
 * burst agree on one fingerprint, so exactly one of them parses.
 *
 * The TTL never hides a user-requested refresh: invalidate() drops the scan, so
 * POST /api/refresh always rescans.
 */
let scan = null;
const SCAN_TTL_MS = 1000;

/**
 * Counters since the last invalidate(), i.e. since the last 重新整理. Reported on
 * /api/health so "one scan and one parse per refresh cycle" is something you can
 * read off the dashboard instead of having to instrument a build.
 */
let stats = { scans: 0, parses: 0, scanMs: 0 };
export const cacheStats = () => ({ ...stats });

function rescan() {
  const t0 = Date.now();
  stats.scans++;
  const sessions = discoverSessions();
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
  stats.scanMs += Date.now() - t0;
  return { at: Date.now(), sessions, fp: parts.join('|'), fileCount: files.length };
}

function currentScan() {
  if (scan && Date.now() - scan.at < SCAN_TTL_MS) return scan;
  scan = rescan();
  return scan;
}

/** Analysis of every session, recomputed only when a transcript actually changes. */
export function getAnalysis({ force = false } = {}) {
  const s = currentScan();

  if (!force && memo && memo.fingerprint === s.fp) {
    return { ...memo.data, cached: true };
  }

  const started = Date.now();
  stats.parses++;
  resetReadErrors();
  const sessionList = analyzeAll(s.sessions);
  const data = {
    sessions: sessionList,
    generatedAt: new Date().toISOString(),
    parseMs: Date.now() - started,
    fileCount: s.fileCount,
    // Transcripts that could not be opened during THIS analysis. Cost inside
    // them is missing from every number on the dashboard, so it has to be said.
    // A copy, not the live array: localagent.js pushes into the same collector
    // (parser.js) outside our resetReadErrors() window, and its failures must not
    // appear inside an already-memoized transcript analysis.
    readErrors: [...getReadErrors()],
  };
  memo = { fingerprint: s.fp, data };
  // The parse outlives SCAN_TTL_MS, so without re-stamping, the very next request
  // of the same burst would rescan, see a session that grew meanwhile, and parse
  // all over again. Restart the clock from the end of the work we just did.
  s.at = Date.now();
  return { ...data, cached: false };
}

export function invalidate() {
  memo = null;
  scan = null;
  stats = { scans: 0, parses: 0, scanMs: 0 };
}

/** Fingerprint of the current transcript corpus — shared with the ccusage cache. */
export function currentFingerprint() {
  return currentScan().fp;
}
