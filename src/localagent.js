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
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [];
    throw err;
  }
};

/**
 * Transcripts sit at exactly two spots under each run, both verified on this
 * machine (16 files each, no other shape):
 *   <workspace>/<conversation>/local_<id>/audit.jsonl
 *   <workspace>/<conversation>/local_<id>/.claude/projects/<encoded-cwd>/<sid>.jsonl
 *
 * Enumerated rather than walked on purpose: each run also carries a copy of the
 * skill bundles (docx/pptx/xlsx), so a recursive walk crosses ~430 directories
 * and costs ~85ms — on every request, since this runs behind /api/overview.
 * Reaching straight for the two known spots costs ~2ms.
 */
/**
 * What the last scan actually saw, reported in the payload.
 *
 * Without this, every failure mode collapses into the same blank card and the
 * only way to tell them apart is to attach a debugger to a machine you may not
 * have. `rootEntries: 0` means the root is not there (or not readable as a
 * directory); `files: 32, filesRead: 0` means we found the transcripts and
 * could not open them — two completely different problems, one glance apart.
 */
let lastScan = { rootEntries: 0, files: 0, filesRead: 0, billableLines: 0 };

function transcriptFiles() {
  const out = [];
  const roots = dirsIn(LOCAL_AGENT_DIR);
  lastScan = { rootEntries: roots.length, files: 0, filesRead: 0, billableLines: 0 };
  for (const workspace of roots) {
    for (const conversation of dirsIn(workspace)) {
      for (const run of dirsIn(conversation)) {
        if (!path.basename(run).startsWith('local_')) continue;
        const audit = path.join(run, 'audit.jsonl');
        if (fs.existsSync(audit)) out.push(audit);
        for (const project of dirsIn(path.join(run, '.claude', 'projects'))) {
          for (const f of fs.readdirSync(project)) if (f.endsWith('.jsonl')) out.push(path.join(project, f));
        }
      }
    }
  }
  lastScan.files = out.length;
  return out;
}

/** The `local_<uuid>` path segment identifies one scheduled-task run. */
const runOf = (file) =>
  path.relative(LOCAL_AGENT_DIR, file).split(path.sep).find((s) => s.startsWith('local_')) ?? '(unknown)';

const dayOf = (iso) => (iso ? String(iso).slice(0, 10) : null);

let memo = null; // { fp, runs }

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

/**
 * One entry per run: { run, day, firstTs, cost, tokens, messages }.
 * Messages are priced at the larger of the two recorded copies — they differ on
 * 443 of 478 shared messages because each copy is written while the response is
 * still streaming, and the complete one is the one that was billed.
 */
function parseRuns() {
  const files = transcriptFiles();
  const fp = fingerprint(files);
  if (memo && memo.fp === fp) {
    // A cache hit skips the read loop, so carry its counts forward — otherwise a
    // perfectly healthy memo hit reports "files found, none read".
    lastScan.filesRead = memo.scan.filesRead;
    lastScan.billableLines = memo.scan.billableLines;
    return memo.runs;
  }

  const byKey = new Map();
  const meta = new Map(); // run -> { task, prompt, models }
  for (const file of files) {
    const run = runOf(file);
    const lines = readLines(file);
    if (lines.length) lastScan.filesRead++;
    for (const line of lines) {
      const info = meta.get(run) ?? { task: null, prompt: null, models: new Set() };
      meta.set(run, info);
      if (line.type === 'user' && !line.isMeta && !line.isSidechain) {
        const t = (textOf(line.message?.content) ?? '').trim();
        if (t) {
          // Automated runs open with the task envelope; the ones you set up by
          // hand open with what you typed. Both are worth naming in the UI.
          info.task ??= SCHEDULED_TASK_RE.exec(t)?.[1] ?? null;
          info.prompt ??= t.replace(/\s+/g, ' ').slice(0, 90);
        }
      }
      if (!isBillable(line)) continue;
      lastScan.billableLines++;
      info.models.add(line.message.model);
      const k = keyOf(line);
      let cost = 0;
      const tk = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
      for (const part of billableParts(line.message.usage, line.message.model)) {
        if (!hasRates(part.model)) continue;
        cost += costOf(part.usage, part.model) ?? 0;
        const t = tokensOf(part.usage);
        tk.input += t.input;
        tk.output += t.output;
        tk.cacheWrite += t.cacheWrite5m + t.cacheWrite1h;
        tk.cacheRead += t.cacheRead;
      }
      const prev = byKey.get(k);
      if (!prev || cost > prev.cost) byKey.set(k, { run, ts: line.timestamp ?? prev?.ts ?? null, cost, tokens: tk });
    }
  }

  const runs = new Map();
  for (const m of byKey.values()) {
    const r = runs.get(m.run) ?? { run: m.run, firstTs: m.ts, cost: 0, messages: 0, tokens: 0 };
    r.cost += m.cost;
    r.messages++;
    r.tokens += m.tokens.input + m.tokens.output + m.tokens.cacheWrite + m.tokens.cacheRead;
    if (m.ts && (!r.firstTs || m.ts < r.firstTs)) r.firstTs = m.ts;
    runs.set(m.run, r);
  }

  const list = [...runs.values()]
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
  memo = { fp, runs: list, scan: { filesRead: lastScan.filesRead, billableLines: lastScan.billableLines } };
  return list;
}

