import path from 'node:path';
import { billableParts, costOf, hasRates, tokensOf } from './pricing.js';
import {
  dedupKey,
  finalUsageByKey,
  firstTimestamp,
  isBillable,
  isRealPrompt,
  promptTextOf,
  readLines,
  snippet,
  textOf,
} from './parser.js';
import { allFilesOf } from './discover.js';

const UNATTRIBUTED = '__unattributed__';
const UNATTRIBUTED_TEXT = '(未能歸因至任何 prompt)';
const TASK_ID_RE = /<task-id>\s*([^<\s]+)\s*<\/task-id>/;

/** Agent transcripts are named `agent-<agentId>.jsonl`; the id is the middle. */
const AGENT_FILE_PREFIX_RE = /^agent-/;
const JSONL_EXT_RE = /\.jsonl$/;
const agentIdOf = (file) => path.basename(file).replace(AGENT_FILE_PREFIX_RE, '').replace(JSONL_EXT_RE, '');

/**
 * Sort key for a session whose main transcript carries no timestamp at all.
 * Sorts after every real ISO date, so an undateable session is processed last
 * and therefore never takes a replayed message off a session that can be dated.
 */
const NO_TIMESTAMP_SORT_KEY = '9999';

/* ── buckets ──────────────────────────────────────────────────────────────── */

