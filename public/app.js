const els = {
  generatedAt: document.querySelector('#generatedAt'),
  repoPath: document.querySelector('#repoPath'),
  stateBadge: document.querySelector('#stateBadge'),
  currentTool: document.querySelector('#currentTool'),
  lastEventAt: document.querySelector('#lastEventAt'),
  tabButtons: [...document.querySelectorAll('[data-tab]')],
  tabPanels: [...document.querySelectorAll('[data-panel]')],
  eventChart: document.querySelector('#eventChart'),
  fileChart: document.querySelector('#fileChart'),
  tokenChart: document.querySelector('#tokenChart'),
  attributionChart: document.querySelector('#attributionChart'),
  lastTurnTokens: document.querySelector('#lastTurnTokens'),
  sessionTokens: document.querySelector('#sessionTokens'),
  contextUsage: document.querySelector('#contextUsage'),
  insightRisk: document.querySelector('#insightRisk'),
  insightLargestTurn: document.querySelector('#insightLargestTurn'),
  insightDriver: document.querySelector('#insightDriver'),
  insightFileChanges: document.querySelector('#insightFileChanges'),
  insightHeavyTurns: document.querySelector('#insightHeavyTurns'),
  attributionDrivers: document.querySelector('#attributionDrivers'),
  heavyThreshold: document.querySelector('#heavyThreshold'),
  heavyTurns: document.querySelector('#heavyTurns'),
  planBadge: document.querySelector('#planBadge'),
  primaryUsage: document.querySelector('#primaryUsage'),
  secondaryUsage: document.querySelector('#secondaryUsage'),
  primaryReset: document.querySelector('#primaryReset'),
  secondaryReset: document.querySelector('#secondaryReset'),
};

const stateMeta = {
  idle: { emoji: '😴', label: 'Idle' },
  working: { emoji: '🧠', label: 'Working' },
  tool_running: { emoji: '🛠️', label: 'Tool' },
  wait: { emoji: '⏳', label: 'Wait' },
};

const chartTheme = {
  event: ['#4f46e5', '#7c3aed', '#2563eb', '#6b7280', '#9ca3af', '#d1d5db'],
  file: ['#1f7a43', '#2f855a', '#65a30d', '#b45309', '#6b7280', '#d1d5db'],
  token: ['#171717', '#b45309', '#1f7a43'],
};

const CHART_BORDER = 'rgba(255, 255, 255, 0.92)';

const charts = {};
let activeTab = 'overview';

function formatTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