/**
 * Range-filtered rollup for the overview card. `available` is false when this
 * machine has no local-agent transcripts at all, so the UI can drop the card
 * rather than show a permanent $0.00 — but a read failure must NOT look like
 * that, or the card vanishes and takes the explanation with it. It surfaces as
 * `error` instead, and nothing is cached, so the next request retries.
 */
/**
 * Per-run detail for the local agent tab, grouped by scheduled task.
 *
 * Grouping by task is the point: one row per `<scheduled-task name>` answers
 * "what is this thing costing me per day", which is the only actionable
 * question here — these runs fire unattended and nobody is watching them.
 */
export function localAgentDetail({ since, until } = {}) {
  const base = localAgentSpend({ since, until });
  if (!base.available || base.error) return { ...base, runs: [], byTask: [] };

  const runs = parseRuns()
    .filter((r) => (!since || (r.day && r.day >= since)) && (!until || (r.day && r.day <= until)))
    .map((r) => ({
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
    }))
    .sort((a, z) => String(z.startedAt).localeCompare(String(a.startedAt)));

  const byTask = new Map();
  for (const r of runs) {
    const t = byTask.get(r.task) ?? { task: r.task, scheduled: r.scheduled, runs: 0, cost: 0, tokens: 0, lastRun: null, models: new Set() };
    t.runs++;
    t.cost += r.cost;
    t.tokens += r.tokens;
    if (!t.lastRun || String(r.startedAt) > String(t.lastRun)) t.lastRun = r.startedAt;
    for (const m of r.models) t.models.add(m);
    byTask.set(r.task, t);
  }

  return {
    ...base,
    runs,
    byTask: [...byTask.values()]
      .map((t) => ({ ...t, models: [...t.models].sort(), avgCost: t.runs ? t.cost / t.runs : 0 }))
      .sort((a, z) => z.cost - a.cost),
  };
}

export function localAgentSpend({ since, until } = {}) {
  let all;
  try {
    all = parseRuns();
  } catch (err) {
    return { available: false, error: err.message, cost: 0, runs: 0, tokens: 0, firstDay: null, lastDay: null, dataDir: LOCAL_AGENT_DIR, scan: lastScan };
  }
  const runs = all.filter((r) => (!since || (r.day && r.day >= since)) && (!until || (r.day && r.day <= until)));
  return {
    available: all.length > 0,
    error: null,
    cost: runs.reduce((s, r) => s + r.cost, 0),
    runs: runs.length,
    tokens: runs.reduce((s, r) => s + r.tokens, 0),
    firstDay: all[0]?.day ?? null,
    lastDay: all[all.length - 1]?.day ?? null,
    // Unfiltered, so an empty range can point at where the data actually is.
    totalCost: all.reduce((s, r) => s + r.cost, 0),
    totalRuns: all.length,
    dataDir: LOCAL_AGENT_DIR,
    scan: lastScan,
  };
}
