/* AI 用量儀表板 —— 原生 JS + 內嵌的 Chart.js。
   純邏輯（格式化、分桶、排序、驗證）放在 lib.js 並有單元測試；
   這裡剩下的全是 DOM、圖表與 fetch。 */
import {
  bucketBy,
  clampFont,
  compact,
  cycleSort,
  escapeHtml,
  exportRangeFrom,
  FONT_MAX,
  FONT_MIN,
  FONT_STEP,
  num,
  sanitizeEmpId,
  sanitizeSessionSort,
  SESSION_SORTS,
  sortIndicator,
  sortRows,
  usd,
  usd4,
  weekOf,
  when,
  yearOf,
} from './lib.js';

const $ = (sel) => document.querySelector(sel);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** 類別用的色彩槽位，依固定順序分配，且絕不循環重用。 */
const SLOTS = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-5', '--series-6', '--series-7', '--series-8'];

/** model -> 固定的槽位，讓同一個模型在每張圖表與每種篩選下都保持同樣的顏色。 */
const modelColors = new Map();
function colorForModel(model) {
  if (!modelColors.has(model)) {
    modelColors.set(model, SLOTS[modelColors.size % SLOTS.length]);
  }
  return css(modelColors.get(model));
}

/**
 * 刻意設得比伺服器自己的最壞情況還高：/api/overview 要等 ccusage，
 * 而它的子程序逾時本身就有 60 秒；在有防火牆的網路下，那是一個「慢但會成功」的請求
 * （ccusage 一定會去抓遠端定價）。若這裡也設 60 秒上限，就會在它即將回來的前一刻
 * 把它中止，變成一個使用者看得到的錯誤。
 */
const API_TIMEOUT_MS = 90_000;

const api = async (path, opts) => {
  let res;
  try {
    res = await fetch(path, { signal: AbortSignal.timeout(API_TIMEOUT_MS), ...opts });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new Error(`請求逾時（${API_TIMEOUT_MS / 1000} 秒）：${path}`);
    throw err;
  }
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), body);
  return body;
};

/* UI 字體縮放（對 <html> 套 CSS `zoom`）—— 網頁版與 Electron 共用同一條路徑，
   因為兩者渲染的是同一個頁面。`zoom` 不會提高 devicePixelRatio，所以 canvas 圖表
   會被放大而糊掉；render() 透過 config.devicePixelRatio 來補償這件事。 */
let fontScale = clampFont(parseFloat(localStorage.getItem('font-scale')) || 1);

let charts = {};
function render(id, config) {
  charts[id]?.destroy();
  const ctx = document.getElementById(id);
  if (!ctx) return;
  config.options = { ...config.options, devicePixelRatio: window.devicePixelRatio * fontScale };
  charts[id] = new Chart(ctx, config);
}

/* 格線與座標軸都做退讓處理；提示框預設開啟。 */
function baseOpts(extra = {}) {
  const grid = css('--grid');
  const tick = css('--text-muted');
  return {
    responsive: true,
    maintainAspectRatio: false,
    /* 以「類別」為單位 hover，絕不用二維距離判定。`nearest`（該模式下 Chart.js 的
       預設軸是 'xy'）會吸附到「單一最近的長條中心點」：在堆疊圖上那經常是隔壁那一欄，
       而在接近基線處則會是某個高度為 0 的區段 —— 那種區段會被標籤 callback 隱藏，
       結果只剩下光禿禿的「日期 + 合計 $0.00」。改成比對整個 index，也讓「合計」頁尾
       變成真正的整欄總和，而不是隨便被選中的某一段的加總。 */
    interaction: { mode: 'index', intersect: false, axis: extra.indexAxis === 'y' ? 'y' : 'x' },
    plugins: {
      legend: {
        labels: { color: css('--text-secondary'), boxWidth: 10, boxHeight: 10, usePointStyle: true, font: { size: 11 } },
      },
      tooltip: {
        backgroundColor: css('--surface-0'),
        titleColor: css('--text-primary'),
        bodyColor: css('--text-secondary'),
        borderColor: css('--border'),
        borderWidth: 1,
        padding: 10,
        boxPadding: 4,
      },
      ...extra.plugins,
    },
    scales: {
      x: { grid: { color: grid, drawTicks: false }, border: { color: css('--axis') }, ticks: { color: tick, font: { size: 11 } } },
      y: { grid: { color: grid, drawTicks: false }, border: { color: css('--axis') }, ticks: { color: tick, font: { size: 11 } } },
      ...extra.scales,
    },
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => !['plugins', 'scales'].includes(k))),
  };
}

/* ============================== state ============================== */
const state = { overview: null, cachewrite: null, improvements: null, trend: null, prompts: null, sessions: null, projects: null, health: null, localagent: null };

/* ============================== 日期範圍 ============================== */
const fmtDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** 依所選的預設區間填入日期欄位。選「自訂」時不動它們。 */
function applyPreset() {
  const v = $('#date-preset').value;
  if (v === 'custom') return;
  if (v === 'all') {
    $('#date-since').value = '';
    $('#date-until').value = '';
    return;
  }
  const now = new Date();
  const from = new Date(now);
  from.setDate(from.getDate() - (Number(v) - 1)); // 含今天
  $('#date-since').value = fmtDate(from);
  $('#date-until').value = fmtDate(now);
}

/** 組出帶有目前日期範圍（以及任何額外查詢參數）的網址。 */
function withRange(path, extra = {}) {
  const p = new URLSearchParams();
  const since = $('#date-since').value;
  const until = $('#date-until').value;
  if (since) p.set('since', since);
  if (until) p.set('until', until);
  for (const [k, v] of Object.entries(extra)) if (v != null && v !== '') p.set(k, v);
  const qs = p.toString();
  return qs ? `${path}?${qs}` : path;
}

/* ============================== TAB 1 ============================== */
function drawOverview() {
  const d = state.overview;
  if (!d) return;

  const claudeShare = d.totalCost ? (d.claudeCost / d.totalCost) * 100 : 0;
  const ourTrue = state.sessions?.totals.trueCost;
  const hidden = state.sessions?.totals.workflowCost ?? 0;
  const la = d.localAgent;

  // 金額放上排，數量降級成下面那排精簡卡片。五張等寬卡片會讓人讀成
  // 「使用模型 10 和總成本 $1,042 一樣重要」，而且這裡的中文標籤比其他分頁長，
  // 在那個寬度下會折行。
  //
  // 兩張「隱藏支出」卡片並排，意思卻正好相反 —— workflow 那一層「是」包含在總成本裡的
  // （ccusage daily 會讀那些檔案；只有 `ccusage session` 會漏掉），
  // local agent 則「不是」。卡片底下那行文字就是在講這個差別，所以不要拿掉。
  const models = d.models;
  $('#kpi-overview').innerHTML = `
    <div class="kpi-row">
      <div class="kpi wide">
        <div class="label">總成本（所有 agent）</div>
        <div class="value hero">${usd(d.totalCost)}</div>
        <div class="foot">Claude ${usd(d.claudeCost)}（${claudeShare.toFixed(1)}%）· 其他 ${usd(d.otherCost)}</div>
      </div>
      <div class="kpi accent">
        <div class="label">workflow subagent</div>
        <div class="value">${usd(hidden)}</div>
        <div class="foot">已含在總成本內 · ccusage session 漏算</div>
      </div>
      ${la?.available ? `
      <div class="kpi accent">
        <div class="label">local agent 排程任務</div>
        <div class="value">${usd(la.cost)}</div>
        <div class="foot"><strong>未</strong>含在總成本內 · ${num(la.runs)} 次執行</div>
      </div>` : ''}
    </div>
    <div class="kpi-row">
      <div class="kpi compact">
        <div class="label">已分析語句</div>
        <div class="value">${num(state.prompts?.totalPrompts ?? 0)}</div>
      </div>
      <div class="kpi compact">
        <div class="label">session</div>
        <div class="value">${num(state.sessions?.sessions.length ?? 0)}</div>
      </div>
      <div class="kpi compact" title="${escapeHtml(models.map((m) => m.model).join('、'))}">
        <div class="label">使用模型</div>
        <div class="value">${models.length}</div>
      </div>
    </div>`;

  // 各模型成本 —— 依量級排序，每個對象一條長條，顏色與對象綁定。
  render('chart-models', {
    type: 'bar',
    data: {
      labels: models.map((m) => m.model),
      datasets: [{
        label: '成本 (USD)',
        data: models.map((m) => m.cost),
        backgroundColor: models.map((m) => colorForModel(m.model)),
        borderRadius: 4,
        borderSkipped: false,
      }],
    },
    options: baseOpts({
      indexAxis: 'y',
      plugins: {
        legend: { display: false }, // 只有單一數列 —— 標題已經說明它是什麼
        tooltip: {
          callbacks: {
            label: (c) => {
              const m = models[c.dataIndex];
              const pct = d.totalCost ? ((m.cost / d.totalCost) * 100).toFixed(1) : '0';
              return ` ${usd(m.cost)}（占 ${pct}%）`;
            },
          },
        },
      },
      scales: { x: { title: { display: true, text: '成本 (USD)', color: css('--text-muted'), font: { size: 11 } } } },
    }),
  });

  $('#table-models').innerHTML = `
    <thead><tr>
      <th>模型</th><th class="num">成本</th><th class="num">占比</th>
      <th class="num">輸入</th><th class="num">輸出</th>
      <th class="num">快取寫入</th><th class="num">快取讀取</th>
    </tr></thead>
    <tbody>${models.map((m) => `
      <tr>
        <td><span class="swatch" style="background:${colorForModel(m.model)}"></span>${escapeHtml(m.model)}</td>
        <td class="num">${usd(m.cost)}</td>
        <td class="num">${d.totalCost ? ((m.cost / d.totalCost) * 100).toFixed(1) : '0'}%</td>
        <td class="num">${compact(m.input)}</td>
        <td class="num">${compact(m.output)}</td>
        <td class="num">${compact(m.cacheWrite)}</td>
        <td class="num muted">${compact(m.cacheRead)}</td>
      </tr>`).join('')}
    </tbody>`;

  drawDailyTrend(dailyPeriod);
  drawTokenSplit();
}