function formatNumber(value) {
  if (value === null || value === undefined) return '-';
  const number = Number(value);
  if (!Number.isFinite(number)) return '-';

  const abs = Math.abs(number);
  if (abs >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(1).replace(/\.0$/, '')}b`;
  if (abs >= 1_000_000) return `${(number / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`;
  if (abs >= 1_000) return `${(number / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return new Intl.NumberFormat().format(number);
}

function formatReset(value) {
  if (!value) return '-';
  const date = new Date(Number(value) * 1000);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatRemaining(value) {
  if (!value) return '-';
  const remainingMs = Number(value) * 1000 - Date.now();
  if (remainingMs <= 0) return 'resetting now';

  const totalMinutes = Math.floor(remainingMs / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d ${hours}h left`;
  if (hours > 0) return `${hours}h ${minutes}m left`;
  return `${minutes}m left`;
}

function renderChips(container, items, formatItem) {
  if (!container) return;
  if (!items.length) {
    container.innerHTML = '<span class="chip chip-muted">-</span>';
    return;
  }
  container.innerHTML = items.map(formatItem).join('');
}

function renderHeavyTurns(container, items) {
  if (!container) return;
  if (!items.length) {
    container.innerHTML = '<div class="insight-row"><span class="chip chip-muted">No heavy turns</span></div>';
    return;
  }

  container.innerHTML = items
    .map(
      (item) => `
        <div class="insight-row">
          <span class="chip">${formatNumber(item.totalTokens)}</span>
          <span class="insight-meta mono">${(item.tags || ['unknown']).join(', ')}</span>
        </div>
      `,
    )
    .join('');
}

function makeChart(canvas, config) {
  if (!canvas || !window.Chart) return null;
  return new window.Chart(canvas, config);
}

function resizeCharts() {
  requestAnimationFrame(() => {
    for (const chart of Object.values(charts)) {
      if (!chart) continue;
      chart.resize();
      chart.update('none');
    }
  });
}

function setActiveTab(tabName) {
  activeTab = tabName;
  for (const button of els.tabButtons) {
    const isActive = button.dataset.tab === tabName;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-selected', String(isActive));
  }
  for (const panel of els.tabPanels) {
    const isActive = panel.dataset.panel === tabName;
    panel.classList.toggle('is-active', isActive);
    panel.hidden = !isActive;
  }
  resizeCharts();
}

function chartCenterPlugin(textResolver) {
  return {
    id: `centerText-${Math.random().toString(16).slice(2, 8)}`,
    afterDraw(chart) {
      if (chart.config.type !== 'doughnut') return;
      const text = textResolver();
      if (!text) return;
      const { ctx } = chart;
      const meta = chart.getDatasetMeta(0);
      if (!meta?.data?.length) return;
      const { x, y } = meta.data[0];
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#171717';
      ctx.font = '700 24px "Geist Mono", "IBM Plex Mono"';
      ctx.fillText(text.value, x, y - 8);
      ctx.fillStyle = '#666666';
      ctx.font = '12px "Geist Mono", "IBM Plex Mono"';
      ctx.fillText(text.label, x, y + 14);
      ctx.restore();
    },
  };
}

function upsertChart(key, canvas, type, points, palette, centerText) {
  const labels = points.map((point) => point.label);
  const values = points.map((point) => point.value);

  if (!charts[key]) {
    charts[key] = makeChart(canvas, {
      type,
      data: {
        labels,
        datasets: [
          {
            data: values,
            backgroundColor: palette,
            borderColor: CHART_BORDER,
            borderWidth: type === 'doughnut' ? 2 : 1.5,
            tension: 0.3,
            fill: false,
            pointRadius: type === 'line' ? 3 : undefined,
            pointBackgroundColor: CHART_BORDER,
            pointBorderColor: CHART_BORDER,
            borderRadius: 10,
            borderSkipped: false,
          },
        ],
      },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: type === 'doughnut', position: 'bottom' },
        },
        scales:
          type === 'bar' || type === 'line'
            ? {
                x: {
                  ticks: { color: '#666666' },
                  grid: { display: false },
                },
                y: {
                  ticks: { color: '#666666', precision: 0 },
                  grid: { color: 'rgba(0, 0, 0, 0.08)' },
                },
              }
            : {},
      },
      plugins: centerText ? [chartCenterPlugin(centerText)] : [],
    });
    return;
  }

  charts[key].data.labels = labels;
  charts[key].data.datasets[0].data = values;
  charts[key].update();
}

function upsertTokenBreakdown(points) {
  const labels = points.map((point) => point.label);
  const datasets = [
    { label: 'Input', data: points.map((point) => point.input), borderColor: CHART_BORDER, backgroundColor: '#171717' },
    { label: 'Output', data: points.map((point) => point.output), borderColor: CHART_BORDER, backgroundColor: '#b45309' },
    { label: 'Reasoning', data: points.map((point) => point.reasoning), borderColor: CHART_BORDER, backgroundColor: '#1f7a43' },
  ];

  if (!charts.tokenBreakdown) {
    charts.tokenBreakdown = makeChart(els.tokenChart, {
      type: 'bar',
      data: { labels, datasets },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: true, position: 'bottom' },
        },
        scales: {
          x: {
            stacked: true,
            ticks: { color: '#666666' },
            grid: { display: false },
          },
          y: {
            stacked: true,
            ticks: { color: '#666666', precision: 0 },
            grid: { color: 'rgba(0, 0, 0, 0.08)' },
          },
        },
      },
    });
    return;
  }

  charts.tokenBreakdown.data.labels = labels;
  charts.tokenBreakdown.data.datasets.forEach((dataset, index) => {
    dataset.data = datasets[index].data;
  });
  charts.tokenBreakdown.update();
}

function usageTone(percent) {
  if (percent <= 50) return 'ok';
  if (percent <= 80) return 'warn';
  return 'danger';
}

function render(snapshot) {
  const state = stateMeta[snapshot.status.state] || stateMeta.idle;
  els.generatedAt.textContent = formatTime(snapshot.generatedAt);
  els.repoPath.textContent = snapshot.repoPath;
  els.stateBadge.textContent = `${state.emoji} ${state.label}`;
  els.stateBadge.dataset.state = snapshot.status.state;
  els.currentTool.textContent = snapshot.status.currentTool || '-';
  els.lastEventAt.textContent = formatTime(snapshot.status.lastEventAt);
  upsertChart(
    'event',
    els.eventChart,
    'doughnut',
    snapshot.charts.eventTypes,
    chartTheme.event,
    () => ({ value: formatNumber(snapshot.totals.events), label: 'events' }),
  );
  upsertChart(
    'file',
    els.fileChart,
    'doughnut',
    snapshot.charts.fileTypes,
    chartTheme.file,
    () => ({ value: formatNumber(snapshot.totals.files), label: 'files' }),
  );
  upsertChart(
    'attribution',
    els.attributionChart,
    'bar',
    snapshot.attribution?.topDriversChart || [],
    ['#171717', '#4f46e5', '#1f7a43', '#b45309', '#9ca3af'],
  );
  upsertTokenBreakdown(snapshot.charts.tokenTrend);
  els.lastTurnTokens.textContent = formatNumber(snapshot.tokens?.lastTurn?.total_tokens);
  els.sessionTokens.textContent = formatNumber(snapshot.tokens?.sessionTotal?.total_tokens);
  els.contextUsage.textContent = snapshot.tokens
    ? `${snapshot.tokens.contextUsagePercent}% of ${formatNumber(snapshot.tokens.contextWindow)}`
    : '-';
  els.planBadge.textContent = (snapshot.usage?.planType || '-').slice(0, 3).toUpperCase();
  els.primaryUsage.textContent = snapshot.usage?.primary
    ? `${snapshot.usage.primary.used_percent}% used`
    : '-';
  els.secondaryUsage.textContent = snapshot.usage?.secondary
    ? `${snapshot.usage.secondary.used_percent}% used`
    : '-';
  els.primaryUsage.dataset.tone = usageTone(snapshot.usage?.primary?.used_percent || 0);
  els.secondaryUsage.dataset.tone = usageTone(snapshot.usage?.secondary?.used_percent || 0);
  els.primaryReset.textContent = snapshot.usage?.primary
    ? `${formatRemaining(snapshot.usage.primary.resets_at)} · ${formatReset(snapshot.usage.primary.resets_at)}`
    : '-';
  els.secondaryReset.textContent = snapshot.usage?.secondary
    ? `${formatRemaining(snapshot.usage.secondary.resets_at)} · ${formatReset(snapshot.usage.secondary.resets_at)}`
    : '-';
  els.insightRisk.textContent = snapshot.insights?.limitRisk || '-';
  els.insightLargestTurn.textContent = formatNumber(snapshot.insights?.largestTurn);
  els.insightDriver.textContent = snapshot.insights?.dominantDriver || '-';
  els.insightFileChanges.textContent = formatNumber(snapshot.insights?.fileChanges);
  els.insightHeavyTurns.textContent = formatNumber(snapshot.insights?.heavyTurnCount);
  renderChips(
    els.attributionDrivers,
    snapshot.attribution?.topDriversChart || [],
    (item) => `<span class="chip">${item.label} ${item.percent}%</span>`,
  );
  els.heavyThreshold.textContent = snapshot.attribution?.heavyThreshold
    ? `adaptive threshold: ${formatNumber(snapshot.attribution.heavyThreshold)}`
    : '-';
  renderHeavyTurns(els.heavyTurns, snapshot.attribution?.heavyTurns || []);
}

async function loadSnapshot() {
  const res = await fetch('/api/snapshot');
  const snapshot = await res.json();
  render(snapshot);
}

function connectStream() {
  const stream = new EventSource('/api/stream');
  stream.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'snapshot') {
      render(message.payload);
      return;
    }
    loadSnapshot().catch(() => {});
  };
  stream.onerror = () => {
    stream.close();
    setTimeout(connectStream, 1500);
  };
}

loadSnapshot().catch(() => {});
for (const button of els.tabButtons) {
  button.addEventListener('click', () => {
    setActiveTab(button.dataset.tab);
  });
}
setActiveTab(activeTab);
connectStream();
