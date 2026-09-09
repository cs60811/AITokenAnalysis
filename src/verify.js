/**
 * 對帳閘門。以 `npm run verify` 執行。
 *
 * 這裡每一個預期值都是設計期間對真實資料實測出來的；它們是迴歸的定錨點，不是猜的。
 * 只要 ccusage 改了行為，或解析器偏掉了，這些檢查會大聲地失敗，
 * 而不是安靜地把金額報錯。
 */
import fs from 'node:fs';
import path from 'node:path';
import { analyzeAll, analyzeSession } from './attribute.js';
import { IGNORED_DIRS, WORKFLOWS_DIR, discoverSessions } from './discover.js';
import { dedupKey, isBillable, isRealPrompt, readLines } from './parser.js';
import { costOf, initPricing, pricingStatus, unknownFastModels } from './pricing.js';
import * as ccusage from './ccusage.js';
import { modelTotalsFromDaily } from './ccusage.js';
import { CLAUDE_PROJECTS_DIR, RECONCILE_TOLERANCE_PCT, UNATTRIBUTED_TOLERANCE_PCT } from './config.js';

const ANCHOR_SID = 'ced37f19-77c0-4ada-9154-85f2df4f4d4e';

let failures = 0;
const check = (pass, label, detail = '') => {
  if (!pass) failures++;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

const near = (a, b, tol) => Math.abs(a - b) <= tol;

/**
 * 磁碟上 `workflows/` 底下真正存在的記錄檔數量。
 *
 * 用來把「這台機器沒跑過 workflow」和「探索邏輯不再認得 workflow 這一層」分開 ——
 * 兩者都會讓計數變成 0，但只有後者是迴歸。
 *
 * 數「檔案」而不是「目錄」，有兩個理由：一個空的 workflows/ 目錄同樣代表沒有執行過
 * （discover.js 的 workflowRunsIn 也是這樣判定的，沒有記錄檔就不算一次執行），
 * 而且有了實際檔數，就能連「探索只找到一部分」都一起抓出來，不只是「完全找不到」。
 * 同樣跳過 IGNORED_DIRS，否則那些目錄底下的東西會被算進來 —— 而 discover 從不掃它們。
 */
function workflowFilesOnDisk(root = CLAUDE_PROJECTS_DIR) {
  let n = 0;
  const walk = (dir, depth, inWorkflows) => {
    if (depth > 5) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 讀不到的目錄無話可說
    }
    for (const e of entries) {
      if (e.isFile()) {
        if (inWorkflows && e.name.endsWith('.jsonl')) n++;
      } else if (e.isDirectory() && !IGNORED_DIRS.has(e.name)) {
        walk(path.join(dir, e.name), depth + 1, inWorkflows || e.name === WORKFLOWS_DIR);
      }
    }
  };
  walk(root, 0, false);
  return n;
}

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
  // 「有沒有 workflow 記錄」是這台機器的狀態，不是程式的性質 —— 保留期會清掉它們，
  // 而且不是每個人都跑 workflow。所以先問磁碟：一個檔案都沒有就 SKIP；
  // 檔案在、我們卻沒有全部讀到，那才是探索邏輯壞了，要大聲地失敗。
  const wfOnDisk = workflowFilesOnDisk();
  if (wf === 0 && wfOnDisk === 0) {
    console.log('  SKIP  no workflow runs on this machine (none on disk); tier untestable here');
  } else {
    check(
      wf > 0 && wf === wfOnDisk,
      'workflow tier is present (the tier ccusage session drops)',
      `${wf} files found, ${wfOnDisk} on disk`,
    );
  }

  console.log('\n2. Cost formula — exact regression vs ccusage (8 dp)');
  const anchor = sessions.get(ANCHOR_SID);
  if (!anchor?.main) {
    // 與第 5 項同一個理由：Claude Code 會依保留期清掉 ~/.claude/projects，所以這個
    // 用 UUID 釘住的 session 終究會消失。它不在，不代表程式錯了，代表這台機器已經
    // 量不到這條迴歸 —— 大聲說出來，但不要用一個永遠修不好的 FAIL 去堵住閘門。
    console.log(`  SKIP  anchor session ${ANCHOR_SID} no longer on disk (retention); cost-formula regression untestable here`);
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
  // Claude Code 會依保留期清理 ~/.claude/projects，所以用 UUID 釘住的 session
  // 終究會消失，每個讀它的檢查也就跑不動了。
  // 選擇跳過而不是直接掛掉 —— 第 2 項檢查已經回報過它不存在了。
  if (!anchor?.main) {
    console.log('  SKIP  anchor session no longer on disk (retention); see check 2');
  } else {
    const a = analyzeSession(anchor);
    // 在「串流訊息改以最終 usage 計算」之後重新定過基準：這個定錨 session 的 agent
    // 檔案裡有部分寫入，所以 subagent（+$0.04）與 workflow（+$3.51）都變大了。
    // ownCost 沒變 —— 這個六月的 session 早於 advisor 層出現，
    // 而且它的主記錄裡沒有任何部分寫入。
    check(near(a.ownCost, 86.89144, 0.01), 'ownCost = 86.89 (main only)', `$${a.ownCost.toFixed(5)}`);
    check(near(a.ccusageCost, 87.44705, 0.01), 'ccusageCost = 87.45 (main + subagents)', `$${a.ccusageCost.toFixed(5)}`);
    check(near(a.trueCost, 116.16848, 0.01), 'trueCost = 116.17 (incl. workflow)', `$${a.trueCost.toFixed(5)}`);
    check(a.workflowCost > 25, 'workflow tier carries the hidden spend', `$${a.workflowCost.toFixed(5)} (${((a.workflowCost / a.trueCost) * 100).toFixed(0)}% of session)`);
  }

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

  console.log('\n7. Pricing coverage');
  // 一則 speed=fast 的訊息若以標準費率計費，就會靜默地少報。
  // costOf() 會把這種模型記錄下來；只有空集合才是健康狀態。
  // 沒有這道防線的話，全域總額會少掉 2.06%（165 則訊息、$33.04）。
  const gaps = unknownFastModels();
  check(gaps.length === 0, 'every speed=fast model has a published premium', gaps.length ? `MISSING: ${gaps.join(', ')}` : `${ps.fastModelCount} models carry a premium`);

  // 完全查不到費率的模型，是比缺加價更嚴重的一級：它整份支出都不見了。
  // addPart() 會照計 token、不計金額，所以那筆錢不是變便宜，是從總額裡消失。
  // 這道檢查以前不存在，於是 `claude-fable-5-1`（LiteLLM 型錄尚未收錄）靜默漏掉
  // $83.08，只表現成第 8 項那個 3.23% 的偏差 —— 一個看不出兇手是誰的百分比。
  const unpriced = new Set();
  for (const s of all) for (const m of s.unpricedModels) unpriced.add(m);
  check(
    unpriced.size === 0,
    'every model in the corpus resolves to rates',
    unpriced.size ? `UNPRICED: ${[...unpriced].join(', ')}` : `${ps.modelCount} models in catalogue`,
  );
  if (ps.fallbackModels.length) {
    console.log(`     note: ${ps.fallbackModels.length} model(s) priced from the models.dev fallback (${ps.fallbackModels.slice(0, 5).join(', ')}${ps.fallbackModels.length > 5 ? ', …' : ''})`);
  }

  console.log('\n8. Global reconciliation vs live ccusage  [GATE]');
  try {
    // 每次執行都重新抓一次 ccusage 的快照：新的用量進來時總額會跟著變動。
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