let dailyPeriod = 'day';

/**
 * 依模型堆疊的成本趨勢，可重新分桶成日／週／月／年。「日」與「月」直接來自 ccusage
 * （overview.daily／overview.monthly）；「週」（以星期一為基準）是在前端把日資料重新分桶，
 * 「年」則是把月資料重新分桶。全部都會遵守全域的日期篩選。
 */
function drawDailyTrend(period) {
  const d = state.overview;
  if (!d) return;
  dailyPeriod = period;
  document.querySelectorAll('#daily-period button').forEach((b) => b.classList.toggle('active', b.dataset.p === period));

  let rows;
  if (period === 'month') {
    rows = d.monthly ?? [];
  } else if (period === 'year') {
    rows = bucketBy(d.monthly ?? [], yearOf);
  } else if (period === 'week') {
    rows = bucketBy(d.daily ?? [], weekOf);
  } else {
    rows = d.daily ?? [];
  }

  const periods = [...new Set(rows.map((x) => x.period))].sort();
  const modelNames = (d.models ?? []).map((m) => m.model);
  const byPeriod = new Map(rows.map((x) => [x.period, x]));
  render('chart-daily', {
    type: 'bar',
    data: {
      labels: periods,
      datasets: modelNames.map((mn) => ({
        label: mn,
        data: periods.map((p) => byPeriod.get(p)?.modelBreakdowns?.find((b) => b.modelName === mn)?.cost ?? 0),
        backgroundColor: colorForModel(mn),
        borderRadius: 3,
        borderSkipped: false,
        borderColor: css('--surface-1'),
        borderWidth: { top: 2, right: 0, bottom: 0, left: 0 }, // 堆疊區段之間留 2px 的視覺間隙
      })),
    },
    options: baseOpts({
      scales: {
        x: { stacked: true, grid: { display: false }, border: { color: css('--axis') }, ticks: { color: css('--text-muted'), font: { size: 10 }, maxRotation: 60, minRotation: 0 } },
        y: { stacked: true, grid: { color: css('--grid') }, border: { color: css('--axis') }, ticks: { color: css('--text-muted'), font: { size: 11 }, callback: (v) => `$${v}` } },
      },
      plugins: {
        tooltip: {
          callbacks: {
            label: (c) => (c.parsed.y > 0 ? ` ${c.dataset.label}: ${usd(c.parsed.y)}` : null),
            // 某個期間可能整段都是 0 —— ccusage 會把它不認識的模型定價為 $0.00
            // （見 ccusage.js），所以某天全是全新模型的用量，看起來就是一根隱形的長條。
            // 與其顯示一個空框，不如把這件事講出來。
            beforeBody: (items) => (items.some((i) => i.parsed.y > 0) ? '' : ' 此期間沒有已計價的用量'),
            footer: (items) => `合計 ${usd(items.reduce((s, i) => s + i.parsed.y, 0))}`,
          },
        },
      },
    }),
  });
}

/**
 * Token 組成。快取讀取約占 token 的 94%，但單價只有約 1/10，所以用弱化的灰色呈現；
 * 而快取「寫入」—— 真正可行動的訊號 —— 則佔用橘色那個槽位。
 */