function emptyTokens() {
  return { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
}

function addTokens(dst, src) {
  for (const k of Object.keys(dst)) dst[k] += src[k] ?? 0;
}

function newBucket() {
  return {
    ownCost: 0,
    subagentCost: 0,
    workflowCost: 0,
    tokens: emptyTokens(),
    byModel: new Map(), // model -> { cost, tokens }
    unpricedModels: new Set(),
  };
}

function addToModel(bucket, model, cost, tokens) {
  let m = bucket.byModel.get(model);
  if (!m) {
    m = { cost: 0, tokens: emptyTokens() };
    bucket.byModel.set(model, m);
  }
  m.cost += cost ?? 0;
  addTokens(m.tokens, tokens);
}

/**
 * Price one billable part into every bucket in `into`, under the tier `field`.
 *
 * An unpriced model contributes its TOKENS and its name, never a dollar and
 * never a byModel row: the UI renders "—" for it, and a $0 row would read as
 * free work rather than as work we cannot price. This is the single place that
 * rule lives — the main-transcript loop and the agent-file loop used to carry a
 * copy each.
 */
function addPart(into, field, model, usage) {
  const tokens = tokensOf(usage);
  const priced = hasRates(model);
  const cost = priced ? costOf(usage, model) ?? 0 : 0;
  for (const bucket of into) {
    addTokens(bucket.tokens, tokens);
    if (!priced) {
      bucket.unpricedModels.add(model);
      continue;
    }
    bucket[field] += cost;
    addToModel(bucket, model, cost, tokens);
  }
}

/**
 * Fold a whole agent transcript's totals into each bucket in `into`, as `field`.
 *
 * An agent file accumulates into its own `ownCost` — it is that agent's own
 * spend. Which TIER it belongs to (subagent vs workflow) is the caller's
 * decision about where the file was found, not a property of the file.
 */
function mergeBucket(into, field, src) {
  for (const dst of into) {
    dst[field] += src.ownCost;
    addTokens(dst.tokens, src.tokens);
    for (const [model, v] of src.byModel) addToModel(dst, model, v.cost, v.tokens);
    for (const m of src.unpricedModels) dst.unpricedModels.add(m);
  }
}

/* ── reading transcripts ──────────────────────────────────────────────────── */

/**
 * Every billable (model, usage) part in `lines` that no earlier file has claimed.
 *
 * Claiming is destructive by design: `seen` grows as we yield, and it is shared
 * across every file and every session (see analyzeAll). Resuming a session
 * replays the earlier conversation into the new transcript, so 592 messages
 * worth $133.64 appear in two files each; without one shared set the total
 * inflates by 14%.
 *
 * Iteration order is load-bearing — whoever is iterated first keeps a replayed
 * message — so callers must not reorder files or lines around this.
 *
 * finalUsageByKey is built per file: only the last write of a streamed message
 * is complete, and it is the one ccusage counts. The FIRST occurrence is what
 * gets yielded, so the parentUuid chain that assigns cost to a turn stays intact.
 */
function* claimBillableParts(lines, seen) {
  const finalUsage = finalUsageByKey(lines);
  for (const line of lines) {
    if (!isBillable(line)) continue;
    const key = dedupKey(line);
    if (seen.has(key)) continue;
    seen.add(key);
    for (const part of billableParts(finalUsage.get(key), line.message.model)) {
      yield { line, model: part.model, usage: part.usage };
    }
  }
}

/** One agent transcript (subagent or workflow) as a bucket of its own spend. */
function bucketOfAgentFile(file, seen) {
  const bucket = newBucket();
  for (const { model, usage } of claimBillableParts(readLines(file), seen)) {
    addPart([bucket], 'ownCost', model, usage);
  }
  return bucket;
}

/**
 * Session-level facts, read from EVERY line — including lines that are not
 * billable and lines a previous session already claimed. A deduped message
 * still tells us when the session was last active and where it ran.
 */
function scanSessionMeta(lines) {
  let cwd = null;
  let gitBranch = null;
  let lastActivity = null;
  for (const line of lines) {
    cwd ??= line.cwd ?? null;
    gitBranch ??= line.gitBranch ?? null;
    if (line.timestamp && (!lastActivity || line.timestamp > lastActivity)) {
      lastActivity = line.timestamp;
    }
  }
  return { cwd, gitBranch, lastActivity };
}

/* ── turns ────────────────────────────────────────────────────────────────── */

function newTurn({ promptId, sessionId, text, timestamp = null, cwd = null, gitBranch = null }) {
  return { promptId, sessionId, text, snippet: snippet(text), timestamp, cwd, gitBranch, ...newBucket() };
}

/**
 * One turn per real user prompt, in transcript order, plus the UNATTRIBUTED
 * catch-all. `order` preserves transcript order for the caller; the map is what
 * the cost loops look owners up in.
 */
function mintTurns(session, mainLines) {
  const turns = new Map();
  const order = [];
  for (const line of mainLines) {
    if (!isRealPrompt(line)) continue;
    turns.set(
      line.uuid,
      newTurn({
        promptId: line.uuid,
        sessionId: session.sessionId,
        text: promptTextOf(line),
        timestamp: line.timestamp ?? null,
        cwd: line.cwd ?? null,
        gitBranch: line.gitBranch ?? null,
      }),
    );
    order.push(line.uuid);
  }
  turns.set(UNATTRIBUTED, newTurn({ promptId: UNATTRIBUTED, sessionId: session.sessionId, text: UNATTRIBUTED_TEXT }));
  return { turns, order };
}

/**
 * Resolve the real prompt that owns a line, by walking parentUuid up the tree.
 *
 * Memoizes the whole walked chain, a null result included: an unreachable line
 * stays unreachable rather than being re-walked, and that null is exactly what
 * the `??` fallbacks in buildAgentIndexes' consumers depend on.
 */
function createOwnerResolver(byUuid) {
  const cache = new Map();
  return function ownerPromptOf(uuid) {
    const chain = [];
    let cur = uuid;
    while (cur) {
      if (cache.has(cur)) break;
      const line = byUuid.get(cur);
      if (!line) {
        cur = null;
        break;
      }
      chain.push(cur);
      if (isRealPrompt(line)) break;
      cur = line.parentUuid ?? null;
    }
    const owner = cur && cache.has(cur) ? cache.get(cur) : cur;
    for (const u of chain) cache.set(u, owner);
    return owner ?? null;
  };
}

/**
 * The main-file lines that name a spawned agent, indexed by the three ids that
 * link one back to the turn that spawned it.
 *
 * Stores the raw walk result, null included: writing UNATTRIBUTED in would make
 * the `??` fallbacks in ownerOfAgent dead code for exactly the agents that need
 * them — the key would be present, just holding the sentinel.
 */
function buildAgentIndexes(mainLines, ownerPromptOf) {
  const byAgentId = new Map();
  const byRunId = new Map();
  const byTaskId = new Map();
  for (const line of mainLines) {
    const r = line.toolUseResult;
    if (r && typeof r === 'object') {
      const owner = ownerPromptOf(line.uuid);
      if (r.agentId) byAgentId.set(r.agentId, owner);
      if (r.runId) byRunId.set(r.runId, owner);
    }
    // A background task announces its agent id in a <task-notification>. Only
    // the copies that carry a uuid are usable — the same text also lands on
    // `type: "queue-operation"` lines, which have neither uuid nor parentUuid
    // and so have no position in the tree to walk up from.
    if (!line.uuid) continue;
    const txt = textOf(line.message?.content);
    if (!txt?.includes('<task-notification>')) continue;
    const m = TASK_ID_RE.exec(txt);
    if (m && !byTaskId.has(m[1])) byTaskId.set(m[1], ownerPromptOf(line.uuid));
  }
  return { byAgentId, byRunId, byTaskId };
}

/** A bucket rendered as the payload the API and UI consume. */
function finishBucket(b, extra = {}) {
  const ccusageCost = b.ownCost + b.subagentCost;
  const t = b.tokens;
  return {
    ...extra,
    ownCost: b.ownCost,
    subagentCost: b.subagentCost,
    workflowCost: b.workflowCost,
    ccusageCost,
    trueCost: ccusageCost + b.workflowCost,
    tokens: t,
    totalTokens: t.input + t.output + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead,
    byModel: [...b.byModel.entries()]
      .map(([model, v]) => ({ model, cost: v.cost, tokens: v.tokens }))
      .sort((a, z) => z.cost - a.cost),
    unpricedModels: [...b.unpricedModels],
  };
}

const TURN_FIELDS = ['promptId', 'sessionId', 'text', 'snippet', 'timestamp', 'gitBranch'];

/* ── the analysis ─────────────────────────────────────────────────────────── */

/**
 * Build the full picture for one session.
 *
 * Attribution model — a prompt costs what it caused:
 *   turn = one real user prompt + every assistant message descending from it via
 *   parentUuid, until the next real prompt. Agents spawned inside that turn roll
 *   their cost up into it.
 *
 * Linkage (all verified on this data):
 *   subagent file  -> its `agentId` appears in a main-file line's toolUseResult.agentId
 *   workflow agent -> its `runId` (the wf_* dir name) appears in toolUseResult.runId
 *   background task -> its id appears as <task-id> in a <task-notification> line
 * In each case that main-file line sits inside a turn, so we walk parentUuid up
 * from it to find the owning prompt.
 *
 * 57 subagent files are named by no toolUseResult.agentId at all — the desktop
 * app enqueues those and never writes the spawning tool_use to the main
 * transcript. The <task-id> route recovers 11 of them. The remaining 47 stay
 * unattributed on purpose: the only thing left that could link them is matching
 * on timestamps, and a guess is worse than an honest gap in a tool whose whole
 * claim is that every dollar is traceable.
 *
 * Two routes that look promising and are NOT (measured, don't re-derive them):
 * the <tool-use-id> inside a task-notification resolves to a real tool_use block
 * for 0 of the 45 unlinked agents that carry one, and `sourceToolAssistantUUID`
 * on the agent file's first line resolves for 0 of 48. Both fail structurally —
 * if that tool_use had reached the main transcript, its tool_result would carry
 * agentId and the first route would already have matched.
 *
 * Costs stay split three ways because `ccusage session` counts only main+subagent
 * and silently drops the workflow tier — on ced37f19 that hides $25.24 (22%).
 *
 * `seen` must be shared across every session (see analyzeAll and
 * claimBillableParts): deduping only within a session double-counts a resumed
 * conversation and inflates the total by 14%.
 */
export function analyzeSession(session, seen = new Set()) {
  const mainLines = session.main ? readLines(session.main) : [];

  const byUuid = new Map();
  for (const l of mainLines) if (l.uuid) byUuid.set(l.uuid, l);
  const ownerPromptOf = createOwnerResolver(byUuid);

  const { turns, order } = mintTurns(session, mainLines);
  const { cwd, gitBranch, lastActivity } = scanSessionMeta(mainLines);
  const sessionBucket = newBucket();
  const turnOf = (id) => turns.get(id) ?? turns.get(UNATTRIBUTED);

  // 1) main-transcript cost -> ownCost of the owning turn
  for (const { line, model, usage } of claimBillableParts(mainLines, seen)) {
    addPart([turnOf(ownerPromptOf(line.uuid) ?? UNATTRIBUTED), sessionBucket], 'ownCost', model, usage);
  }

  // 2) resolve each spawned agent to the turn that spawned it, or to the
  //    sentinel. isTurn() tests for a LIVE turn, because the index deliberately
  //    stores nulls (see buildAgentIndexes).
  const index = buildAgentIndexes(mainLines, ownerPromptOf);
  const isTurn = (id) => id != null && id !== UNATTRIBUTED && turns.has(id);
  const ownerOfAgent = (id, directIndex) => {
    const direct = directIndex.get(id);
    if (isTurn(direct)) return direct;
    const viaTask = index.byTaskId.get(id);
    return isTurn(viaTask) ? viaTask : UNATTRIBUTED;
  };
  const applyAgentFile = (owner, field, file) =>
    mergeBucket([turnOf(owner), sessionBucket], field, bucketOfAgentFile(file, seen));

  // 3) plain subagents -> subagentCost (this tier IS counted by ccusage)
  for (const file of session.subagents) {
    applyAgentFile(ownerOfAgent(agentIdOf(file), index.byAgentId), 'subagentCost', file);
  }

  // 4) workflow agents -> workflowCost (this tier is what ccusage session drops)
  for (const [runId, files] of session.workflows) {
    const owner = ownerOfAgent(runId, index.byRunId);
    for (const file of files) applyAgentFile(owner, 'workflowCost', file);
  }

  const turnList = [...order, UNATTRIBUTED]
    .map((id) => {
      const t = turns.get(id);
      return finishBucket(t, Object.fromEntries(TURN_FIELDS.map((f) => [f, t[f]])));
    })
    .filter((t) => t.promptId !== UNATTRIBUTED || t.trueCost > 0 || t.totalTokens > 0);

  return finishBucket(sessionBucket, {
    sessionId: session.sessionId,
    // basename(cwd) is authoritative; the discovered label is only a guess made
    // from an ambiguous directory encoding (see projectLabelFromDirName).
    projectLabel: cwd ? path.basename(cwd) : session.projectLabel,
    projectPath: cwd,
    gitBranch,
    lastActivity,
    promptCount: order.length,
    workflowRunCount: session.workflows.size,
    agentFileCount: session.subagents.length + [...session.workflows.values()].flat().length,
    turns: turnList,
  });
}

/**
 * Analyze every session with one shared dedup set, oldest session first.
 *
 * Order matters: when a session is resumed, the replayed history appears in both
 * transcripts. Processing chronologically lets the ORIGINAL session keep the cost
 * and gives the resumed one only its genuinely new messages — resuming a session
 * does not spend the money a second time.
 */
export function analyzeAll(sessions) {
  const live = [...sessions.values()].filter(
    (s) => s.main || s.subagents.length || s.workflows.size,
  );

  const startOf = new Map();
  for (const s of live) {
    startOf.set(s, (s.main ? firstTimestamp(s.main) : null) ?? NO_TIMESTAMP_SORT_KEY);
  }
  live.sort((a, z) => String(startOf.get(a)).localeCompare(String(startOf.get(z))));

  const seen = new Set();
  const out = live.map((s) => analyzeSession(s, seen));
  out.sort((a, z) => z.trueCost - a.trueCost);
  return out;
}

export { UNATTRIBUTED, allFilesOf };
