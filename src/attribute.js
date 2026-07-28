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
const TASK_ID_RE = /<task-id>\s*([^<\s]+)\s*<\/task-id>/;

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
 * Sum the cost of an agent transcript (a subagent or workflow-agent file).
 * `seen` is shared across the whole session so a message counted in one file is
 * never counted again in another.
 */
function costOfAgentFile(file, seen) {
  let cost = 0;
  const tokens = emptyTokens();
  const byModel = [];
  const unpriced = new Set();

  const lines = readLines(file);
  const finalUsage = finalUsageByKey(lines);

  for (const line of lines) {
    if (!isBillable(line)) continue;
    const key = dedupKey(line);
    if (seen.has(key)) continue;
    seen.add(key);

    for (const part of billableParts(finalUsage.get(key), line.message.model)) {
      const tk = tokensOf(part.usage);
      addTokens(tokens, tk);
      if (!hasRates(part.model)) {
        unpriced.add(part.model);
        continue;
      }
      const c = costOf(part.usage, part.model) ?? 0;
      cost += c;
      byModel.push([part.model, c, tk]);
    }
  }
  return { cost, tokens, byModel, unpriced };
}

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
 * `seen` must be shared across every session (see analyzeAll): resuming a session
 * replays the earlier conversation into the new transcript, so 592 messages worth
 * $133.64 appear in two files each. Deduping only within a session double-counts
 * them and inflates the total by 14%.
 */