function drawTokenSplit() {
  const d = state.overview;
  const models = d.models.filter((m) => m.cost > 0.005);
  const series = [
    { key: 'input', label: '輸入', color: css('--series-input') },
    { key: 'output', label: '輸出', color: css('--series-output') },
    { key: 'cacheWrite', label: '快取寫入（可改善）', color: css('--series-write') },
    { key: 'cacheRead', label: '快取讀取（便宜，正常現象）', color: css('--series-read') },
  ];

  render('chart-tokens', {
    type: 'bar',
    data: {
      labels: models.map((m) => m.model),
      datasets: series.map((s) => ({
        label: s.label,
        data: models.map((m) => m[s.key]),
        backgroundColor: s.color,
        borderRadius: 3,
        borderSkipped: false,
        borderColor: css('--surface-1'),
        borderWidth: { top: 0, right: 2, bottom: 0, left: 0 },
      })),
    },
    options: baseOpts({
      indexAxis: 'y',
      scales: {
        x: { stacked: true, grid: { color: css('--grid') }, border: { color: css('--axis') }, ticks: { color: css('--text-muted'), font: { size: 11 }, callback: (v) => compact(v) } },
        y: { stacked: true, grid: { display: false }, border: { color: css('--axis') }, ticks: { color: css('--text-muted'), font: { size: 11 } } },
      },
      plugins: {
        tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${num(c.parsed.x)}` } },
      },
    }),
  });

  const tot = models.reduce((a, m) => {
    a.input += m.input; a.output += m.output; a.cacheWrite += m.cacheWrite; a.cacheRead += m.cacheRead;
    return a;
  }, { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
  const all = tot.input + tot.output + tot.cacheWrite + tot.cacheRead;

  $('#table-tokens').innerHTML = `
    <thead><tr><th>Token 類別</th><th class="num">數量</th><th class="num">占 token 總量</th><th>說明</th></tr></thead>
    <tbody>
      ${series.map((s) => `
        <tr${s.key === 'cacheRead' ? ' class="muted"' : ''}>
          <td><span class="swatch" style="background:${s.color}"></span>${s.label}</td>
          <td class="num">${num(tot[s.key])}</td>
          <td class="num">${all ? ((tot[s.key] / all) * 100).toFixed(1) : '0'}%</td>
          <td class="muted">${{
            input: '每次請求的新內容',
            output: '模型生成，單價最高',
            cacheWrite: '建立快取；1 小時寫入約為輸入的 2 倍價',
            cacheRead: '重複讀取快取；單價約為輸入的 1/10',
          }[s.key]}</td>
        </tr>`).join('')}
    </tbody>`;
}

/* ========================== 分頁：快取寫入 ========================== */
/**
 * 快取寫入成本，拆成 5 分鐘與 1 小時。整個分頁都依寫入成本排序 ——
 * 那是唯一一個「既貴、又改得動」的訊號（1 小時寫入約為 input 價格的 2 倍）。
 */
function drawCacheWrite() {
  const d = state.cachewrite;
  if (!d) return;
  const t = d.totals;
  const c5 = css('--series-1');       // 5 分鐘 —— 藍色
  const c1 = css('--series-write');   // 1 小時 —— 橘色（昂貴且可改善的那一層）
  const writePctOfTotal = t.trueCost ? (t.writeCost / t.trueCost) * 100 : 0;
  const oneHrShare = t.writeCost ? (t.cost1h / t.writeCost) * 100 : 0;

  $('#kpi-cachewrite').innerHTML = `
    <div class="kpi">
      <div class="label">快取寫入總成本</div>
      <div class="value hero">${usd(t.writeCost)}</div>
      <div class="foot">佔實際總成本 ${writePctOfTotal.toFixed(1)}%</div>
    </div>
    <div class="kpi accent">
      <div class="label">其中 1h 寫入（最貴）</div>
      <div class="value">${usd(t.cost1h)}</div>
      <div class="foot">佔寫入成本 ${oneHrShare.toFixed(1)}% · 約輸入 2 倍價</div>
    </div>
    <div class="kpi">
      <div class="label">其中 5m 寫入</div>
      <div class="value">${usd(t.cost5m)}</div>
      <div class="foot">約輸入 1.25 倍價</div>
    </div>
    <div class="kpi">
      <div class="label">有寫入成本的語句</div>
      <div class="value">${num(d.totalPrompts)}</div>
      <div class="foot">下表列出成本最高者</div>
    </div>`;

  // 寫入 vs 讀取：寫入是前期投入的成本，便宜的讀取才是回報。
  const reuse = t.reuseRatio;
  const verdict = reuse >= 10 ? '重用充分，寫入投資划算' : reuse >= 3 ? '重用尚可' : '重用偏低，寫入可能有浪費';
  $('#cw-efficiency').innerHTML = `
    <div>快取寫入成本<strong>${usd(t.writeCost)}</strong></div>
    <div>快取讀取成本<strong>${usd(t.readCost)}</strong></div>
    <div>讀取／寫入 token 重用倍數<strong>${reuse.toFixed(1)}×</strong></div>
    <div class="${reuse < 3 ? 'accent' : ''}">解讀<strong style="font-size:13px">每寫入 1 個 token 被讀取重用約 ${reuse.toFixed(1)} 次 · ${verdict}</strong></div>`;

  // 各專案 —— 水平堆疊長條，5 分鐘 vs 1 小時。
  const projects = d.projects;
  render('chart-cw-projects', {
    type: 'bar',
    data: {
      labels: projects.map((p) => p.project),
      datasets: [
        { label: '5m 寫入', data: projects.map((p) => p.cost5m), backgroundColor: c5, borderRadius: 3, borderSkipped: false, borderColor: css('--surface-1'), borderWidth: { top: 0, right: 2, bottom: 0, left: 0 } },
        { label: '1h 寫入', data: projects.map((p) => p.cost1h), backgroundColor: c1, borderRadius: 3, borderSkipped: false, borderColor: css('--surface-1'), borderWidth: { top: 0, right: 2, bottom: 0, left: 0 } },
      ],
    },
    options: baseOpts({
      indexAxis: 'y',
      scales: {
        x: { stacked: true, grid: { color: css('--grid') }, border: { color: css('--axis') }, ticks: { color: css('--text-muted'), font: { size: 11 }, callback: (v) => `$${v}` } },
        y: { stacked: true, grid: { display: false }, border: { color: css('--axis') }, ticks: { color: css('--text-muted'), font: { size: 11 } } },
      },
      plugins: {
        tooltip: {
          callbacks: {
            label: (c) => ` ${c.dataset.label}: ${usd4(c.parsed.x)}`,
            footer: (items) => `合計 ${usd4(items.reduce((s, i) => s + i.parsed.x, 0))}`,
          },
        },
      },
    }),
  });

  $('#table-cw-projects').innerHTML = `
    <thead><tr><th>專案</th><th class="num">5m 寫入</th><th class="num">1h 寫入</th><th class="num">合計</th></tr></thead>
    <tbody>${projects.map((p) => `
      <tr>
        <td>${escapeHtml(p.project ?? '—')}</td>
        <td class="num"><span class="swatch" style="background:${c5}"></span>${usd4(p.cost5m)}</td>
        <td class="num"><span class="swatch" style="background:${c1}"></span>${usd4(p.cost1h)}</td>
        <td class="num"><strong>${usd4(p.writeCost)}</strong></td>
      </tr>`).join('')}
    </tbody>`;

  // 每日趨勢 —— 垂直堆疊長條。
  const days = d.daily.map((x) => x.period);
  render('chart-cw-daily', {
    type: 'bar',
    data: {
      labels: days,
      datasets: [
        { label: '5m 寫入', data: d.daily.map((x) => x.cost5m), backgroundColor: c5, borderRadius: 3, borderSkipped: false, borderColor: css('--surface-1'), borderWidth: { top: 2, right: 0, bottom: 0, left: 0 } },
        { label: '1h 寫入', data: d.daily.map((x) => x.cost1h), backgroundColor: c1, borderRadius: 3, borderSkipped: false, borderColor: css('--surface-1'), borderWidth: { top: 2, right: 0, bottom: 0, left: 0 } },
      ],
    },
    options: baseOpts({
      scales: {
        x: { stacked: true, grid: { display: false }, border: { color: css('--axis') }, ticks: { color: css('--text-muted'), font: { size: 10 }, maxRotation: 60, minRotation: 0 } },
        y: { stacked: true, grid: { color: css('--grid') }, border: { color: css('--axis') }, ticks: { color: css('--text-muted'), font: { size: 11 }, callback: (v) => `$${v}` } },
      },
      plugins: {
        tooltip: {
          callbacks: {
            label: (c) => (c.parsed.y > 0 ? ` ${c.dataset.label}: ${usd4(c.parsed.y)}` : null),
            footer: (items) => `合計 ${usd4(items.reduce((s, i) => s + i.parsed.y, 0))}`,
          },
        },
      },
    }),
  });

  // 依寫入成本排名的語句 —— 垂直長條（前 15 名），5 分鐘／1 小時堆疊。
  const rows = d.prompts;
  const top = rows.slice(0, 15);
  render('chart-cw-prompts', {
    type: 'bar',
    data: {
      labels: top.map((_, i) => `#${i + 1}`),
      datasets: [
        { label: '5m 寫入', data: top.map((p) => p.cost5m), backgroundColor: c5, borderRadius: 3, borderSkipped: false },
        { label: '1h 寫入', data: top.map((p) => p.cost1h), backgroundColor: c1, borderRadius: 3, borderSkipped: false },
      ],
    },
    options: baseOpts({
      scales: {
        x: { stacked: true, grid: { display: false }, border: { color: css('--axis') }, ticks: { color: css('--text-muted'), font: { size: 11 } } },
        y: { stacked: true, ticks: { color: css('--text-muted'), font: { size: 11 }, callback: (v) => `$${v}` } },
      },
      plugins: {
        tooltip: {
          callbacks: {
            title: (items) => `#${items[0].dataIndex + 1} · ${top[items[0].dataIndex].projectLabel ?? ''}`,
            label: (c) => ` ${c.dataset.label}: ${usd4(c.parsed.y)}`,
            afterBody: (items) => top[items[0].dataIndex].snippet.slice(0, 46) + '…',
          },
        },
      },
    }),
  });

  $('#table-cw-prompts').innerHTML = `
    <thead><tr>
      <th class="num">#</th><th>語句（點擊展開全文）</th><th>專案</th><th>時間</th>
      <th class="num">5m 寫入</th><th class="num">1h 寫入</th><th class="num">寫入合計</th>
    </tr></thead>
    <tbody>${rows.map((p, i) => `
      <tr class="clickable" data-prompt="${p.promptId}">
        <td class="num rank">${i + 1}</td>
        <td class="snippet">${escapeHtml(p.snippet)}</td>
        <td class="muted">${escapeHtml(p.projectLabel ?? '—')}</td>
        <td class="muted">${when(p.timestamp)}</td>
        <td class="num muted">${usd4(p.cost5m)}</td>
        <td class="num delta-up">${usd4(p.cost1h)}</td>
        <td class="num"><strong>${usd4(p.writeCost)}</strong></td>
      </tr>`).join('')}
    </tbody>`;

  document.querySelectorAll('#table-cw-prompts tr[data-prompt]').forEach((tr) => {
    tr.addEventListener('click', () => showPrompt(tr.dataset.prompt));
  });
}

/* ============================ 分頁：改善建議 ============================ */
/**
 * 把快取寫入的診斷轉成可以行動的建議。只講事實 —— 刻意不做「可省多少錢」的估算。
 * 卡片都是由後端的原始數字組裝出來的。
 */
function drawImprove() {
  const d = state.improvements;
  if (!d) return;
  const t = d.totals;
  const models = d.byModel;

  // 模型選擇這個槓桿：用過的模型中最便宜的那個，以及排名第一的模型是它的幾倍費率。
  const rated = models.filter((m) => m.rate1h > 0);
  const minRate = rated.length ? Math.min(...rated.map((m) => m.rate1h)) : 0;
  const topM = models[0];
  const topShare = t.writeCost ? (topM.writeCost / t.writeCost) * 100 : 0;
  const rateMult = minRate && topM?.rate1h ? topM.rate1h / minRate : 0;
  const cheapest = rated.length ? rated.reduce((a, b) => (b.rate1h < a.rate1h ? b : a)).model : '';

  const cards = [];

  // A —— 模型選擇（最主要的槓桿）
  if (topM && topShare >= 40) {
    cards.push({
      cls: 'danger',
      title: '① 模型選擇：最大的省錢槓桿',
      body: `<strong>${escapeHtml(topM.model)}</strong> 佔快取寫入成本 <strong>${topShare.toFixed(0)}%</strong>（${usd(topM.writeCost)}）。` +
        (rateMult >= 1.5 ? `它的 1h 寫入單價約為最便宜已用模型（${escapeHtml(cheapest)}）的 <strong>${rateMult.toFixed(1)} 倍</strong>。` : ''),
      actions: [
        '預設用較便宜的模型（Sonnet / Haiku），只在需要深度推理時 <code>/model</code> 切 Opus。',
        '把探索、讀檔、樣板、簡單修改等粗活交給 subagent 或便宜模型。',
        '不需要降低寫入量——降低「貴模型的寫入量」才是重點。',
      ],
    });
  }

  // B —— 快取重用率偏低的 session
  if (d.lowReuseSessions.length) {
    cards.push({
      cls: 'warn',
      title: '② 少數 session 的 1h 寫入沒回本',
      body: `有 <strong>${d.lowReuseSessions.length}</strong> 個 session 的 1h 寫入重用低於 8×——寫入的快取還沒被讀夠就結束了（詳見下方表格）。`,
      actions: [
        '零碎、一次性的任務盡量併進既有 session，避免反覆重建 context。',
        '很短就會結束的任務，1h 快取通常來不及回本。',
      ],
    });
  }

  // C — concentration
  const c5 = d.concentration.top5Share * 100;
  if (c5 >= 40) {
    cards.push({
      cls: 'warn',
      title: '③ 成本高度集中',
      body: `前 5 個 session 就佔了快取寫入成本的 <strong>${c5.toFixed(0)}%</strong>。優化聚焦在這些 session（見下方）即可，投報最高。`,
      actions: ['先從這些高成本 session 的模型選擇下手。'],
    });
  }

  // D —— 重用率健康度（用來讓使用者安心，免得過度去優化寫入）
  if (t.reuseRatio >= 10) {
    cards.push({
      cls: 'good',
      title: '✓ 快取重用健康',
      body: `整體讀取／寫入重用達 <strong>${t.reuseRatio.toFixed(1)}×</strong>，代表寫入的快取大多有被回收——快取運作良好。<strong>重點是用對模型，而非減少寫入。</strong>`,
      actions: [],
    });
  }

  $('#improve-cards').innerHTML = cards.map((c) => `
    <div class="card callout ${c.cls}">
      <h2>${c.title}</h2>
      <p>${c.body}</p>
      ${c.actions.length ? `<ul>${c.actions.map((a) => `<li>${a}</li>`).join('')}</ul>` : ''}
    </div>`).join('');

  // 各模型寫入成本長條圖。
  render('chart-imp-models', {
    type: 'bar',
    data: {
      labels: models.map((m) => m.model),
      datasets: [{
        label: '快取寫入成本 (USD)',
        data: models.map((m) => m.writeCost),
        backgroundColor: models.map((m) => colorForModel(m.model)),
        borderRadius: 4,
        borderSkipped: false,
      }],
    },
    options: baseOpts({
      indexAxis: 'y',
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) => {
              const m = models[c.dataIndex];
              return [` 寫入 ${usd(m.writeCost)}（其中 1h ${usd(m.cost1h)}）`, ` 佔該模型總成本 ${m.totalCost ? ((m.writeCost / m.totalCost) * 100).toFixed(0) : 0}%`];
            },
          },
        },
      },
      scales: { x: { ticks: { color: css('--text-muted'), font: { size: 11 }, callback: (v) => `$${v}` } } },
    }),
  });

  $('#table-imp-models').innerHTML = `
    <thead><tr><th>模型</th><th class="num">1h 寫入</th><th class="num">5m 寫入</th><th class="num">寫入合計</th><th class="num">佔該模型總成本</th></tr></thead>
    <tbody>${models.map((m) => `
      <tr>
        <td><span class="swatch" style="background:${colorForModel(m.model)}"></span>${escapeHtml(m.model)}</td>
        <td class="num delta-up">${usd4(m.cost1h)}</td>
        <td class="num muted">${usd4(m.cost5m)}</td>
        <td class="num"><strong>${usd4(m.writeCost)}</strong></td>
        <td class="num muted">${m.totalCost ? ((m.writeCost / m.totalCost) * 100).toFixed(0) : 0}%</td>
      </tr>`).join('')}
    </tbody>`;

  // 模型定價表 —— 以每百萬 token 的費率呈現，讓「模型選擇」這個槓桿看得懂。
  const perM = (r) => (r == null ? '—' : `$${(r * 1e6).toFixed(2)}`);
  $('#table-imp-rates').innerHTML = `
    <thead><tr><th>模型</th><th class="num">輸入</th><th class="num">輸出</th><th class="num">5m 寫入</th><th class="num">1h 寫入</th><th class="num">快取讀取</th></tr></thead>
    <tbody>${models.map((m) => `
      <tr>
        <td><span class="swatch" style="background:${colorForModel(m.model)}"></span>${escapeHtml(m.model)}</td>
        <td class="num">${perM(m.rates?.input)}</td>
        <td class="num">${perM(m.rates?.output)}</td>
        <td class="num muted">${perM(m.rates?.write5m)}</td>
        <td class="num delta-up">${perM(m.rates?.write1h)}</td>
        <td class="num muted">${perM(m.rates?.read)}</td>
      </tr>`).join('')}
    </tbody>`;

  const sessionRow = (s) => `
    <tr class="clickable" data-session="${s.sessionId}">
      <td>${escapeHtml(s.projectLabel ?? '—')}</td>
      <td class="muted"><code>${s.sessionId.slice(0, 8)}</code></td>
      <td class="num">${s.promptCount ?? '—'}</td>
      <td class="num">${usd(s.writeCost)}</td>
      <td class="num delta-up">${usd(s.cost1h)}</td>
      <td class="num ${s.reuse < 8 ? 'delta-up' : 'muted'}">${s.reuse.toFixed(1)}×</td>
    </tr>`;
  const sessionHead = `
    <thead><tr>
      <th>專案</th><th>Session</th><th class="num">語句</th>
      <th class="num">寫入成本</th><th class="num">其中 1h</th><th class="num">重用</th>
    </tr></thead>`;

  $('#table-imp-lowreuse').innerHTML = d.lowReuseSessions.length
    ? sessionHead + `<tbody>${d.lowReuseSessions.map(sessionRow).join('')}</tbody>`
    : `<tbody><tr><td class="muted">沒有偵測到低重用的 session — 快取運作良好。</td></tr></tbody>`;

  $('#table-imp-top').innerHTML = sessionHead + `<tbody>${d.topSessions.map(sessionRow).join('')}</tbody>`;

  document.querySelectorAll('#tab-improve tr[data-session]').forEach((tr) => {
    tr.addEventListener('click', () => showSession(tr.dataset.session));
  });
}

