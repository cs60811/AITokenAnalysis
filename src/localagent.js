import fs from 'node:fs';
import path from 'node:path';
import { LOCAL_AGENT_DIR } from './config.js';
import { isBillable, readLines, textOf } from './parser.js';
import { billableParts, costOf, hasRates, tokensOf } from './pricing.js';

/**
 * ccusage 和主分析都看不到的支出。
 *
 * 桌面版的 local agent mode —— 也就是你在 UI 裡設定的排程任務 —— 把記錄放在
 * %APPDATA%\claude\local-agent-mode-sessions，不在 CLAUDE_PROJECTS_DIR 底下。
 * ccusage 也不讀那個根目錄：我們的 claude 總額和 `ccusage daily` 對帳到分，
 * 而這些執行紀錄卻在兩者之外。本機已驗證：這裡的 483 個 message id 中，
 * 有 0 個同時出現在 ~/.claude/projects，所以這裡沒有任何一筆是既有語料的重複。
 *
 * 刻意「不」計入全域總額：對帳閘門是拿我們的數字去比 ccusage 的，
 * 把 ccusage 根本看不到的支出加進去，只會讓那道閘門永遠有雜訊。
 * 因此它是以獨立的數字呈現。
 */

/**
 * 每次執行都會把訊息寫兩份 —— 一份到 `audit.jsonl`，一份到巢狀的
 * `.claude/projects/**` 記錄 —— 而 audit 那份「沒有」`requestId`，
 * 所以共用的 dedupKey() 會退化成用 uuid，導致兩份都被計算。
 * `message.id` 在兩份副本的每一行都有，而且跨副本穩定，因此這裡改用它當鍵。
 * （刻意只留在這個模組：主語料沒有「有 id 卻沒有 requestId」的行，
 * 而把共用的鍵放寬，可能會把真正不同的重試合併掉。）
 */
const keyOf = (line) => (line.message?.id ? `id:${line.message.id}` : `uuid:${line.uuid}`);

/** 自動執行的任務以 `<scheduled-task name="…" …>` 開頭。 */
const SCHEDULED_TASK_RE = /<scheduled-task\s+name="([^"]+)"/;
const MANUAL = '（手動執行）';

/** `local_<uuid>` 目錄用來識別一次排程任務的執行。 */
const RUN_DIR_PREFIX = 'local_';
const AUDIT_FILE = 'audit.jsonl';
const JSONL_EXT = '.jsonl';
const UNKNOWN_RUN = '(unknown)';

/** 擷取足以在表格欄位中辨識該次執行的 prompt 長度。 */
const PROMPT_LABEL_CHARS = 90;

/**
 * `dir` 底下的子目錄；沒有的話回傳 []。
 *
 * 這裡到處都預期會遇到 ENOENT —— 大多數機器沒有 local agent mode，
 * 而且一次執行也不一定會有 `.claude/projects`。但其他錯誤（權限問題、
 * 檔案代號用盡）就「不」在預期內，把它吞掉等於把「我讀不到這個」變成
 * 「這裡什麼都沒有」，會讓整個功能從儀表板上靜默消失。
 * 實際觀察到過：一台長時間執行的伺服器回報 0 筆執行，而同一路徑上新啟動的
 * 伺服器卻回報 16 筆。
 */
const dirsIn = (dir) => {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(dir, e.name));
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [];
    throw err;
  }
};

/**
 * 上一次掃描實際看到了什麼，會一併放進回傳資料裡。
 *
 * 沒有這個，所有失敗情境都會塌縮成同一張空白卡片，而唯一能區分它們的方法，
 * 是去一台你可能根本碰不到的機器上掛偵錯器。`rootEntries: 0` 代表根目錄不存在
 * （或無法當成目錄讀取）；`files: 32, filesRead: 0` 則代表我們找到了記錄檔卻打不開 ——
 * 這是兩個完全不同的問題，而現在一眼就能分辨。
 *
 * `readErrors` 是我們自己的收集器，刻意不用 parser.js 那個模組層級的：
 * 那個陣列屬於記錄分析，而且會被一起記憶進快取，所以這裡的失敗以前會顯示在
 * 健康狀態卡上，看起來就像 ~/.claude/projects 讀取失敗一樣。
 */
