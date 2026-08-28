import fs from 'node:fs';
import path from 'node:path';
import { LOCAL_AGENT_DIR } from './config.js';
import { isBillable, readLines, textOf } from './parser.js';
import { billableParts, costOf, hasRates, tokensOf } from './pricing.js';

/**
 * Spend that neither ccusage nor the main analysis can see.
 *
 * The desktop app's local agent mode — the scheduled tasks you set up in the UI —
 * keeps its transcripts under %APPDATA%\claude\local-agent-mode-sessions, not in
 * CLAUDE_PROJECTS_DIR. ccusage does not read that root either: our claude-only
 * total reconciles to `ccusage daily` to the cent while these runs sit outside
 * both. Verified on this machine: of 483 message ids here, 0 also appear in
 * ~/.claude/projects, so nothing here is a duplicate of the counted corpus.
 *
 * Deliberately kept OUT of the global total: the reconciliation gate compares our
 * number against ccusage's, and folding in spend ccusage cannot see would turn
 * that gate into permanent noise. It is reported as its own figure instead.
 */

/**
 * Every run writes its messages twice — once to `audit.jsonl`, once to the
 * nested `.claude/projects/**` transcript — and the audit copy carries no
 * `requestId`, so the shared dedupKey() would fall back to uuid and count both.
 * `message.id` is present on every line of both copies and is stable across
 * them, so it is the key here. (Left local to this module: the main corpus has
 * no id-without-requestId lines, and loosening the shared key there could
 * collapse genuinely distinct retries.)
 */
const keyOf = (line) => (line.message?.id ? `id:${line.message.id}` : `uuid:${line.uuid}`);

/** Automated runs open with `<scheduled-task name="…" …>`. */
const SCHEDULED_TASK_RE = /<scheduled-task\s+name="([^"]+)"/;
const MANUAL = '（手動執行）';

/** The `local_<uuid>` directory that identifies one scheduled-task run. */
const RUN_DIR_PREFIX = 'local_';
const AUDIT_FILE = 'audit.jsonl';
const JSONL_EXT = '.jsonl';
const UNKNOWN_RUN = '(unknown)';

/** Enough of the prompt to recognise the run by, in a table cell. */
const PROMPT_LABEL_CHARS = 90;

/**
 * Subdirectories of `dir`, or [] when there are none.
 *
 * ENOENT is expected everywhere here — most machines have no local agent mode,
 * and a run need not have a `.claude/projects`. Anything else (a permission
 * error, a exhausted handle table) is NOT expected, and swallowing it turns
 * "I could not read this" into "there is nothing here", which silently removes
 * the whole feature from the dashboard. Observed exactly that: one long-running
 * server reported 0 runs while a fresh one on the same path reported 16.
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
 * What the last scan actually saw, reported in the payload.
 *
 * Without this, every failure mode collapses into the same blank card and the
 * only way to tell them apart is to attach a debugger to a machine you may not
 * have. `rootEntries: 0` means the root is not there (or not readable as a
 * directory); `files: 32, filesRead: 0` means we found the transcripts and
 * could not open them — two completely different problems, one glance apart.
 *
 * `readErrors` is our own collector, kept out of parser.js's module-level one:
 * that array belongs to the transcript analysis and gets memoized into it, so a
 * failure here used to surface on the health card as if ~/.claude/projects had
 * failed to read.
 */
const emptyScan = () => ({ rootEntries: 0, files: 0, filesRead: 0, billableLines: 0, readErrors: [] });
let lastScan = emptyScan();

/**
 * The two spots a run keeps transcripts, both verified on this machine (16 files
 * each, no other shape):
 *   <run>/audit.jsonl
 *   <run>/.claude/projects/<encoded-cwd>/<sid>.jsonl
 *
 * Enumerated rather than walked on purpose: each run also carries a copy of the
 * skill bundles (docx/pptx/xlsx), so a recursive walk crosses ~430 directories
 * and costs ~85ms — on every request, since this runs behind /api/overview.
 * Reaching straight for the two known spots costs ~2ms.
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

/** The `local_*` run directories under the root, across every workspace and conversation. */
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

/** The `local_<uuid>` path segment identifies one scheduled-task run. */
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

/* ── parsing ──────────────────────────────────────────────────────────────── */

const emptyTokens = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });

/** Cost and tokens of one billable line, skipping any part we cannot price. */
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
 * Name a run from its first human-visible user line.
 *
 * Automated runs open with the task envelope; the ones you set up by hand open
 * with what you typed. Both are worth naming in the UI, so the first of each
 * kind wins and later lines do not overwrite it.
 */
function noteUserLine(meta, line) {
  if (line.type !== 'user' || line.isMeta || line.isSidechain) return;
  const text = (textOf(line.message?.content) ?? '').trim();
  if (!text) return;
  meta.task ??= SCHEDULED_TASK_RE.exec(text)?.[1] ?? null;
  meta.prompt ??= text.replace(/\s+/g, ' ').slice(0, PROMPT_LABEL_CHARS);
}

/**
 * Read every transcript once: the priced messages keyed for dedup, and the
 * per-run naming metadata.
 *
 * Messages are priced at the larger of the two recorded copies — they differ on
 * 443 of 478 shared messages because each copy is written while the response is
 * still streaming, and the complete one is the one that was billed.
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

/** Deduped messages folded into one entry per run, oldest run first. */
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

/** One entry per run: { run, day, firstTs, cost, tokens, messages, task, prompt, models }. */
function parseRuns() {
  const files = transcriptFiles();
  const fp = fingerprint(files);
  if (memo && memo.fp === fp) {
    // A cache hit skips the read loop, so carry its counts forward — otherwise a
    // perfectly healthy memo hit reports "files found, none read".
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

/* ── payloads ─────────────────────────────────────────────────────────────── */

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
 * parseRuns() behind one guard, for both public entry points.
 *
 * dirsIn rethrows anything that is not ENOENT, and this used to run twice per
 * detail request — once via localAgentSpend() and once outside any try/catch —
 * so a directory disappearing between the two turned a reportable
 * { available: false, error } payload into an unhandled 500.
 */
function tryParseRuns() {
  try {
    return { runs: parseRuns(), error: null };
  } catch (err) {
    return { runs: null, error: err.message };
  }
}

/** Inclusive day-range filter, on the day a run started. */
const inRange = (run, { since, until } = {}) =>
  (!since || (run.day && run.day >= since)) && (!until || (run.day && run.day <= until));

/**
 * Range-filtered rollup for the overview card. `available` is false when this
 * machine has no local-agent transcripts at all, so the UI can drop the card
 * rather than show a permanent $0.00 — but a read failure must NOT look like
 * that, or the card vanishes and takes the explanation with it. It surfaces as
 * `error` instead, and nothing is cached, so the next request retries.
 */
export function localAgentSpend(range = {}) {
  const { runs, error } = tryParseRuns();
  return error === null ? spendFrom(runs, range) : spendError(error);
}

/** The rollup itself, split out so localAgentDetail can share one parseRuns(). */
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
    // Unfiltered, so an empty range can point at where the data actually is.
    totalCost: sum(all, 'cost'),
    totalRuns: all.length,
    dataDir: LOCAL_AGENT_DIR,
    scan: lastScan,
  };
}

/** One run as the detail tab shows it, newest first. */
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
 * Runs grouped by scheduled task.
 *
 * Grouping by task is the point: one row per `<scheduled-task name>` answers
 * "what is this thing costing me per day", which is the only actionable
 * question here — these runs fire unattended and nobody is watching them.
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

/** Per-run detail for the local agent tab, grouped by scheduled task. */
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
