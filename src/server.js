import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  behaviorTrend,
  cacheWriteAnalysis,
  improvementSuggestions,
  ourClaudeTotal,
  projectRanking,
  promptDetail,
  promptRanking,
  sessionDetail,
  sessionRanking,
  unattributedTotal,
} from './aggregate.js';
import * as ccusage from './ccusage.js';
import { cachedVersion, filterDaily, fullDaily, invalidateCcusage, monthlyFromDaily } from './ccusage-cache.js';
import { cacheStats, getAnalysis, invalidate } from './cache.js';
import { localAgentDetail, localAgentSpend } from './localagent.js';
import { applyUpdate, checkForUpdate, scheduleRestart } from './update.js';
import { initPricing, pricingStatus } from './pricing.js';
import { CLAUDE_PROJECTS_DIR, HOST, IS_DESKTOP, PORT, RECONCILE_TOLERANCE_PCT, ROOT } from './config.js';

const app = express();
app.disable('x-powered-by');

const asJson = (handler) => async (req, res) => {
  try {
    res.json(await handler(req));
  } catch (err) {
    const status = err?.kind === 'not_found' ? 503 : 500;
    res.status(status).json({
      error: err?.message ?? String(err),
      kind: err?.kind ?? 'internal',
      detail: err?.detail,
    });
  }
};

const range = (req) => ({
  since: req.query.since || undefined,
  until: req.query.until || undefined,
});

/** 分頁 1：所有 agent，資料來自快取的全區間 ccusage 執行結果，在這裡做區間篩選。 */
app.get(
  '/api/overview',
  asJson(async (req) => {
    const doc = filterDaily(await fullDaily(), range(req));
    return {
      ...ccusage.modelTotalsFromDaily(doc),
      daily: doc.daily,
      monthly: monthlyFromDaily(doc.daily),
      // 帳外支出：不計入 totalCost，ccusage 也看不到。套用與本分頁其他項目相同的
      // 區間篩選，這樣這張卡片才不會和旁邊的數字對不起來。
      localAgent: localAgentSpend(range(req)),
    };
  }),
);

/** 桌面版的 local agent mode：ccusage 看不到的支出。見 localagent.js。 */
app.get('/api/localagent', asJson((req) => localAgentDetail(range(req))));

/** 分頁 2：我們自己的各 session 分析，含 ccusage 數字與實際成本的差額拆分。 */
app.get('/api/sessions', asJson((req) => sessionRanking(range(req))));

app.get(
  '/api/sessions/:id',
  asJson((req) => {
    const s = sessionDetail(req.params.id);
    if (!s) throw Object.assign(new Error('session not found'), { kind: 'not_found' });
    return s;
  }),
);

/** 分頁 3：語句排行。 */
app.get(
  '/api/prompts',
  asJson((req) =>
    promptRanking({
      ...range(req),
      limit: Math.min(Number(req.query.limit) || 100, 1000),
      project: req.query.project || undefined,
    }),
  ),
);

/** 完整的 prompt 原文，只有在使用者點開時才抓取。 */
app.get(
  '/api/prompts/:id',
  asJson((req) => {
    const p = promptDetail(req.params.id);
    if (!p) throw Object.assign(new Error('prompt not found'), { kind: 'not_found' });
    return p;
  }),
);

app.get('/api/projects', asJson((req) => ({ projects: projectRanking(range(req)) })));

/**
 * 匯出：把 `ccusage claude daily --since --until --mode calculate --breakdown --json`
 * 的原始輸出，以 工號_起日_迄日_使用位置.json 的檔名提供下載。
 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 使用位置代碼：company＝公司桌機、nb＝自備筆電、home＝家中使用。 */