/* ============================= 分頁：行為趨勢 ============================= */
/**
 * 「我有沒有進步？」—— 本期與前一段等長期間的對比，再加上每週趨勢。
 * 方向是有意義的：成本／Opus 占比／1 小時占比／每語句成本「往下」是好事（綠色）；
 * 重用率「往上」才是好事。
 */
function drawTrend() {
  const d = state.trend;
  if (!d) return;
  const cur = d.current;
  const prev = d.previous;
  const comparable = d.hasComparison && prev && prev.promptCount > 0;

  // 每個指標：目前的值、格式化函式，以及「是不是越低越好」。
  const pct = (n) => `${(n * 100).toFixed(0)}%`;
  const metrics = [
    { label: '總成本', now: cur.totalCost, prev: prev?.totalCost, fmt: usd, lowerBetter: true, hero: true },
    { label: 'Opus 成本佔比', now: cur.opusShare, prev: prev?.opusShare, fmt: pct, lowerBetter: true },
    { label: '1h 寫入佔比', now: cur.oneHrShare, prev: prev?.oneHrShare, fmt: pct, lowerBetter: true },
    { label: '快取重用倍數', now: cur.reuse, prev: prev?.reuse, fmt: (n) => `${n.toFixed(1)}×`, lowerBetter: false },
    { label: '每語句平均成本', now: cur.avgCostPerPrompt, prev: prev?.avgCostPerPrompt, fmt: usd4, lowerBetter: true },
  ];

  const deltaHtml = (m) => {
    if (!comparable || m.prev == null) return '<div class="foot muted">無上期資料可比較</div>';
    const diff = m.now - m.prev;
    if (Math.abs(diff) < 1e-9 || (!m.prev && !m.now)) return '<div class="foot muted">與上期持平</div>';
    const relBase = m.prev || (m.now ? m.now : 1);
    const relPct = (diff / Math.abs(relBase)) * 100;
    const improved = m.lowerBetter ? diff < 0 : diff > 0;
    const arrow = diff < 0 ? '▼' : '▲';
    return `<div class="foot"><span class="${improved ? 'delta-down' : 'delta-up'}">${arrow} ${Math.abs(relPct).toFixed(0)}%</span> vs 上期 ${m.fmt(m.prev)}</div>`;
  };

  $('#trend-kpis').innerHTML = metrics.map((m) => `
    <div class="kpi">
      <div class="label">${m.label}</div>
      <div class="value${m.hero ? ' hero' : ''}">${m.fmt(m.now)}</div>
      ${deltaHtml(m)}
    </div>`).join('');

  // 每週趨勢：依模型堆疊的成本（顏色與對象綁定，跟其他每張圖一致）
  // 外加一條 Opus 占比的折線。1 小時寫入占比已經從圖上拿掉了 ——
  // 它每週都落在 80~100%（那是 Claude Code 快取機制的特性，不是使用者行為），
  // 放上去只會跟 Opus 那條線糾纏在一起；它的數字仍然保留在上方的 KPI 卡片裡。
  const wk = d.weekly;
  const wkModels = [...new Map(
    wk.flatMap((w) => w.byModel ?? []).map((m) => [m.model, 0]),
  ).keys()];
  // 依整體支出分配色彩槽位，讓大模型維持它們在總覽頁的顏色。
  const wkTotals = new Map(wkModels.map((m) => [m, wk.reduce((s, w) => s + (w.byModel?.find((x) => x.model === m)?.cost ?? 0), 0)]));
  wkModels.sort((a, z) => wkTotals.get(z) - wkTotals.get(a));

  render('chart-trend', {
    type: 'bar',
    data: {
      labels: wk.map((w) => w.week),
      datasets: [
        {
          type: 'line', label: 'Opus 成本佔比', yAxisID: 'yPct',
          data: wk.map((w) => w.opusShare * 100),
          borderColor: css('--series-5'), backgroundColor: css('--series-5'),
          borderWidth: 2, tension: 0.25, pointRadius: 3,
          order: 0,
        },
        ...wkModels.map((mn) => ({
          type: 'bar', label: mn, yAxisID: 'yCost', stack: 'cost',
          data: wk.map((w) => w.byModel?.find((x) => x.model === mn)?.cost ?? 0),
          backgroundColor: colorForModel(mn),
          borderRadius: 3, borderSkipped: false,
          borderColor: css('--surface-1'),
          borderWidth: { top: 2, right: 0, bottom: 0, left: 0 },
          order: 99,
        })),
      ],
    },
    options: baseOpts({
      scales: {
        x: { stacked: true, grid: { display: false }, border: { color: css('--axis') }, ticks: { color: css('--text-muted'), font: { size: 10 } } },
        yCost: { stacked: true, position: 'left', grid: { color: css('--grid') }, border: { color: css('--axis') }, ticks: { color: css('--text-muted'), font: { size: 11 }, callback: (v) => `$${v}` } },
        yPct: { position: 'right', min: 0, max: 100, grid: { display: false }, border: { color: css('--axis') }, ticks: { color: css('--text-muted'), font: { size: 11 }, callback: (v) => `${v}%` } },
      },
      plugins: {
        tooltip: {
          callbacks: {
            label: (c) => (c.dataset.yAxisID === 'yPct'
              ? ` ${c.dataset.label}: ${c.parsed.y.toFixed(0)}%`
              : (c.parsed.y > 0 ? ` ${c.dataset.label}: ${usd(c.parsed.y)}` : null)),
            footer: (items) => {
              const cost = items.filter((i) => i.dataset.yAxisID === 'yCost').reduce((s, i) => s + i.parsed.y, 0);
              return cost > 0 ? `當週合計 ${usd(cost)}` : '';
            },
          },
        },
      },
    }),
  });
}