const emptyScan = () => ({ rootEntries: 0, files: 0, filesRead: 0, billableLines: 0, readErrors: [] });
let lastScan = emptyScan();

/**
 * 一次執行會把記錄放在兩個固定位置，兩者都已在本機驗證（各 16 個檔案，沒有其他形狀）：
 *   <run>/audit.jsonl
 *   <run>/.claude/projects/<編碼過的 cwd>/<sid>.jsonl
 *
 * 刻意用列舉而不是遞迴走訪：每次執行還會附帶一份 skill 套件的副本
 * （docx/pptx/xlsx），所以遞迴走訪要跨約 430 個目錄、耗時約 85ms ——
 * 而且是「每個請求」都要付這個代價，因為這段跑在 /api/overview 後面。
 * 直接讀那兩個已知位置只要約 2ms。
 */
function transcriptsOfRun(run) {
  const out = [];
  const audit = path.join(run, AUDIT_FILE);
  if (fs.existsSync(audit)) out.push(audit);
  for (const project of dirsIn(path.join(run, '.claude', 'projects'))) {
    for (const f of fs.readdirSync(project)) {
      if (f.endsWith(JSONL_EXT)) out.push(path.join(project, f));
    }
  }
  return out;
}

/** 根目錄底下所有 workspace 與 conversation 中的 `local_*` 執行目錄。 */
function runDirs() {
  const workspaces = dirsIn(LOCAL_AGENT_DIR);
  const out = [];
  for (const workspace of workspaces) {
    for (const conversation of dirsIn(workspace)) {
      for (const run of dirsIn(conversation)) {
        if (path.basename(run).startsWith(RUN_DIR_PREFIX)) out.push(run);
      }
    }
  }
  return { rootEntries: workspaces.length, runs: out };
}

function transcriptFiles() {
  const { rootEntries, runs } = runDirs();
  const out = runs.flatMap(transcriptsOfRun);
  lastScan = { ...emptyScan(), rootEntries, files: out.length };
  return out;
}

/** 路徑中的 `local_<uuid>` 片段用來識別一次排程任務的執行。 */
const runOf = (file) =>
  path.relative(LOCAL_AGENT_DIR, file).split(path.sep).find((s) => s.startsWith(RUN_DIR_PREFIX)) ?? UNKNOWN_RUN;

const dayOf = (iso) => (iso ? String(iso).slice(0, 10) : null);

let memo = null; // { fp, runs, scan }

function fingerprint(files) {
  const parts = [];
  for (const f of files.slice().sort()) {
    try {
      const st = fs.statSync(f);
      parts.push(`${f}:${st.size}:${st.mtimeMs}`);
    } catch {
      parts.push(`${f}:missing`);
    }
  }
  return parts.join('|');
}

/* ── 解析 ─────────────────────────────────────────────────────────────────── */

const emptyTokens = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });

/** 單一可計費行的成本與 token，無法定價的部分一律跳過。 */
function priceLine(line) {
  let cost = 0;
  const tokens = emptyTokens();
  for (const part of billableParts(line.message.usage, line.message.model)) {
    if (!hasRates(part.model)) continue;
    cost += costOf(part.usage, part.model) ?? 0;
    const t = tokensOf(part.usage);
    tokens.input += t.input;
    tokens.output += t.output;
    tokens.cacheWrite += t.cacheWrite5m + t.cacheWrite1h;
    tokens.cacheRead += t.cacheRead;
  }
  return { cost, tokens };
}

const newRunMeta = () => ({ task: null, prompt: null, models: new Set() });

/**
 * 用第一行人類看得到的 user 內容來為一次執行命名。
 *
 * 自動執行的任務以任務外框開頭；手動設定的則以你輸入的內容開頭。
 * 兩者在 UI 上都值得標示出來，所以各取第一個出現的，後面的行不會覆蓋掉它。
 */
