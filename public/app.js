/* AI usage dashboard — vanilla JS + vendored Chart.js. */

const $ = (sel) => document.querySelector(sel);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const usd = (n) =>
  n == null ? '—' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const usd4 = (n) => (n == null ? '—' : `$${n.toFixed(n < 1 ? 4 : 2)}`);
const num = (n) => (n == null ? '—' : n.toLocaleString('en-US'));
const compact = (n) =>
  n == null ? '—' : Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
const when = (ts) => (ts ? new Date(ts).toLocaleString('zh-TW', { hour12: false }) : '—');

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Categorical slots, assigned in fixed order and never cycled. */
const SLOTS = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-5', '--series-6', '--series-7', '--series-8'];

/** model -> a stable slot, so a model keeps its colour across every chart and filter. */
const modelColors = new Map();
function colorForModel(model) {
  if (!modelColors.has(model)) {
    modelColors.set(model, SLOTS[modelColors.size % SLOTS.length]);
  }
  return css(modelColors.get(model));
}

const api = async (path, opts) => {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), body);
  return body;
};

/* UI font zoom (CSS `zoom` on <html>) — one path for web and Electron, which
   both render this same page. `zoom` doesn't raise devicePixelRatio, so canvas
   charts would upscale and blur; render() compensates via config.devicePixelRatio. */
const FONT_MIN = 0.8, FONT_MAX = 1.6, FONT_STEP = 0.1;
let fontScale = clampFont(parseFloat(localStorage.getItem('font-scale')) || 1);
function clampFont(v) {
  // 5% granularity: matches the slider step and keeps ±10% button/keyboard steps clean.
  return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(v * 20) / 20));
}

let charts = {};
function render(id, config) {
  charts[id]?.destroy();
  const ctx = document.getElementById(id);
  if (!ctx) return;
  config.options = { ...config.options, devicePixelRatio: window.devicePixelRatio * fontScale };
  charts[id] = new Chart(ctx, config);
}

/* Recessive grid/axes; tooltips on by default. */
function baseOpts(extra = {}) {
  const grid = css('--grid');
  const tick = css('--text-muted');
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'nearest', intersect: false },
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
const state = { overview: null, cachewrite: null, improvements: null, trend: null, prompts: null, sessions: null, projects: null, health: null };

/* ============================== date range ============================== */
const fmtDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Fill the date inputs from the selected preset. "custom" leaves them untouched. */
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
  from.setDate(from.getDate() - (Number(v) - 1)); // inclusive of today
  $('#date-since').value = fmtDate(from);
  $('#date-until').value = fmtDate(now);
}

/** Build a URL with the active date range (and any extra query params) applied. */
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

  $('#kpi-overview').innerHTML = `
    <div class="kpi">
      <div class="label">總成本（所有 agent）</div>
      <div class="value hero">${usd(d.totalCost)}</div>
      <div class="foot">Claude ${usd(d.claudeCost)}（${claudeShare.toFixed(1)}%）· 其他 ${usd(d.otherCost)}</div>
    </div>
    <div class="kpi accent">
      <div class="label">ccusage session 看不到的支出</div>
      <div class="value">${usd(hidden)}</div>
      <div class="foot">workflow subagent 成本</div>
    </div>
    <div class="kpi">
      <div class="label">已分析語句</div>
      <div class="value">${num(state.prompts?.totalPrompts ?? 0)}</div>
      <div class="foot">Claude Code，共 ${num(state.sessions?.sessions.length ?? 0)} 個 session</div>
    </div>
    <div class="kpi">
      <div class="label">使用模型</div>
      <div class="value">${d.models.length}</div>
      <div class="foot">${d.models.slice(0, 2).map((m) => m.model).join('、')}…</div>
    </div>`;

  // Cost by model — ranked magnitude, one bar per entity, entity-stable colour.
  const models = d.models;
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
        legend: { display: false }, // single series — the title names it
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

/** Re-bucket ccusage rows: sum modelBreakdowns per keyOf(period). */
function bucketBy(src, keyOf) {
  const map = new Map();
  for (const r of src) {
    const k = keyOf(String(r.period));
    const agg = map.get(k) ?? { period: k, modelBreakdowns: new Map() };
    for (const b of r.modelBreakdowns ?? []) {
      agg.modelBreakdowns.set(b.modelName, (agg.modelBreakdowns.get(b.modelName) ?? 0) + (b.cost ?? 0));
    }
    map.set(k, agg);
  }
  return [...map.values()].map((a) => ({
    period: a.period,
    modelBreakdowns: [...a.modelBreakdowns.entries()].map(([modelName, cost]) => ({ modelName, cost })),
  }));
}

/** Monday of the week containing an ISO date — same anchor as the 趨勢 tab. */
const weekOf = (iso) => {
  const dt = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
  return dt.toISOString().slice(0, 10);
};