export function analyzeSession(session, seen = new Set()) {
  const mainLines = session.main ? readLines(session.main) : [];

  const byUuid = new Map();
  for (const l of mainLines) if (l.uuid) byUuid.set(l.uuid, l);

  // Walk up parentUuid until we hit the real prompt that owns this line.
  const ownerCache = new Map();
  function ownerPromptOf(uuid) {
    const chain = [];
    let cur = uuid;
    while (cur) {
      if (ownerCache.has(cur)) break;
      const line = byUuid.get(cur);
      if (!line) {
        cur = null;
        break;
      }
      chain.push(cur);
      if (isRealPrompt(line)) break;
      cur = line.parentUuid ?? null;
    }
    const owner = cur && ownerCache.has(cur) ? ownerCache.get(cur) : cur;
    for (const u of chain) ownerCache.set(u, owner);
    return owner ?? null;
  }

  /** @type {Map<string, any>} */
  const turns = new Map();
  const order = [];
  for (const l of mainLines) {
    if (!isRealPrompt(l)) continue;
    const text = promptTextOf(l);
    turns.set(l.uuid, {
      promptId: l.uuid,
      sessionId: session.sessionId,
      text,
      snippet: snippet(text),
      timestamp: l.timestamp ?? null,
      cwd: l.cwd ?? null,
      gitBranch: l.gitBranch ?? null,
      ...newBucket(),
    });
    order.push(l.uuid);
  }
  turns.set(UNATTRIBUTED, {
    promptId: UNATTRIBUTED,
    sessionId: session.sessionId,
    text: '(未能歸因至任何 prompt)',
    snippet: '(未能歸因至任何 prompt)',
    timestamp: null,
    cwd: null,
    gitBranch: null,
    ...newBucket(),
  });

  const sessionBucket = newBucket();
  let cwd = null;
  let gitBranch = null;
  let lastActivity = null;

  // 1) main-transcript cost -> ownCost of the owning turn
  const finalUsage = finalUsageByKey(mainLines);
  for (const line of mainLines) {
    cwd ??= line.cwd ?? null;
    gitBranch ??= line.gitBranch ?? null;
    if (line.timestamp && (!lastActivity || line.timestamp > lastActivity)) {
      lastActivity = line.timestamp;
    }
    if (!isBillable(line)) continue;

    const key = dedupKey(line);
    if (seen.has(key)) continue;
    seen.add(key);

    const owner = ownerPromptOf(line.uuid) ?? UNATTRIBUTED;
    const turn = turns.get(owner) ?? turns.get(UNATTRIBUTED);

    for (const { model, usage } of billableParts(finalUsage.get(key), line.message.model)) {
      const tk = tokensOf(usage);
      addTokens(turn.tokens, tk);
      addTokens(sessionBucket.tokens, tk);
      if (!hasRates(model)) {
        turn.unpricedModels.add(model);
        sessionBucket.unpricedModels.add(model);
        continue;
      }
      const c = costOf(usage, model) ?? 0;
      turn.ownCost += c;
      sessionBucket.ownCost += c;
      addToModel(turn, model, c, tk);
      addToModel(sessionBucket, model, c, tk);
    }
  }

  // 2) index the main-file lines that identify spawned agents.
  //
  // Store the raw walk result, null included: writing UNATTRIBUTED into the map
  // would make the `??` fallbacks below dead code for exactly the agents that
  // need them — the key is present, it just holds the sentinel. isTurn() tests
  // for a live turn instead.
  const turnByAgentId = new Map();
  const turnByRunId = new Map();
  const turnByTaskId = new Map();
  for (const line of mainLines) {
    const r = line.toolUseResult;
    if (r && typeof r === 'object') {
      const owner = ownerPromptOf(line.uuid);
      if (r.agentId) turnByAgentId.set(r.agentId, owner);
      if (r.runId) turnByRunId.set(r.runId, owner);
    }
    // A background task announces its agent id in a <task-notification>. Only
    // the copies that carry a uuid are usable — the same text also lands on
    // `type: "queue-operation"` lines, which have neither uuid nor parentUuid
    // and so have no position in the tree to walk up from.
    if (!line.uuid) continue;
    const txt = textOf(line.message?.content);
    if (!txt?.includes('<task-notification>')) continue;
    const m = TASK_ID_RE.exec(txt);
    if (m && !turnByTaskId.has(m[1])) turnByTaskId.set(m[1], ownerPromptOf(line.uuid));
  }

  const isTurn = (id) => id != null && id !== UNATTRIBUTED && turns.has(id);
  const ownerOfAgent = (id, index) => {
    const direct = index.get(id);
    if (isTurn(direct)) return direct;
    const viaTask = turnByTaskId.get(id);
    return isTurn(viaTask) ? viaTask : UNATTRIBUTED;
  };

  const applyAgentCost = (owner, field, res) => {
    const turn = turns.get(owner) ?? turns.get(UNATTRIBUTED);
    turn[field] += res.cost;
    sessionBucket[field] += res.cost;
    addTokens(turn.tokens, res.tokens);
    addTokens(sessionBucket.tokens, res.tokens);
    for (const [model, c, tk] of res.byModel) {
      addToModel(turn, model, c, tk);
      addToModel(sessionBucket, model, c, tk);
    }
    for (const m of res.unpriced) {
      turn.unpricedModels.add(m);
      sessionBucket.unpricedModels.add(m);
    }
  };

  // 3) plain subagents -> subagentCost (this tier IS counted by ccusage)
  for (const file of session.subagents) {
    const agentId = path.basename(file).replace(/^agent-/, '').replace(/\.jsonl$/, '');
    applyAgentCost(ownerOfAgent(agentId, turnByAgentId), 'subagentCost', costOfAgentFile(file, seen));
  }

  // 4) workflow agents -> workflowCost (this tier is what ccusage session drops)
  for (const [runId, files] of session.workflows) {
    const owner = ownerOfAgent(runId, turnByRunId);
    for (const file of files) {
      applyAgentCost(owner, 'workflowCost', costOfAgentFile(file, seen));
    }
  }

  const finish = (b, extra = {}) => {
    const ccusageCost = b.ownCost + b.subagentCost;
    return {
      ...extra,
      ownCost: b.ownCost,
      subagentCost: b.subagentCost,
      workflowCost: b.workflowCost,
      ccusageCost,
      trueCost: ccusageCost + b.workflowCost,
      tokens: b.tokens,
      totalTokens:
        b.tokens.input +
        b.tokens.output +
        b.tokens.cacheWrite5m +
        b.tokens.cacheWrite1h +
        b.tokens.cacheRead,
      byModel: [...b.byModel.entries()]
        .map(([model, v]) => ({ model, cost: v.cost, tokens: v.tokens }))
        .sort((a, z) => z.cost - a.cost),
      unpricedModels: [...b.unpricedModels],
    };
  };

  const turnList = [...order, UNATTRIBUTED]
    .map((id) => {
      const t = turns.get(id);
      return finish(t, {
        promptId: t.promptId,
        sessionId: t.sessionId,
        text: t.text,
        snippet: t.snippet,
        timestamp: t.timestamp,
        gitBranch: t.gitBranch,
      });
    })
    .filter((t) => t.promptId !== UNATTRIBUTED || t.trueCost > 0 || t.totalTokens > 0);

  const projectLabel = cwd ? path.basename(cwd) : session.projectLabel;

  return finish(sessionBucket, {
    sessionId: session.sessionId,
    projectLabel,
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
    startOf.set(s, (s.main ? firstTimestamp(s.main) : null) ?? '9999');
  }
  live.sort((a, z) => String(startOf.get(a)).localeCompare(String(startOf.get(z))));

  const seen = new Set();
  const out = live.map((s) => analyzeSession(s, seen));
  out.sort((a, z) => z.trueCost - a.trueCost);
  return out;
}

export { UNATTRIBUTED, allFilesOf };