/* ============================== TAB 2 ============================== */
function drawPrompts() {
  const d = state.prompts;
  if (!d) return;
  const rows = d.prompts;
  const top = rows.slice(0, 15);

  // 依量級排序 -> 使用單一色相。藏有 workflow 成本的 turn 則改用警示色。
  render('chart-prompts', {
    type: 'bar',
    data: {
      labels: top.map((_, i) => `#${i + 1}`),
      datasets: [{
        label: '實際成本 (USD)',
        data: top.map((p) => p.trueCost),
        backgroundColor: top.map((p) => (p.workflowCost > 0.01 ? css('--series-write') : css('--series-1'))),
        borderRadius: 4,
        borderSkipped: false,
      }],
    },
    options: baseOpts({
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => `#${items[0].dataIndex + 1} · ${top[items[0].dataIndex].projectLabel}`,
            label: (c) => {
              const p = top[c.dataIndex];
              const out = [` 實際成本 ${usd4(p.trueCost)}`];
              if (p.workflowCost > 0.01) out.push(` 其中 workflow ${usd4(p.workflowCost)}（ccusage 看不到）`);
              out.push(` ${p.snippet.slice(0, 46)}…`);
              return out;
            },
          },
        },
      },
      scales: { y: { ticks: { color: css('--text-muted'), font: { size: 11 }, callback: (v) => `$${v}` } } },
    }),
  });

  $('#table-prompts').innerHTML = `
    <thead><tr>
      <th class="num">#</th><th>語句（點擊展開全文）</th><th>專案</th><th>時間</th>
      <th class="num">實際成本</th><th class="num">其中 workflow</th><th class="num">輸出 tokens</th>
    </tr></thead>
    <tbody>${rows.map((p, i) => `
      <tr class="clickable" data-prompt="${p.promptId}">
        <td class="num rank">${i + 1}</td>
        <td class="snippet">${escapeHtml(p.snippet)}</td>
        <td class="muted">${escapeHtml(p.projectLabel ?? '—')}</td>
        <td class="muted">${when(p.timestamp)}</td>
        <td class="num"><strong>${usd4(p.trueCost)}</strong></td>
        <td class="num ${p.workflowCost > 0.01 ? 'delta-up' : 'muted'}">${p.workflowCost > 0.01 ? usd4(p.workflowCost) : '—'}</td>
        <td class="num">${compact(p.tokens.output)}</td>
      </tr>`).join('')}
    </tbody>`;

  document.querySelectorAll('#table-prompts tr[data-prompt]').forEach((tr) => {
    tr.addEventListener('click', () => showPrompt(tr.dataset.prompt));
  });
}

async function showPrompt(id) {
  const p = await api(`/api/prompts/${id}`);
  const wf = p.workflowCost > 0.01;
  $('#modal-body').innerHTML = `
    <h3>語句明細</h3>
    <div class="meta-grid">
      <div>實際成本<strong>${usd4(p.trueCost)}</strong></div>
      <div>ccusage 計算<strong>${usd4(p.ccusageCost)}</strong></div>
      <div class="${wf ? 'accent' : ''}">workflow（隱藏）<strong style="${wf ? `color:${css('--warn')}` : ''}">${usd4(p.workflowCost)}</strong></div>
      <div>專案<strong>${escapeHtml(p.projectLabel ?? '—')}</strong></div>
      <div>時間<strong style="font-size:12px">${when(p.timestamp)}</strong></div>
    </div>
    <h3>Token 明細</h3>
    <div class="scroll-x"><table>
      <thead><tr><th>類別</th><th class="num">數量</th></tr></thead>
      <tbody>
        <tr><td>輸入</td><td class="num">${num(p.tokens.input)}</td></tr>
        <tr><td>輸出</td><td class="num">${num(p.tokens.output)}</td></tr>
        <tr><td>快取寫入 5m</td><td class="num">${num(p.tokens.cacheWrite5m)}</td></tr>
        <tr><td>快取寫入 1h</td><td class="num">${num(p.tokens.cacheWrite1h)}</td></tr>
        <tr class="muted"><td>快取讀取</td><td class="num">${num(p.tokens.cacheRead)}</td></tr>
      </tbody>
    </table></div>
    ${p.byModel?.length ? `<h3>各模型</h3><div class="scroll-x"><table>
      <thead><tr><th>模型</th><th class="num">成本</th></tr></thead>
      <tbody>${p.byModel.map((m) => `<tr><td><span class="swatch" style="background:${colorForModel(m.model)}"></span>${escapeHtml(m.model)}</td><td class="num">${usd4(m.cost)}</td></tr>`).join('')}</tbody>
    </table></div>` : ''}
    <h3>完整原文</h3>
    <div class="prompt-full">${escapeHtml(p.text ?? '')}</div>`;
  $('#modal').hidden = false;
}

/* ============================== TAB 3 ============================== */

/* session 表格的排序清單會被保存下來，所以下次進來會維持同樣的排序。
   清單本身由 lib.js 負責（驗證／循環／排序）；這半邊只負責儲存與重繪。 */
const SESSION_SORT_KEY = 'sessions-sort';

function loadSessionSort() {
  try {
    return sanitizeSessionSort(JSON.parse(localStorage.getItem(SESSION_SORT_KEY) ?? '[]'));
  } catch {
    return [];
  }
}

let sessionSort = loadSessionSort();

function cycleSessionSort(key) {
  const next = cycleSort(sessionSort, key);
  if (next === sessionSort) return; // 不認識的欄位：沒有東西要存，也不用重繪
  sessionSort = next;
  try {
    localStorage.setItem(SESSION_SORT_KEY, JSON.stringify(sessionSort));
  } catch { /* private mode / quota: sorting still works for this visit */ }
  renderSessionsTable();
}

function sortableTh(key, label, cls = '') {
  const { active, aria, arrow, rank } = sortIndicator(sessionSort, key);
  const rankHtml = rank == null ? '' : `<sup class="sort-rank">${rank}</sup>`;
  return `<th class="sortable${active ? ' sorted' : ''}${cls ? ` ${cls}` : ''}" data-sort="${key}" role="button" tabindex="0" aria-sort="${aria}" title="點擊排序：升冪 → 降冪 → 取消">${escapeHtml(label)}<span class="sort-ind">${arrow}</span>${rankHtml}</th>`;
}

/* 從 drawSessions() 拆出來，讓點擊標頭時只重繪表格，不去動專案那張圖。 */
function renderSessionsTable() {
  const d = state.sessions;
  if (!d) return;
  const rows = sortRows(d.sessions, sessionSort);

  $('#table-sessions').innerHTML = `
    <thead><tr>
      <th class="num">#</th>${sortableTh('projectLabel', '專案')}<th>Session</th>${sortableTh('lastActivity', '最後活動')}${sortableTh('promptCount', '語句', 'num')}
      <th class="num">ccusage 數字</th>${sortableTh('trueCost', '實際成本', 'num')}<th class="num">差額</th>
    </tr></thead>
    <tbody>${rows.map((s, i) => `
      <tr class="clickable" data-session="${s.sessionId}">
        <td class="num rank">${i + 1}</td>
        <td>${escapeHtml(s.projectLabel ?? '—')}</td>
        <td class="muted"><code>${s.sessionId.slice(0, 8)}</code></td>
        <td class="muted">${when(s.lastActivity)}</td>
        <td class="num">${s.promptCount}</td>
        <td class="num muted">${usd(s.ccusageCost)}</td>
        <td class="num"><strong>${usd(s.trueCost)}</strong></td>
        <td class="num ${s.workflowCost > 0.01 ? 'delta-up' : 'muted'}">${s.workflowCost > 0.01 ? `+${usd(s.workflowCost)}` : '—'}</td>
      </tr>`).join('')}
    </tbody>`;

  document.querySelectorAll('#table-sessions tr[data-session]').forEach((tr) => {
    tr.addEventListener('click', () => showSession(tr.dataset.session));
  });
  document.querySelectorAll('#table-sessions th.sortable').forEach((th) => {
    th.addEventListener('click', () => cycleSessionSort(th.dataset.sort));
    th.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        cycleSessionSort(th.dataset.sort);
      }
    });
  });
}