/**
 * Cost trend stacked by model, re-bucketed to day / week / month / year. `day` and
 * `month` come straight from ccusage (overview.daily / overview.monthly); `week`
 * (Monday-anchored) re-buckets daily and `year` re-buckets monthly on the client.
 * All respect the global date filter.
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
    rows = bucketBy(d.monthly ?? [], (p) => p.slice(0, 4));
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
        borderWidth: { top: 2, right: 0, bottom: 0, left: 0 }, // 2px surface gap between stacked segments
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
            footer: (items) => `合計 ${usd(items.reduce((s, i) => s + i.parsed.y, 0))}`,
          },
        },
      },
    }),
  });
}

/**
 * Token composition. Cache reads are ~94% of tokens but ~1/10 the price, so they
 * render in the de-emphasis gray while cache WRITE — the actionable signal — takes
 * the orange slot.
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

/* ========================== TAB: CACHE WRITE ========================== */
/**
 * Cache-write cost, split 5m vs 1h. The whole tab is ranked by write cost — the
 * one signal that's both expensive and improvable (1h write ≈ 2× input price).
 */
function drawCacheWrite() {
  const d = state.cachewrite;
  if (!d) return;
  const t = d.totals;
  const c5 = css('--series-1');       // 5m — blue
  const c1 = css('--series-write');   // 1h — orange (the expensive, actionable tier)
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

  // Write vs read: writes are an upfront cost, cheap reads are the payoff.
  const reuse = t.reuseRatio;
  const verdict = reuse >= 10 ? '重用充分，寫入投資划算' : reuse >= 3 ? '重用尚可' : '重用偏低，寫入可能有浪費';
  $('#cw-efficiency').innerHTML = `
    <div>快取寫入成本<strong>${usd(t.writeCost)}</strong></div>
    <div>快取讀取成本<strong>${usd(t.readCost)}</strong></div>
    <div>讀取／寫入 token 重用倍數<strong>${reuse.toFixed(1)}×</strong></div>
    <div class="${reuse < 3 ? 'accent' : ''}">解讀<strong style="font-size:13px">每寫入 1 個 token 被讀取重用約 ${reuse.toFixed(1)} 次 · ${verdict}</strong></div>`;

  // Projects — horizontal stacked bar, 5m vs 1h.
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

  // Daily trend — vertical stacked bar.
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

  // Top prompts by write cost — vertical bar (top 15), 5m/1h stacked.
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

/* ============================ TAB: IMPROVE ============================ */
/**
 * Turns the cache-write diagnosis into action. Facts only — no dollar-savings
 * estimates (deliberate). Cards are assembled from the backend's raw numbers.
 */
function drawImprove() {
  const d = state.improvements;
  if (!d) return;
  const t = d.totals;
  const models = d.byModel;

  // Model-choice lever: cheapest priced model used, and the top model's rate multiple.
  const rated = models.filter((m) => m.rate1h > 0);
  const minRate = rated.length ? Math.min(...rated.map((m) => m.rate1h)) : 0;
  const topM = models[0];
  const topShare = t.writeCost ? (topM.writeCost / t.writeCost) * 100 : 0;
  const rateMult = minRate && topM?.rate1h ? topM.rate1h / minRate : 0;
  const cheapest = rated.length ? rated.reduce((a, b) => (b.rate1h < a.rate1h ? b : a)).model : '';

  const cards = [];

  // A — model choice (the dominant lever)
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

  // B — low-reuse sessions
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

  // D — reuse health (reassurance, so the user doesn't over-optimise writes)
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

  // Model write-cost bar.
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

  // Model pricing table — per-million-token rates, so the model-choice lever is legible.
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

/* ============================= TAB: TREND ============================= */
/**
 * "Am I improving?" — current window vs the previous equal-length window, plus a
 * weekly trend. Direction matters: cost / Opus% / 1h% / cost-per-prompt going DOWN
 * is good (green); reuse going UP is good.
 */
function drawTrend() {
  const d = state.trend;
  if (!d) return;
  const cur = d.current;
  const prev = d.previous;
  const comparable = d.hasComparison && prev && prev.promptCount > 0;

  // metric: value now, formatter, and whether "lower is better".
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

  // Weekly trend: cost stacked by model (entity-stable colours, same as every other
  // chart) + a single Opus-share line. The 1h-write share was dropped from the
  // chart — it sits at 80-100% every week (a property of Claude Code's caching,
  // not of user behaviour) and only tangled with the Opus line; its number still
  // lives in the KPI cards above.
  const wk = d.weekly;
  const wkModels = [...new Map(
    wk.flatMap((w) => w.byModel ?? []).map((m) => [m.model, 0]),
  ).keys()];
  // Assign colour slots by overall spend so big models keep their overview colours.
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

  // Ranked magnitude -> one hue. Turns that hide workflow cost get the warn hue.
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

  $('#table-sessions').innerHTML = `
    <thead><tr>
      <th class="num">#</th><th>專案</th><th>Session</th><th>最後活動</th><th class="num">語句</th>
      <th class="num">ccusage 數字</th><th class="num">實際成本</th><th class="num">差額</th>
    </tr></thead>
    <tbody>${d.sessions.map((s, i) => `
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

  // First-run on a machine with no transcripts: explain instead of a wall of zeros.
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

/* ============================== update check ============================== */
/** Poll /api/health until the restarted server answers again. */
async function waitForServer(ms = 120_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      if ((await fetch('/api/health')).ok) return;
    } catch {
      // still restarting
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

/** Fire-and-forget on boot: an update-check failure must never break the dashboard. */
async function checkUpdate() {
  try {
    const u = await api('/api/update-check');
    if (!u.supported || !u.behind) return;
    const dismissKey = u.mode === 'zip' ? u.latest.version : u.latest.hash;
    if (localStorage.getItem('update-dismissed') === dismissKey) return;
    showUpdateToast(u);
  } catch {
    // silent: the dashboard works fine without update info
  }
}

/* ============================== boot ============================== */
async function loadAll() {
  const [overview, cachewrite, improvements, trend, prompts, sessions, projects, health] = await Promise.all([
    api(withRange('/api/overview')).catch((e) => ({ error: e.message, models: [], daily: [], monthly: [], totalCost: 0, claudeCost: 0, otherCost: 0 })),
    api(withRange('/api/cache-writes', { limit: 30 })),
    api(withRange('/api/improvements')),
    api(withRange('/api/trend')),
    api(withRange('/api/prompts', { limit: $('#filter-limit').value, project: $('#filter-project').value })),
    api(withRange('/api/sessions')),
    api(withRange('/api/projects')),
    api('/api/health'),
  ]);
  Object.assign(state, { overview, cachewrite, improvements, trend, prompts, sessions, projects, health });

  const sel = $('#filter-project');
  if (sel.options.length <= 1) {
    for (const p of projects.projects) {
      const o = document.createElement('option');
      o.value = p.project;
      o.textContent = `${p.project} (${usd(p.trueCost)})`;
      sel.appendChild(o);
    }
  }

  // Only the visible tab draws — see showTab() for why hidden charts must not be built.
  showTab(document.querySelector('.tab.active')?.dataset.tab ?? 'overview');
  drawHealth();
}

async function reloadPrompts() {
  state.prompts = await api(
    withRange('/api/prompts', { limit: $('#filter-limit').value, project: $('#filter-project').value }),
  );
  drawPrompts();
}

const DRAW = { overview: drawOverview, cachewrite: drawCacheWrite, improve: drawImprove, trend: drawTrend, prompts: drawPrompts, sessions: drawSessions };

/**
 * Show a tab and (re)build its charts.
 *
 * Charts must be constructed while their panel is visible: a canvas created
 * inside a display:none panel measures 0x0, and Chart.js cannot recover it
 * afterwards — resize() on such an instance stays 0x0. So we redraw the tab's
 * charts on show. render() destroys the previous instance first, so this is cheap
 * and idempotent.
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

// Cost-trend period toggle (day / month / year) — re-buckets without refetching.
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
  let since = $('#date-since').value;
  let until = $('#date-until').value;
  if (!since || !until) {
    const days = (state.overview?.daily ?? []).map((x) => x.period).sort();
    since = since || days[0];
    until = until || days[days.length - 1];
  }
  return { since, until };
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
    // Same cleanup as the server: no path chars, no `_` (the filename separator).
    const empId = $('#export-empid').value.replace(/["'\\/:*?<>|_]/g, '').trim();
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
  e.target.disabled = true;
  e.target.textContent = '重新整理中…';
  try {
    await api('/api/refresh', { method: 'POST' });
    await loadAll();
  } finally {
    e.target.disabled = false;
    e.target.textContent = '重新整理';
  }
});

$('#modal-close').addEventListener('click', () => { $('#modal').hidden = true; });
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('#modal').hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#modal').hidden = true; });

// Theme toggle must beat the OS setting in both directions.
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

// Font zoom: enlarge/shrink the whole UI, persisted across sessions.
// Reflects state into the instrument control — slider, filled track, the
// live-growing A, and the mono % readout that lights up as reset when off 100%.
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
  // Re-render charts so their canvas bitmaps stay crisp at the new zoom.
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
loadAll().catch((err) => {
  $('#banner').className = 'banner error';
  $('#banner').textContent = `載入失敗：${err.message}`;
  $('#banner').hidden = false;
});
checkUpdate();