function noteUserLine(meta, line) {
  if (line.type !== 'user' || line.isMeta || line.isSidechain) return;
  const text = (textOf(line.message?.content) ?? '').trim();
  if (!text) return;
  meta.task ??= SCHEDULED_TASK_RE.exec(text)?.[1] ?? null;
  meta.prompt ??= text.replace(/\s+/g, ' ').slice(0, PROMPT_LABEL_CHARS);
}

/**
 * 把每份記錄讀過一次：取得已定價並附上去重鍵的訊息，以及各次執行的命名中繼資料。
 *
 * 訊息會以兩份副本中「較大」的那份定價 —— 478 則共有的訊息裡有 443 則兩份不一致，
 * 因為每份副本都是在回應還在串流時就寫下的，而完整的那份才是實際被計費的那份。
 */
function readMessages(files) {
  const byKey = new Map();
  const meta = new Map(); // run -> { task, prompt, models }

  for (const file of files) {
    const run = runOf(file);
    const lines = readLines(file, lastScan.readErrors);
    if (lines.length) lastScan.filesRead++;

    let info = meta.get(run);
    if (!info) {
      info = newRunMeta();
      meta.set(run, info);
    }

    for (const line of lines) {
      noteUserLine(info, line);
      if (!isBillable(line)) continue;
      lastScan.billableLines++;
      info.models.add(line.message.model);

      const key = keyOf(line);
      const priced = priceLine(line);
      const prev = byKey.get(key);
      if (!prev || priced.cost > prev.cost) {
        byKey.set(key, { run, ts: line.timestamp ?? prev?.ts ?? null, ...priced });
      }
    }
  }
  return { byKey, meta };
}

const totalTokensOf = (t) => t.input + t.output + t.cacheWrite + t.cacheRead;

/** 把去重後的訊息彙整成每次執行一筆，最舊的執行排前面。 */
function rollUpRuns(byKey, meta) {
  const runs = new Map();
  for (const m of byKey.values()) {
    let r = runs.get(m.run);
    if (!r) {
      r = { run: m.run, firstTs: m.ts, cost: 0, messages: 0, tokens: 0 };
      runs.set(m.run, r);
    }
    r.cost += m.cost;
    r.messages++;
    r.tokens += totalTokensOf(m.tokens);
    if (m.ts && (!r.firstTs || m.ts < r.firstTs)) r.firstTs = m.ts;
  }

  return [...runs.values()]
    .map((r) => {
      const info = meta.get(r.run) ?? {};
      return {
        ...r,
        day: dayOf(r.firstTs),
        task: info.task ?? null,
        prompt: info.prompt ?? null,
        models: [...(info.models ?? [])].sort(),
      };
    })
    .sort((a, z) => String(a.firstTs).localeCompare(String(z.firstTs)));
}

/** 每次執行一筆：{ run, day, firstTs, cost, tokens, messages, task, prompt, models }。 */
function parseRuns() {
  const files = transcriptFiles();
  const fp = fingerprint(files);
  if (memo && memo.fp === fp) {
    // 命中快取會跳過讀取迴圈，所以要把它的計數帶過來 —— 否則一次完全正常的快取命中
    // 會回報成「找到檔案，但一個都沒讀」。
    Object.assign(lastScan, memo.scan);
    return memo.runs;
  }

  const { byKey, meta } = readMessages(files);
  const runs = rollUpRuns(byKey, meta);
  memo = {
    fp,
    runs,
    scan: {
      filesRead: lastScan.filesRead,
      billableLines: lastScan.billableLines,
      readErrors: lastScan.readErrors,
    },
  };
  return runs;
}

/* ── 回傳資料 ─────────────────────────────────────────────────────────────── */

const spendError = (message) => ({
  available: false,
  error: message,
  cost: 0,
  runs: 0,
  tokens: 0,
  firstDay: null,
  lastDay: null,
  dataDir: LOCAL_AGENT_DIR,
  scan: lastScan,
});

/**
 * 把 parseRuns() 包在單一層防護裡，供兩個對外進入點共用。
 *
 * dirsIn 會把非 ENOENT 的錯誤重新拋出，而這段以前在一次 detail 請求裡會跑「兩次」——
 * 一次經由 localAgentSpend()，另一次則完全不在任何 try/catch 內 ——
 * 所以只要目錄在這兩次之間消失，一個原本可以正常回報的
 * { available: false, error } 就會變成未處理的 500。
 */