function drawSessions() {
  const d = state.sessions;
  if (!d) return;
  const t = d.totals;
  const pct = t.ccusageCost ? (t.workflowCost / t.ccusageCost) * 100 : 0;

  $('#hidden-summary').innerHTML = `
    <div>ccusage session 合計<strong>${usd(t.ccusageCost)}</strong></div>
    <div class="accent">被漏算的 workflow<strong>${usd(t.workflowCost)}</strong></div>
    <div>實際合計<strong>${usd(t.trueCost)}</strong></div>
    <div>低估比例<strong>${pct.toFixed(1)}%</strong></div>`;

  renderSessionsTable();

  const projects = state.projects?.projects ?? [];
  render('chart-projects', {
    type: 'bar',
    data: {
      labels: projects.map((p) => p.project),
      datasets: [{
        label: '實際成本 (USD)',
        data: projects.map((p) => p.trueCost),
        backgroundColor: projects.map((p) => (p.workflowCost > 0.01 ? css('--series-write') : css('--series-1'))),
        borderRadius: 4,
        borderSkipped: false,
      }],
    },
    options: baseOpts({
      indexAxis: 'y',
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) => {
              const p = projects[c.dataIndex];
              const out = [` 實際成本 ${usd(p.trueCost)}`, ` ${p.sessions} 個 session · ${p.prompts} 句`];
              if (p.workflowCost > 0.01) out.push(` 含 workflow ${usd(p.workflowCost)}`);
              return out;
            },
          },
        },
      },
      scales: { x: { ticks: { color: css('--text-muted'), font: { size: 11 }, callback: (v) => `$${v}` } } },
    }),
  });
}

async function showSession(id) {
  const s = await api(`/api/sessions/${id}`);
  const turns = s.turns.filter((t) => t.trueCost > 0).slice(0, 60);
  $('#modal-body').innerHTML = `
    <h3>Session ${escapeHtml(s.sessionId.slice(0, 8))} · ${escapeHtml(s.projectLabel ?? '')}</h3>
    <div class="meta-grid">
      <div>實際成本<strong>${usd(s.trueCost)}</strong></div>
      <div>ccusage 數字<strong>${usd(s.ccusageCost)}</strong></div>
      <div>workflow（隱藏）<strong style="${s.workflowCost > 0.01 ? `color:${css('--warn')}` : ''}">${usd(s.workflowCost)}</strong></div>
      <div>語句數<strong>${s.promptCount}</strong></div>
      <div>路徑<strong style="font-size:11px;word-break:break-all">${escapeHtml(s.projectPath ?? '—')}</strong></div>
    </div>
    <h3>該 session 內最花費的語句</h3>
    <div class="scroll-x"><table>
      <thead><tr><th>語句</th><th class="num">實際成本</th><th class="num">workflow</th></tr></thead>
      <tbody>${turns.map((t) => `
        <tr class="${t.promptId === '__unattributed__' ? 'muted' : 'clickable'}" ${t.promptId === '__unattributed__' ? '' : `data-prompt="${t.promptId}"`}>
          <td class="snippet">${escapeHtml(t.snippet)}</td>
          <td class="num">${usd4(t.trueCost)}</td>
          <td class="num ${t.workflowCost > 0.01 ? 'delta-up' : 'muted'}">${t.workflowCost > 0.01 ? usd4(t.workflowCost) : '—'}</td>
        </tr>`).join('')}</tbody>
    </table></div>`;
  $('#modal').hidden = false;
  document.querySelectorAll('#modal-body tr[data-prompt]').forEach((tr) => {
    tr.addEventListener('click', () => showPrompt(tr.dataset.prompt));
  });
}

/* ============================== health ============================== */
function drawHealth() {
  const h = state.health;
  if (!h) return;
  const b = $('#banner');
  const msgs = [];
  let cls = 'ok';

  // 在完全沒有記錄的機器上第一次執行：給出說明，而不是一整面的 0。
  const noData = h.analysis?.files === 0;
  if (noData) {
    cls = 'warn';
    msgs.push(
      `這台電腦找不到 Claude Code 的使用紀錄（<code>${escapeHtml(h.analysis.dataDir ?? '~/.claude/projects')}</code> 沒有任何對話檔案）。` +
      `需要先安裝並使用過 <strong>Claude Code</strong>，儀表板才有資料可以分析。`,
    );
  }
  if (h.ccusage?.error && !noData) {
    cls = 'error';
    msgs.push(`ccusage 無法執行（${h.ccusage.error.kind}）：${escapeHtml(h.ccusage.error.message)}`);
  }
  if (!h.pricing?.source) {
    cls = 'error';
    msgs.push('沒有定價資料，成本一律顯示「—」。');
  } else if (h.pricing.stale) {
    cls = 'warn';
    msgs.push(`定價快照已 ${h.pricing.ageDays} 天未更新。`);
  }
  if (h.reconcile && !h.reconcile.ok) {
    cls = 'warn';
    msgs.push(`與 ccusage 對帳誤差 ${h.reconcile.pct.toFixed(2)}%，超過 ${h.reconcile.tolerancePct}% 容差。`);
  }
  // 讀不到的記錄檔裡的成本，不會出現在這個頁面的任何數字上。
  // 這裡若保持沉默，看起來就跟「你花得比較少」一模一樣。
  const unread = h.analysis?.readErrors ?? [];
  if (unread.length) {
    cls = 'error';
    const codes = [...new Set(unread.map((e) => e.code))].join('、');
    msgs.push(
      `有 ${num(unread.length)} 個對話檔讀取失敗（${escapeHtml(codes)}），` +
      `其中的成本沒有計入任何數字。範例：<code>${escapeHtml(unread[0].file)}</code>`,
    );
  }
  // 沒有這個，卡片就只是消失，那會被讀成「沒有這筆支出」，
  // 而不是「我讀不到它」。
  if (state.overview?.localAgent?.error) {
    cls = 'warn';
    msgs.push(`讀不到 local agent 排程任務的紀錄（${escapeHtml(state.overview.localAgent.error)}），該筆支出未顯示。`);
  }

  if (msgs.length) {
    b.className = `banner ${cls}`;
    b.innerHTML = msgs.join('<br>');
    b.hidden = false;
  } else {
    b.hidden = true;
  }

  const r = h.reconcile;
  $('#footer').innerHTML = `
    定價：${h.pricing.source ?? '無'}（${h.pricing.modelCount} 個模型）· ${h.ccusage.version ?? 'ccusage 不可用'} ·
    分析 ${h.analysis.files} 個檔案／${h.analysis.sessions} 個 session，耗時 ${h.analysis.parseMs}ms<br>
    ${r ? `對帳：本工具 ${usd(r.ours)} vs ccusage ${usd(r.ccusageClaude)}（誤差 ${r.pct.toFixed(2)}%，容差 ${r.tolerancePct}%）· ` : ''}
    未能歸因 ${usd(h.unattributed.cost)}（${h.unattributed.pct.toFixed(2)}%）`;
}

/* ============================== 更新檢查 ============================== */
/** 反覆輪詢 /api/health，直到重啟後的伺服器重新回應為止。 */
async function waitForServer(ms = 120_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      if ((await fetch('/api/health')).ok) return;
    } catch {
      // 還在重啟中
    }
  }
  throw new Error('伺服器未在預期時間內重啟，請手動重新啟動（start.bat）');
}

function showUpdateToast(u) {
  const el = $('#update-toast');
  const isZip = u.mode === 'zip';
  el.innerHTML = `
    <div class="toast-title">有新版本可更新</div>
    <div class="toast-body">${isZip
      ? `新版本 <strong>${escapeHtml(u.latest.version)}</strong>（目前 ${escapeHtml(u.current.version)}）·
         下載 zip 解壓覆蓋原資料夾後，重新執行 start.bat`
      : `落後 <strong>${u.behind}</strong> 個提交 ·
         最新：${escapeHtml(u.latest.subject)} <code>${escapeHtml(u.latest.hash)}</code>`}
    </div>
    <div class="toast-actions">
      <button class="btn" id="update-apply">${isZip ? '前往下載新版' : '立即更新'}</button>
      <button class="btn ghost" id="update-dismiss">忽略此版</button>
    </div>`;
  el.hidden = false;

  const dismissKey = isZip ? u.latest.version : u.latest.hash;
  $('#update-dismiss').addEventListener('click', () => {
    localStorage.setItem('update-dismissed', dismissKey);
    el.hidden = true;
  });

  if (isZip) {
    $('#update-apply').addEventListener('click', () => {
      window.open(u.downloadUrl, '_blank');
    });
    return;
  }

  $('#update-apply').addEventListener('click', async () => {
    const body = el.querySelector('.toast-body');
    const btns = el.querySelectorAll('button');
    btns.forEach((b) => { b.disabled = true; });
    body.innerHTML = '更新中…';
    try {
      const r = await api('/api/update', { method: 'POST' });
      if (!r.restarting) {
        el.hidden = true;
        return;
      }
      body.innerHTML = `已更新至 <code>${escapeHtml(r.after)}</code>，伺服器重新啟動中…`;
      await waitForServer();
      location.reload();
    } catch (err) {
      body.innerHTML = `更新失敗：${escapeHtml(err.message)}`;
      btns.forEach((b) => { b.disabled = false; });
    }
  });
}

