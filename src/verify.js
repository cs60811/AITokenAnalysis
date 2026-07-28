/**
 * Reconciliation gate. Run with `npm run verify`.
 *
 * Every expected value here was measured against real data during design; they are
 * regression anchors, not guesses. If ccusage changes its behaviour or the parser
 * drifts, these fail loudly rather than quietly mis-reporting money.
 */
import { analyzeAll, analyzeSession } from './attribute.js';
import { discoverSessions } from './discover.js';
import { dedupKey, isBillable, isRealPrompt, readLines } from './parser.js';
import { costOf, initPricing, pricingStatus } from './pricing.js';
import * as ccusage from './ccusage.js';
import { modelTotalsFromDaily } from './ccusage.js';
import { RECONCILE_TOLERANCE_PCT, UNATTRIBUTED_TOLERANCE_PCT } from './config.js';

const ANCHOR_SID = 'ced37f19-77c0-4ada-9154-85f2df4f4d4e';

let failures = 0;
const check = (pass, label, detail = '') => {
  if (!pass) failures++;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

const near = (a, b, tol) => Math.abs(a - b) <= tol;

async function main() {
  const st = await initPricing();
  const ps = pricingStatus();
  console.log(`pricing: source=${ps.source} models=${ps.modelCount} age=${ps.ageDays ?? '-'}d${ps.error ? ` (${ps.error})` : ''}\n`);
  if (!st.rates) {
    console.log('FATAL: no pricing available; refusing to verify.');
    process.exit(1);
  }

  const sessions = discoverSessions();

  console.log('1. Discovery');
  let main = 0, sub = 0, wf = 0;
  for (const s of sessions.values()) {
    if (s.main) main++;
    sub += s.subagents.length;
    for (const f of s.workflows.values()) wf += f.length;
  }
  check(main + sub + wf > 0, 'found transcripts', `main=${main} subagent=${sub} workflow=${wf}`);
  check(wf > 0, 'workflow tier is present (the tier ccusage session drops)', `${wf} files`);

  console.log('\n2. Cost formula — exact regression vs ccusage (8 dp)');
  const anchor = sessions.get(ANCHOR_SID);
  if (!anchor?.main) {
    check(false, `anchor session ${ANCHOR_SID} present`);
  } else {
    const seen = new Set();
    const by = {};
    let billable = 0;
    for (const l of readLines(anchor.main)) {
      if (!isBillable(l)) continue;
      billable++;
      const k = dedupKey(l);
      if (seen.has(k)) continue;
      seen.add(k);
      by[l.message.model] = (by[l.message.model] ?? 0) + (costOf(l.message.usage, l.message.model) ?? 0);
    }
    check(near(by['claude-opus-4-8'], 85.5287645, 1e-4), 'opus main-only = 85.52876450', `got ${by['claude-opus-4-8']?.toFixed(8)}`);
    check(near(by['claude-sonnet-4-6'], 1.3626735, 1e-4), 'sonnet main-only = 1.36267350', `got ${by['claude-sonnet-4-6']?.toFixed(8)}`);

    console.log('\n3. Dedup invariant');
    check(seen.size === 249, 'anchor main dedups to 249 unique messages', `${billable} billable -> ${seen.size}`);
  }

  console.log('\n4. Prompt classifier');
  let strUser = 0, real = 0;
  for (const s of sessions.values()) {
    if (!s.main) continue;
    for (const l of readLines(s.main)) {
      if (l.type === 'user' && typeof l.message?.content === 'string') strUser++;
      if (isRealPrompt(l)) real++;
    }
  }
  check(real > 0 && real < strUser, 'classifier drops machine-generated prompts', `${real}/${strUser} kept (${(100 - (real / strUser) * 100).toFixed(0)}% noise)`);

  console.log('\n5. Tier split on the anchor session');
  const a = analyzeSession(anchor);
  // Re-baselined when streamed messages started being counted at their final
  // usage: the anchor's agent files hold partial writes, so subagent (+$0.04)
  // and workflow (+$3.51) both grew. ownCost is unchanged — this June session
  // predates the advisor tier and its main transcript has no partial writes.
  check(near(a.ownCost, 86.89144, 0.01), 'ownCost = 86.89 (main only)', `$${a.ownCost.toFixed(5)}`);
  check(near(a.ccusageCost, 87.44705, 0.01), 'ccusageCost = 87.45 (main + subagents)', `$${a.ccusageCost.toFixed(5)}`);
  check(near(a.trueCost, 116.16848, 0.01), 'trueCost = 116.17 (incl. workflow)', `$${a.trueCost.toFixed(5)}`);
  check(a.workflowCost > 25, 'workflow tier carries the hidden spend', `$${a.workflowCost.toFixed(5)} (${((a.workflowCost / a.trueCost) * 100).toFixed(0)}% of session)`);

  const all = analyzeAll(sessions);

  console.log('\n6. Unattributed cost');
  let un = 0, total = 0;
  for (const s of all) {
    total += s.trueCost;
    const u = s.turns.find((t) => t.promptId === '__unattributed__');
    if (u) un += u.trueCost;
  }
  const unPct = total ? (un / total) * 100 : 0;
  check(unPct < UNATTRIBUTED_TOLERANCE_PCT, `unattributed < ${UNATTRIBUTED_TOLERANCE_PCT}%`, `${unPct.toFixed(2)}% ($${un.toFixed(2)})`);

  console.log('\n7. Global reconciliation vs live ccusage  [GATE]');
  try {
    // Snapshot ccusage fresh each run: totals drift as new usage lands.
    const totals = modelTotalsFromDaily(await ccusage.daily());
    const ours = all.reduce((s, x) => s + x.trueCost, 0);
    const delta = Math.abs(ours - totals.claudeCost);
    const pct = totals.claudeCost ? (delta / totals.claudeCost) * 100 : 0;
    console.log(`     ours (claude, incl. workflow): $${ours.toFixed(2)}`);
    console.log(`     ccusage daily (claude-only):   $${totals.claudeCost.toFixed(2)}`);
    console.log(`     other agents (ccusage only):   $${totals.otherCost.toFixed(2)}`);
    check(pct <= RECONCILE_TOLERANCE_PCT, `within ${RECONCILE_TOLERANCE_PCT}%`, `delta $${delta.toFixed(2)} = ${pct.toFixed(2)}%`);
  } catch (err) {
    check(false, 'ccusage reachable', `${err.kind ?? 'error'}: ${err.message}`);
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('verify crashed:', err);
  process.exit(1);
});