function tryParseRuns() {
  try {
    return { runs: parseRuns(), error: null };
  } catch (err) {
    return { runs: null, error: err.message };
  }
}

/** 以「執行開始的那一天」做日期區間篩選，頭尾皆包含。 */
const inRange = (run, { since, until } = {}) =>
  (!since || (run.day && run.day >= since)) && (!until || (run.day && run.day <= until));

/**
 * 給總覽卡片用的區間彙總。當這台機器完全沒有 local agent 記錄時 `available` 為 false，
 * 讓 UI 可以把卡片收起來，而不是永遠顯示 $0.00 —— 但讀取失敗「絕不能」長得像那樣，
 * 否則卡片消失時也把原因一起帶走了。讀取失敗會改以 `error` 呈現，而且不做任何快取，
 * 所以下一次請求會重試。
 */
export function localAgentSpend(range = {}) {
  const { runs, error } = tryParseRuns();
  return error === null ? spendFrom(runs, range) : spendError(error);
}

/** 彙總本體，獨立出來讓 localAgentDetail 能共用同一次 parseRuns()。 */
function spendFrom(all, range = {}) {
  const runs = all.filter((r) => inRange(r, range));
  const sum = (rows, field) => rows.reduce((n, r) => n + r[field], 0);
  return {
    available: all.length > 0,
    error: null,
    cost: sum(runs, 'cost'),
    runs: runs.length,
    tokens: sum(runs, 'tokens'),
    firstDay: all[0]?.day ?? null,
    lastDay: all[all.length - 1]?.day ?? null,
    // 未經篩選，這樣當某個區間查無資料時，還能指出資料實際落在哪裡。
    totalCost: sum(all, 'cost'),
    totalRuns: all.length,
    dataDir: LOCAL_AGENT_DIR,
    scan: lastScan,
  };
}

/** 明細分頁所呈現的單次執行，最新的排前面。 */
const runRow = (r) => ({
  id: r.run,
  task: r.task ?? MANUAL,
  scheduled: Boolean(r.task),
  startedAt: r.firstTs,
  day: r.day,
  cost: r.cost,
  messages: r.messages,
  tokens: r.tokens,
  models: r.models,
  prompt: r.prompt,
});

/**
 * 依排程任務分組的執行紀錄。
 *
 * 依任務分組正是重點：每個 `<scheduled-task name>` 一列，回答的是
 * 「這東西每天花我多少錢」，而這也是這裡唯一可行動的問題 ——
 * 這些執行是無人看管自動觸發的，沒有人在旁邊盯著。
 */
function groupByTask(rows) {
  const byTask = new Map();
  for (const r of rows) {
    let t = byTask.get(r.task);
    if (!t) {
      t = { task: r.task, scheduled: r.scheduled, runs: 0, cost: 0, tokens: 0, lastRun: null, models: new Set() };
      byTask.set(r.task, t);
    }
    t.runs++;
    t.cost += r.cost;
    t.tokens += r.tokens;
    if (!t.lastRun || String(r.startedAt) > String(t.lastRun)) t.lastRun = r.startedAt;
    for (const m of r.models) t.models.add(m);
  }
  return [...byTask.values()]
    .map((t) => ({ ...t, models: [...t.models].sort(), avgCost: t.runs ? t.cost / t.runs : 0 }))
    .sort((a, z) => z.cost - a.cost);
}

/** local agent 分頁的每次執行明細，依排程任務分組。 */
export function localAgentDetail(range = {}) {
  const { runs: all, error } = tryParseRuns();
  if (error !== null) return { ...spendError(error), runs: [], byTask: [] };

  const base = spendFrom(all, range);
  if (!base.available) return { ...base, runs: [], byTask: [] };

  const runs = all
    .filter((r) => inRange(r, range))
    .map(runRow)
    .sort((a, z) => String(z.startedAt).localeCompare(String(a.startedAt)));

  return { ...base, runs, byTask: groupByTask(runs) };
}