/** 啟動時射後不理：更新檢查失敗絕不能把儀表板弄壞。 */
async function checkUpdate() {
  try {
    const u = await api('/api/update-check');
    if (!u.supported || !u.behind) return;
    const dismissKey = u.mode === 'zip' ? u.latest.version : u.latest.hash;
    if (localStorage.getItem('update-dismissed') === dismissKey) return;
    showUpdateToast(u);
  } catch {
    // 安靜處理：就算沒有更新資訊，儀表板一樣運作正常
  }
}

/* ============================== TAB 7 ============================== */
/**
 * local agent mode：桌面版的排程任務。屬於帳外支出 ——
 * 為什麼它不計入總成本，見面板上的說明區塊與 localagent.js。
 */
function drawLocalAgent() {
  const d = state.localagent;
  if (!d?.available) return;

  const runs = d.runs ?? [];

  // `available` 是「機器層級」的：這台機器有 local agent 的記錄，所以這個分頁存在。
  // 但日期篩選仍然可能選到一段沒有任何執行的區間 —— 這時要說明發生了什麼、
  // 以及資料實際在哪裡，而不是顯示一個 $0.00 配一個破折號，讓人以為壞掉了。
  $('#la-card-tasks').hidden = runs.length === 0;
  $('#la-card-runs').hidden = runs.length === 0;
  if (!runs.length) {
    const since = $('#date-since').value;
    const until = $('#date-until').value;
    const range = since || until ? `${since || '最早'} ~ ${until || '最新'}` : '目前選取的範圍';
    $('#kpi-localagent').innerHTML = `
      <div class="kpi" style="grid-column: 1 / -1">
        <div class="label" style="font-size: 14px; color: var(--text-primary)">這個時間範圍內沒有排程執行</div>
        <div class="foot">
          已選 ${escapeHtml(range)}。現有紀錄涵蓋 <strong>${escapeHtml(d.firstDay ?? '—')} 至 ${escapeHtml(d.lastDay ?? '—')}</strong>，
          ${num(d.totalRuns)} 次執行共 ${usd(d.totalCost)}——把日期拉到那段區間就看得到。
        </div>
      </div>`;
    return;
  }
  const scheduled = runs.filter((r) => r.scheduled);
  // 人們真正想看的穩定狀態數字：那些無人看管的執行「每次觸發」花多少錢，
  // 不去算你坐在那邊調整任務的那個昂貴的日子。
  const avgScheduled = scheduled.length ? scheduled.reduce((s, r) => s + r.cost, 0) / scheduled.length : 0;
  const last = runs[0]; // 已依時間由新到舊排序

  $('#la-datadir').textContent = `資料來源：${d.dataDir}`;
  $('#kpi-localagent').innerHTML = `
    <div class="kpi wide">
      <div class="label">local agent 總支出</div>
      <div class="value hero">${usd(d.cost)}</div>
      <div class="foot">${num(runs.length)} 次執行 · ${compact(d.tokens)} tokens · 未計入首頁總成本</div>
    </div>
    <div class="kpi">
      <div class="label">排程執行平均每次</div>
      <div class="value">${usd4(avgScheduled)}</div>
      <div class="foot">${num(scheduled.length)} 次自動執行，不含手動設定</div>
    </div>
    <div class="kpi">
      <div class="label">最近一次</div>
      <div class="value">${last ? usd4(last.cost) : '—'}</div>
      <div class="foot">${last ? `${when(last.startedAt)} · ${escapeHtml(last.task)}` : '—'}</div>
    </div>`;

  $('#table-la-tasks').innerHTML = `
    <thead><tr>
      <th>任務</th><th class="num">執行次數</th><th class="num">總成本</th>
      <th class="num">平均每次</th><th class="num">tokens</th><th>最近一次</th><th>模型</th>
    </tr></thead>
    <tbody>${d.byTask.map((t) => `
      <tr>
        <td>${t.scheduled ? `<code>${escapeHtml(t.task)}</code>` : `<span class="muted">${escapeHtml(t.task)}</span>`}</td>
        <td class="num">${num(t.runs)}</td>
        <td class="num"><strong>${usd4(t.cost)}</strong></td>
        <td class="num">${usd4(t.avgCost)}</td>
        <td class="num muted">${compact(t.tokens)}</td>
        <td class="muted">${when(t.lastRun)}</td>
        <td>${t.models.map((m) => `<span class="swatch" style="background:${colorForModel(m)}"></span>`).join('')}${escapeHtml(t.models.map((m) => m.replace(/^claude-/, '')).join('、'))}</td>
      </tr>`).join('')}
    </tbody>`;

  // x 軸由舊到新，讓圖表可以由左至右依時間閱讀。
  const series = [...runs].reverse();
  render('chart-la-runs', {
    type: 'bar',
    data: {
      labels: series.map((r) => (r.startedAt ? r.startedAt.slice(5, 16).replace('T', ' ') : '—')),
      datasets: [{
        label: '每次執行成本',
        data: series.map((r) => r.cost),
        backgroundColor: series.map((r) => (r.scheduled ? css('--series-1') : css('--series-write'))),
        borderRadius: 3,
        borderSkipped: false,
      }],
    },
    options: baseOpts({
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => series[items[0].dataIndex].task,
            label: (c) => {
              const r = series[c.dataIndex];
              return [` ${usd4(r.cost)} · ${num(r.messages)} 則訊息`, ` ${when(r.startedAt)}`, r.scheduled ? ' 排程自動執行' : ' 手動執行'];
            },
          },
        },
      },
      scales: {
        x: { grid: { display: false }, border: { color: css('--axis') }, ticks: { color: css('--text-muted'), font: { size: 10 }, maxRotation: 60 } },
        y: { grid: { color: css('--grid') }, border: { color: css('--axis') }, ticks: { color: css('--text-muted'), font: { size: 11 }, callback: (v) => `$${v}` } },
      },
    }),
  });

  $('#table-la-runs').innerHTML = `
    <thead><tr>
      <th>開始時間</th><th>任務</th><th class="num">成本</th>
      <th class="num">訊息</th><th class="num">tokens</th><th>起始語句</th>
    </tr></thead>
    <tbody>${runs.map((r) => `
      <tr>
        <td>${when(r.startedAt)}</td>
        <td>${r.scheduled ? `<code>${escapeHtml(r.task)}</code>` : `<span class="muted">${escapeHtml(r.task)}</span>`}</td>
        <td class="num"><strong>${usd4(r.cost)}</strong></td>
        <td class="num">${num(r.messages)}</td>
        <td class="num muted">${compact(r.tokens)}</td>
        <td class="snippet muted">${escapeHtml(r.prompt ?? '—')}</td>
      </tr>`).join('')}
    </tbody>`;
}

/* ============================== boot ============================== */

/**
 * 每一條 fetch 路徑都會經過這裡，讓頁面不會在無聲無息中處於忙碌狀態。
 * 用計數而不是布林值：語句篩選可能在區間重新載入還沒回來時就被觸發，
 * 而先完成的那一個不該把進度條清掉。
 */
let inflight = 0;
function setBusy(on) {
  inflight = Math.max(0, inflight + (on ? 1 : -1));
  const busy = inflight > 0;
  $('#progress').hidden = !busy;
  // 變暗效果只用於重新載入。骨架還在時，底下本來就沒有值得閱讀的東西，
  // 再把它淡化只會讓那些骨架變得更混濁。
  document.body.classList.toggle('loading', busy && !document.body.classList.contains('booting'));
}

/** 預先放在 index.html 的骨架，過了這個點就不再是佔位符，而會變成謊言。 */
function clearBootSkeleton() {
  document.body.classList.remove('booting');
  $('#kpi-overview').removeAttribute('aria-busy');
  $('#boot-note')?.remove();
}

/**
 * 載入失敗就必須講出來。啟動時畫面上還沒有任何東西，所以連骨架也一併拆掉；
 * 重新整理時則保留原本的數字，只在上方加一條橫幅。
 * 下一次成功載入時會由 drawHealth() 覆蓋掉它。
 */
function showLoadError(err, { boot = false } = {}) {
  $('#banner').className = 'banner error';
  $('#banner').textContent = `${boot ? '載入失敗' : '重新整理失敗'}：${err.message}`;
  $('#banner').hidden = false;
  if (boot) {
    clearBootSkeleton();
    $('#kpi-overview').innerHTML = '';
  }
}

async function withBusy(fn) {
  setBusy(true);
  try {
    return await fn();
  } finally {
    setBusy(false);
  }
}

const loadAll = () => withBusy(fetchAll);

