import fs from 'node:fs';
import { analyzeAll } from './attribute.js';
import { allFilesOf, discoverSessions } from './discover.js';
import { CACHE_VERSION } from './config.js';
import { getReadErrors, resetReadErrors } from './parser.js';

/**
 * 整份語料的快取，以每個記錄檔的 (路徑, 大小, mtime) 組成的指紋來失效。
 *
 * 原本的設計是做「每個 session 各自的增量快取」，但那被證明是不成立的：
 * 去重必須跨所有 session 全域執行（一個被續接的 session 會重播 592 則、
 * 價值 $133.64 的訊息，而那些訊息同時也存在於原本的記錄裡），
 * 所以某個 session 的結果會相依於其他 session。各自獨立快取，會讓過期的鄰居
 * 改變某個 session 的成本。
 *
 * 全部 409 個檔案／171 MB 重新分析一次實測約 1.4 秒，而算指紋約 20 毫秒，
 * 所以整份一起快取既比較單純，也永遠是正確的。
 */
let memo = null;

/**
 * 指紋背後的那次掃描（走訪目錄 + 對每個記錄檔做一次 statSync），
 * 在 SCAN_TTL_MS 之內由所有詢問者共用。
 *
 * 沒有這個，一次「重新整理」要付出約 12 次獨立掃描 —— 每個彙總進入點都會重走一次
 * 目錄樹，而 /api/health 自己就走了四次。更糟的是，當某個 Claude Code session 正在
 * 寫入時，每次掃描都會算出「不同的」指紋，於是九個並行請求全部沒命中快取，
 * 各自把整份語料重新解析一遍：事件迴圈被卡住約 13 秒，而不是跑完一次 1.4 秒。
 * 共用掃描結果能讓這一叢請求對同一個指紋達成共識，於是只有其中一個會真的去解析。
 *
 * 這個 TTL 絕不會蓋掉使用者主動要求的重新整理：invalidate() 會把掃描結果丟掉，
 * 所以 POST /api/refresh 一定會重新掃描。
 */
let scan = null;
const SCAN_TTL_MS = 1000;

/**
 * 自上次 invalidate()（也就是上次「重新整理」）以來的計數。會顯示在 /api/health 上，
 * 讓「一次重新整理只掃描一次、只解析一次」這件事可以直接從儀表板上讀到，
 * 而不必特地去替建置加上量測。
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

/** 所有 session 的分析結果，只有在記錄檔真的變動時才重算。 */
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
    // 在「這一次」分析期間開不起來的記錄檔。它們裡面的成本不會出現在儀表板的
    // 任何數字上，所以必須明講出來。
    // 這裡存的是副本而非那個活的陣列：localagent.js 會在我們 resetReadErrors()
    // 的時間窗之外，往同一個收集器（parser.js）裡塞東西，而它的失敗絕不該出現在
    // 一份已經被快取起來的記錄分析裡。
    readErrors: [...getReadErrors()],
  };
  memo = { fingerprint: s.fp, data };
  // 解析本身耗時超過 SCAN_TTL_MS，所以若不重新打時間戳，同一叢請求裡的下一個
  // 就會重新掃描、看到期間又長大的 session，然後整個再解析一次。
  // 因此從我們剛做完的工作結束時重新起算。
  s.at = Date.now();
  return { ...data, cached: false };
}

export function invalidate() {
  memo = null;
  scan = null;
  stats = { scans: 0, parses: 0, scanMs: 0 };
}

/** 目前記錄語料的指紋 —— 與 ccusage 快取共用。 */
export function currentFingerprint() {
  return currentScan().fp;
}