const DEVICES = new Set(['company', 'nb', 'home']);
app.get('/api/export', async (req, res) => {
  try {
    const { since, until } = range(req);
    if (!DATE_RE.test(since ?? '') || !DATE_RE.test(until ?? '')) {
      return res.status(400).json({ error: 'since/until 必須是 YYYY-MM-DD', kind: 'bad_request' });
    }
    // 確保檔名安全：去掉控制字元、路徑分隔符、引號，以及匯出檔名中用作欄位
    // 分隔符的 `_`。
    const empId = String(req.query.empId ?? '').replace(/[\x00-\x1f"'\\/:*?<>|_]/g, '').trim();
    const device = String(req.query.device ?? '');
    if (!empId) {
      return res.status(400).json({ error: '工號為必填', kind: 'bad_request' });
    }
    if (!DEVICES.has(device)) {
      return res.status(400).json({ error: '使用位置必須是 company / nb / home', kind: 'bad_request' });
    }

    const body = await ccusage.exportClaudeDaily({ since, until });
    const filename = `${empId}_${since}_${until}_${device}.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    // ASCII fallback + RFC 5987 in case the 工號 contains non-ASCII.
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename.replace(/[^ -~]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    res.send(body);
  } catch (err) {
    const status = err?.kind === 'not_found' ? 503 : 500;
    res.status(status).json({ error: err?.message ?? String(err), kind: err?.kind ?? 'internal', detail: err?.detail });
  }
});

/** 快取寫入分析：真正可行動的成本訊號，拆成 5 分鐘與 1 小時。 */
app.get(
  '/api/cache-writes',
  asJson((req) =>
    cacheWriteAnalysis({
      ...range(req),
      limit: Math.min(Number(req.query.limit) || 30, 1000),
      project: req.query.project || undefined,
    }),
  ),
);

/** 由快取寫入分析推導出的可行動改善訊號。 */
app.get('/api/improvements', asJson((req) => improvementSuggestions(range(req))));

/** 行為趨勢：本期與前期對比，加上每週分桶（「我有沒有進步？」）。 */
app.get('/api/trend', asJson((req) => behaviorTrend(range(req))));

app.get(
  '/api/health',
  asJson(async () => {
    const analysis = getAnalysis();
    const ours = ourClaudeTotal();
    const un = unattributedTotal();

    let reconcile = null;
    let ccusageErr = null;
    let version = null;
    try {
      version = await cachedVersion();
      const totals = ccusage.modelTotalsFromDaily(await fullDaily());
      const delta = ours - totals.claudeCost;
      const pct = totals.claudeCost ? (Math.abs(delta) / totals.claudeCost) * 100 : 0;
      reconcile = {
        ours,
        ccusageClaude: totals.claudeCost,
        ccusageOther: totals.otherCost,
        delta,
        pct,
        ok: pct <= RECONCILE_TOLERANCE_PCT,
        tolerancePct: RECONCILE_TOLERANCE_PCT,
      };
    } catch (err) {
      ccusageErr = { kind: err.kind ?? 'error', message: err.message };
    }

    return {
      pricing: pricingStatus(),
      ccusage: { version, cliPath: ccusage.cliLocation(), error: ccusageErr },
      analysis: {
        sessions: analysis.sessions.length,
        files: analysis.fileCount,
        parseMs: analysis.parseMs,
        generatedAt: analysis.generatedAt,
        cached: analysis.cached,
        dataDir: CLAUDE_PROJECTS_DIR,
        readErrors: analysis.readErrors ?? [],
        // 自上次「重新整理」以來的計數。整個重新整理週期這兩個都應該是 1：
        // 九個並行的分頁請求共用同一次掃描，所以只有其中一個會真的去解析。
        // 見 cache.js 裡的掃描快取。
        ...cacheStats(),
      },
      unattributed: { cost: un, pct: ours ? (un / ours) * 100 : 0 },
      reconcile,
    };
  }),
);

/**
 * 把快取丟掉就回傳。刻意「不」在這裡重新分析：前端隨即就會去打每一個分頁端點，
 * 其中第一個會做解析，其餘的則透過掃描快取（cache.js）共用那次結果。
 * 如果這裡也解析一次，就會變成「兩趟」完整解析 —— 這一趟，加上那一叢請求的另一趟，
 * 因為約 1.4 秒的解析時間長於掃描 TTL，而進行中的 session 指紋又會變動。
 *
 * 沒有人會讀這個回應的內容（app.js 只是 await 然後丟掉）；頁尾的 parseMs 來自
 * /api/health，而它本身就是那一叢請求的一部分。
 */
app.post('/api/refresh', asJson(() => {
  invalidate();
  invalidateCcusage();
  fullDaily().catch(() => {}); // 現在就開始重跑 ccusage，讓重新載入能順便搭上這次結果
  return { ok: true };
}));

/** 更新檢查：追蹤的上游分支是否領先我們？伺服器端快取 30 分鐘。 */
app.get('/api/update-check', asJson((req) => checkForUpdate({ force: req.query.force === '1' })));

/** 一鍵更新：只做 fast-forward 的 pull，然後自我重啟（npm install + npm start）。 */
app.post('/api/update', async (req, res) => {
  // 打包後的桌面版無法自己做 git pull 或用 npm 重啟。
  if (IS_DESKTOP) {
    return res.status(501).json({ error: '桌面版請至 GitHub Releases 下載新版', kind: 'unsupported' });
  }
  try {
    const r = await applyUpdate();
    res.json({ ok: true, ...r, restarting: r.changed });
    if (r.changed) scheduleRestart();
  } catch (err) {
    const status = err?.kind === 'dirty' ? 409 : 500;
    res.status(status).json({ error: err?.message ?? String(err), kind: err?.kind ?? 'internal' });
  }
});

app.use(express.static(path.join(ROOT, 'public')));

/**
 * 開始監聽。之所以匯出，是為了讓 Electron 外殼能在同一個程序內、以動態 port
 * （{ port: 0 }）跑同一份伺服器，並從回傳值讀出實際的 port。
 */
export async function startServer({ host = HOST, port = PORT } = {}) {
  const status = await initPricing();
  if (!status.rates) {
    console.error('WARNING: no pricing data available — costs will show as "—".');
    console.error(`  ${status.error ?? ''}`);
  } else {
    const ps = pricingStatus();
    console.log(`pricing: ${ps.source} (${ps.modelCount} models)${ps.stale ? ' [STALE]' : ''}`);
  }

  // 只綁 127.0.0.1：這些資料是本機的，也只留在本機。
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(port, host, () => resolve(s));
    s.on('error', reject);
  });
  console.log(`AI usage dashboard: http://${host}:${server.address().port}`);

  // 在背景預熱快取，讓第一次載入頁面不必等那約 4 秒的 CLI 執行。
  fullDaily().catch(() => {});
  cachedVersion().catch(() => {});
  return server;
}

// CLI 模式（`node src/server.js`、npm start、start.bat）—— 行為與以往相同。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startServer();
}