async function fetchAll() {
  const [overview, cachewrite, improvements, trend, prompts, sessions, projects, health, localagent] = await Promise.all([
    api(withRange('/api/overview')).catch((e) => ({ error: e.message, models: [], daily: [], monthly: [], totalCost: 0, claudeCost: 0, otherCost: 0 })),
    api(withRange('/api/cache-writes', { limit: 30 })),
    api(withRange('/api/improvements')),
    api(withRange('/api/trend')),
    api(withRange('/api/prompts', { limit: $('#filter-limit').value, project: $('#filter-project').value })),
    api(withRange('/api/sessions')),
    api(withRange('/api/projects')),
    api('/api/health'),
    // 這是選用功能：沒有 local agent mode 的機器不該因此導致載入失敗。
    api(withRange('/api/localagent')).catch(() => ({ available: false, runs: [], byTask: [] })),
  ]);
  Object.assign(state, { overview, cachewrite, improvements, trend, prompts, sessions, projects, health, localagent });

  $('#tab-btn-localagent').hidden = !localagent.available;

  const sel = $('#filter-project');
  if (sel.options.length <= 1) {
    for (const p of projects.projects) {
      const o = document.createElement('option');
      o.value = p.project;
      o.textContent = `${p.project} (${usd(p.trueCost)})`;
      sel.appendChild(o);
    }
  }

  // 只有目前可見的分頁會繪製 —— 為什麼隱藏的圖表不能被建立，見 showTab()。
  showTab(document.querySelector('.tab.active')?.dataset.tab ?? 'overview');
  drawHealth();
  clearBootSkeleton(); // 真正的內容已經進來了
}

const reloadPrompts = () => withBusy(async () => {
  state.prompts = await api(
    withRange('/api/prompts', { limit: $('#filter-limit').value, project: $('#filter-project').value }),
  );
  drawPrompts();
});

const DRAW = { overview: drawOverview, cachewrite: drawCacheWrite, improve: drawImprove, trend: drawTrend, prompts: drawPrompts, sessions: drawSessions, localagent: drawLocalAgent };

/**
 * 切換到某個分頁，並（重新）建立它的圖表。
 *
 * 圖表必須在它所屬的面板「可見時」才能建立：在 display:none 的面板裡建立的 canvas
 * 量到的尺寸是 0x0，而且 Chart.js 事後救不回來 —— 對這種實例呼叫 resize() 仍然是 0x0。
 * 所以我們在顯示分頁時重繪它的圖表。render() 會先把前一個實例銷毀，
 * 因此這個做法成本很低，而且具冪等性。
 */
function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
  DRAW[name]?.();
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => showTab(tab.dataset.tab));
});

$('#filter-project').addEventListener('change', reloadPrompts);
$('#filter-limit').addEventListener('change', reloadPrompts);

// 成本趨勢的期間切換（日／月／年）—— 只重新分桶，不重新抓資料。
document.querySelectorAll('#daily-period button').forEach((b) => {
  b.addEventListener('click', () => drawDailyTrend(b.dataset.p));
});

// Date range: a preset fills the dates and reloads; editing a date switches to "自訂".
$('#date-preset').addEventListener('change', () => {
  if ($('#date-preset').value === 'custom') return;
  applyPreset();
  loadAll();
});
for (const id of ['#date-since', '#date-until']) {
  $(id).addEventListener('change', () => {
    $('#date-preset').value = 'custom';
    loadAll();
  });
}

/* ============================== export ============================== */
/** The active range; falls back to the loaded data's first/last day when 「全部」. */
function exportRange() {
  return exportRangeFrom(
    { since: $('#date-since').value, until: $('#date-until').value },
    (state.overview?.daily ?? []).map((x) => x.period),
  );
}

$('#export').addEventListener('click', () => {
  const { since, until } = exportRange();
  if (!since || !until) {
    alert('目前沒有可匯出的日期範圍，請先選擇起訖日。');
    return;
  }
  $('#modal-body').innerHTML = `
    <h3>匯出 ccusage 每日用量</h3>
    <p class="hint">
      範圍 <strong>${since} ~ ${until}</strong>（依目前選擇的時間範圍）·
      檔名為 <code>工號_${since}_${until}_使用位置.json</code>
    </p>
    <form id="export-form" class="export-form">
      <label>工號 <input id="export-empid" required autocomplete="off"></label>
      <label>使用位置
        <select id="export-device" required>
          <option value="company">公司桌機 (company)</option>
          <option value="nb">自備筆電 (nb)</option>
          <option value="home">家中使用 (home)</option>
        </select>
      </label>
      <div id="export-error" class="export-error" hidden></div>
      <button class="btn" type="submit">匯出 JSON</button>
    </form>`;
  $('#export-empid').value = localStorage.getItem('export-empid') ?? '';
  $('#export-device').value = localStorage.getItem('export-device') || 'company';
  $('#modal').hidden = false;
  $('#export-empid').focus();

  $('#export-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const empId = sanitizeEmpId($('#export-empid').value);
    const device = $('#export-device').value;
    if (!empId) {
      const box = $('#export-error');
      box.textContent = '工號為必填。';
      box.hidden = false;
      return;
    }
    localStorage.setItem('export-empid', empId);
    localStorage.setItem('export-device', device);

    const btn = e.target.querySelector('button');
    btn.disabled = true;
    btn.textContent = '匯出中…';
    try {
      const p = new URLSearchParams({ since, until, empId, device });
      const res = await fetch(`/api/export?${p}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await res.blob());
      a.download = `${empId}_${since}_${until}_${device}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      $('#modal').hidden = true;
    } catch (err) {
      const box = $('#export-error');
      box.textContent = `匯出失敗：${err.message}`;
      box.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = '匯出 JSON';
    }
  });
});

$('#refresh').addEventListener('click', async (e) => {
  const btn = e.target;
  btn.disabled = true;
  btn.textContent = '重新整理中…';
  try {
    // withBusy 也涵蓋這個 POST：丟掉快取是整趟往返裡最慢的一段，
    // 而它以前跑的時候既沒有進度條也沒有變暗 ——
    // 按鈕上的文字是唯一能看出「有事在發生」的線索。
    // 這裡用 fetchAll 而不是 loadAll，這樣 setBusy 才不會被計算兩次。
    await withBusy(async () => {
      await api('/api/refresh', { method: 'POST' });
      await fetchAll();
    });
  } catch (err) {
    // 沒有這段，那個 rejection 會被吞掉，頁面就會安靜地continue顯示過期的數字，
    // 好像重新整理成功了一樣。
    showLoadError(err);
  } finally {
    btn.disabled = false;
    btn.textContent = '重新整理';
  }
});

$('#modal-close').addEventListener('click', () => { $('#modal').hidden = true; });
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('#modal').hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#modal').hidden = true; });

// 深淺色切換在兩個方向上都必須蓋過作業系統的設定。
$('#theme-toggle').addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme');
  const next = cur === 'dark' ? 'light' : cur === 'light' ? 'dark'
    : (matchMedia('(prefers-color-scheme: dark)').matches ? 'light' : 'dark');
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
  modelColors.clear();
  showTab(document.querySelector('.tab.active')?.dataset.tab ?? 'overview');
});
const saved = localStorage.getItem('theme');
if (saved) document.documentElement.setAttribute('data-theme', saved);

// 字體縮放：放大／縮小整個 UI，並跨工作階段保存。
// 會把狀態反映到那個儀表式控制項上 —— 滑桿、已填滿的軌道、會即時變大的 A，
// 以及那個等寬字的 % 讀數（偏離 100% 時會亮起，表示可以重設）。
function applyFontScale() {
  document.documentElement.style.zoom = fontScale;
  const f = (fontScale - FONT_MIN) / (FONT_MAX - FONT_MIN); // 0..1
  $('#font-range').value = Math.round(fontScale * 100);
  $('#font-fill').style.width = `${2 + f * 100}px`;
  $('#font-glyph').style.setProperty('--fz-gs', `${(12 + f * 10).toFixed(1)}px`);
  $('#font-pct').textContent = `${Math.round(fontScale * 100)}%`;
  $('#font-reset').classList.toggle('dirty', fontScale !== 1);
}
function setFontScale(v) {
  fontScale = clampFont(v);
  localStorage.setItem('font-scale', String(fontScale));
  applyFontScale();
  // 重新繪製圖表，讓它們的 canvas 點陣圖在新的縮放比例下維持清晰。
  showTab(document.querySelector('.tab.active')?.dataset.tab ?? 'overview');
}
$('#font-inc').addEventListener('click', () => setFontScale(fontScale + FONT_STEP));
$('#font-dec').addEventListener('click', () => setFontScale(fontScale - FONT_STEP));
$('#font-range').addEventListener('input', (e) => setFontScale(e.target.value / 100));
$('#font-reset').addEventListener('click', () => { if (fontScale !== 1) setFontScale(1); });
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.key === '=' || e.key === '+') { e.preventDefault(); setFontScale(fontScale + FONT_STEP); }
  else if (e.key === '-' || e.key === '_') { e.preventDefault(); setFontScale(fontScale - FONT_STEP); }
  else if (e.key === '0') { e.preventDefault(); setFontScale(1); }
});
applyFontScale();

applyPreset(); // default: 近 1 個月
loadAll().catch((err) => showLoadError(err, { boot: true }));
checkUpdate();
