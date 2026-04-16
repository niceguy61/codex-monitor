import { useEffect, useMemo, useRef, useState } from 'react'
import * as echarts from 'echarts'
import './App.css'

const DEFAULT_LAST = { value: 5, unit: 'm' }

function formatCompactNumber(value) {
  if (value === null || value === undefined) return '-'
  const number = Number(value)
  if (!Number.isFinite(number)) return '-'
  const abs = Math.abs(number)
  if (abs >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(1).replace(/\.0$/, '')}b`
  if (abs >= 1_000_000) return `${(number / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`
  if (abs >= 1_000) return `${(number / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  return new Intl.NumberFormat().format(number)
}

function formatDateTime(value) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date)
}

function formatDateTimeLocal(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day}T${hours}:${minutes}`
}

function parseLastToMs(last) {
  const amount = Number(last.slice(0, -1))
  const unit = last.slice(-1)
  const unitMs =
    unit === 'm' ? 60_000 :
    unit === 'h' ? 3_600_000 :
    unit === 'd' ? 86_400_000 :
    3_600_000
  return amount * unitMs
}

function buildRangeParams(mode, last, from, to) {
  if (mode === 'range' && from && to) {
    return new URLSearchParams({
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
    })
  }
  return new URLSearchParams({ last })
}

function EChart({ option, className = 'chart-host' }) {
  const ref = useRef(null)
  const chartRef = useRef(null)

  useEffect(() => {
    if (!ref.current) return undefined
    let frame = requestAnimationFrame(() => {
      if (!ref.current) return
      if (ref.current.clientWidth === 0 || ref.current.clientHeight === 0) return
      chartRef.current = echarts.init(ref.current)
      if (option) {
        chartRef.current.setOption(option, true)
      }
    })
    const observer = new ResizeObserver(() => {
      chartRef.current?.resize()
    })
    observer.observe(ref.current)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      chartRef.current?.dispose()
      chartRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!chartRef.current || !option) return
    chartRef.current.setOption(option, true)
  }, [option])

  return <div ref={ref} className={className} />
}

function lineSeriesOption(items) {
  return {
    animation: false,
    color: ['#171717', '#b45309', '#1f7a43'],
    tooltip: { trigger: 'axis' },
    legend: { bottom: 0 },
    grid: { left: 44, right: 18, top: 20, bottom: 30 },
    xAxis: {
      type: 'time',
      axisLabel: { color: '#666666' },
      axisLine: { lineStyle: { color: 'rgba(0,0,0,0.08)' } },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: '#666666' },
      splitLine: { lineStyle: { color: 'rgba(0,0,0,0.08)' } },
    },
    dataZoom: [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 24 }],
    series: [
      {
        name: 'Input',
        type: 'line',
        smooth: true,
        showSymbol: false,
        areaStyle: { color: 'rgba(23,23,23,0.05)' },
        data: items.map((item) => [item.timestamp, item.inputTokens]),
      },
      {
        name: 'Output',
        type: 'line',
        smooth: true,
        showSymbol: false,
        areaStyle: { color: 'rgba(180,83,9,0.08)' },
        data: items.map((item) => [item.timestamp, item.outputTokens]),
      },
      {
        name: 'Reasoning',
        type: 'line',
        smooth: true,
        showSymbol: false,
        areaStyle: { color: 'rgba(31,122,67,0.08)' },
        data: items.map((item) => [item.timestamp, item.reasoningTokens]),
      },
    ],
  }
}

function barTimeSeriesOption(items, label, color) {
  return {
    animation: false,
    color: [color],
    tooltip: { trigger: 'axis' },
    legend: { bottom: 0 },
    grid: { left: 44, right: 18, top: 20, bottom: 30 },
    xAxis: {
      type: 'time',
      axisLabel: { color: '#666666' },
      axisLine: { lineStyle: { color: 'rgba(0,0,0,0.08)' } },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: '#666666' },
      splitLine: { lineStyle: { color: 'rgba(0,0,0,0.08)' } },
    },
    dataZoom: [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 24 }],
    series: [
      {
        name: label,
        type: 'bar',
        data: items.map((item) => [item.timestamp, item.count]),
      },
    ],
  }
}

function horizontalBarOption(items) {
  return {
    animation: false,
    grid: { left: 90, right: 16, top: 10, bottom: 10 },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    xAxis: {
      type: 'value',
      axisLabel: { color: '#666666' },
      splitLine: { lineStyle: { color: 'rgba(0,0,0,0.08)' } },
    },
    yAxis: {
      type: 'category',
      data: items.map((item) => item.label),
      axisLabel: { color: '#666666' },
      axisTick: { show: false },
      axisLine: { show: false },
    },
    series: [
      {
        type: 'bar',
        data: items.map((item) => item.value),
        itemStyle: {
          color: (params) => ['#171717', '#4f46e5', '#1f7a43', '#b45309', '#9ca3af'][params.dataIndex % 5],
          borderRadius: [0, 8, 8, 0],
        },
        label: {
          show: true,
          position: 'right',
          color: '#666666',
          formatter: (params) => `${items[params.dataIndex]?.percent || 0}%`,
        },
      },
    ],
  }
}

function optimizerBarOption(optimizer) {
  const average = optimizer?.averageUse || 0
  const pressure = optimizer?.pressurePercent || 0
  const unused = optimizer?.unusedPercent || 0
  return {
    animation: false,
    grid: { left: 80, right: 20, top: 20, bottom: 20 },
    xAxis: {
      type: 'value',
      max: 100,
      axisLabel: { color: '#666666', formatter: '{value}%' },
      splitLine: { lineStyle: { color: 'rgba(0,0,0,0.08)' } },
    },
    yAxis: {
      type: 'category',
      data: ['Average use', 'Pressure', 'Unused'],
      axisLabel: { color: '#666666' },
      axisTick: { show: false },
      axisLine: { show: false },
    },
    series: [
      {
        type: 'bar',
        data: [
          { value: average, itemStyle: { color: '#4f46e5' } },
          { value: pressure, itemStyle: { color: '#b45309' } },
          { value: unused, itemStyle: { color: '#6b7280' } },
        ],
        label: {
          show: true,
          position: 'right',
          color: '#666666',
          formatter: '{c}%',
        },
        itemStyle: { borderRadius: [0, 8, 8, 0] },
      },
    ],
  }
}

function App() {
  const [snapshot, setSnapshot] = useState(null)
  const [activeTab, setActiveTab] = useState('overview')
  const [mode, setMode] = useState('last')
  const [lastValue, setLastValue] = useState(DEFAULT_LAST.value)
  const [lastUnit, setLastUnit] = useState(DEFAULT_LAST.unit)
  const [rangeFrom, setRangeFrom] = useState(formatDateTimeLocal(new Date(Date.now() - parseLastToMs('5m'))))
  const [rangeTo, setRangeTo] = useState(formatDateTimeLocal(new Date()))
  const [series, setSeries] = useState({ tokens: [], events: [], files: [] })

  const last = `${lastValue}${lastUnit}`

  useEffect(() => {
    let cancelled = false
    fetch('/api/snapshot')
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setSnapshot(data)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const loadHistory = async () => {
    const params = buildRangeParams(mode, last, rangeFrom, rangeTo)
    const [tokensRes, eventsRes, filesRes] = await Promise.all([
      fetch(`/api/history/timeseries?metric=tokens&${params.toString()}`),
      fetch(`/api/history/timeseries?metric=events&${params.toString()}`),
      fetch(`/api/history/timeseries?metric=files&${params.toString()}`),
    ])
    const [tokens, events, files] = await Promise.all([tokensRes.json(), eventsRes.json(), filesRes.json()])
    setSeries({
      tokens: tokens.items || [],
      events: events.items || [],
      files: files.items || [],
    })
  }

  useEffect(() => {
    loadHistory().catch(() => {})
  }, [])

  const planType = snapshot?.usage?.planType || '-'
  const stateLabel = snapshot?.status?.state || 'idle'

  return (
    <main className="app-shell">
      <header className="hero">
        <div className="brand-row">
          <img src="/public/codex-color.svg" alt="" className="brand-mark" />
          <p className="eyebrow">Codex Monitor</p>
        </div>
        <h1>Usage and flow, not just status.</h1>
      </header>

      <section className="dashboard">
        <section className="card card-now">
          <div className="card-head">
            <h2>Now</h2>
            <span className="timestamp">{formatDateTime(snapshot?.generatedAt)}</span>
          </div>
          <div className="status-row">
            <div className="badge-row">
              <span className="badge">{stateLabel}</span>
              <span className="badge badge-plan">{planType}</span>
            </div>
            <div className="current-tool">{snapshot?.status?.currentTool || '-'}</div>
          </div>
          <div className="meta-line">
            <span className="meta-item"><span className="label">Repo</span><span className="value">{snapshot?.repoPath || '-'}</span></span>
            <span className="meta-item"><span className="label">Last</span><span className="value">{formatDateTime(snapshot?.status?.lastEventAt)}</span></span>
          </div>
        </section>

        <section className="card card-summary">
          <div className="summary-strip">
            <div className="summary-item">
              <div>
                <p className="label">5h Window</p>
                <p className="value">{snapshot?.usage?.primary ? `${snapshot.usage.primary.used_percent}%` : '-'}</p>
              </div>
            </div>
            <div className="summary-item">
              <div>
                <p className="label">5h Reset</p>
                <p className="value">{snapshot?.usage?.primary ? `${formatCompactNumber(snapshot.usage.primary.resets_at ? Math.max(0, Math.floor((snapshot.usage.primary.resets_at * 1000 - Date.now()) / 60000)) : 0)}m left` : '-'}</p>
              </div>
            </div>
            <div className="summary-item">
              <div>
                <p className="label">7d Window</p>
                <p className="value">{snapshot?.usage?.secondary ? `${snapshot.usage.secondary.used_percent}%` : '-'}</p>
              </div>
            </div>
            <div className="summary-item">
              <div>
                <p className="label">7d Reset</p>
                <p className="value">{snapshot?.usage?.secondary ? `${formatCompactNumber(snapshot.usage.secondary.resets_at ? Math.max(0, Math.floor((snapshot.usage.secondary.resets_at * 1000 - Date.now()) / 60000)) : 0)}m left` : '-'}</p>
              </div>
            </div>
          </div>
        </section>

        <section className="tabs">
          <div className="tab-list">
            <button className={activeTab === 'overview' ? 'tab active' : 'tab'} onClick={() => setActiveTab('overview')}>Overview</button>
            <button className={activeTab === 'tokens' ? 'tab active' : 'tab'} onClick={() => setActiveTab('tokens')}>Tokens</button>
            <button className={activeTab === 'flow' ? 'tab active' : 'tab'} onClick={() => setActiveTab('flow')}>Flow</button>
            <button className={activeTab === 'optimizer' ? 'tab active' : 'tab'} onClick={() => setActiveTab('optimizer')}>Optimizer</button>
          </div>

          <section className="card controls-card">
            <div className="controls-top">
              <div className="mode-group">
                <button className={mode === 'last' ? 'mode active' : 'mode'} onClick={() => setMode('last')}>Last</button>
                <button className={mode === 'range' ? 'mode active' : 'mode'} onClick={() => setMode('range')}>Range</button>
              </div>
              {mode === 'last' ? (
                <div className="inline-controls">
                  <input type="number" min="1" value={lastValue} onChange={(e) => setLastValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && loadHistory()} />
                  <select value={lastUnit} onChange={(e) => setLastUnit(e.target.value)}>
                    <option value="m">min</option>
                    <option value="h">hour</option>
                    <option value="d">day</option>
                  </select>
                  <button onClick={() => loadHistory()}>Apply</button>
                </div>
              ) : (
                <div className="inline-controls">
                  <input type="datetime-local" value={rangeFrom} onChange={(e) => setRangeFrom(e.target.value)} />
                  <input type="datetime-local" value={rangeTo} onChange={(e) => setRangeTo(e.target.value)} />
                  <button onClick={() => loadHistory()}>Apply</button>
                </div>
              )}
            </div>
          </section>

          <section className="tab-panel">
            {activeTab === 'overview' && (
              <>
                <section className="card">
                  <div className="card-head"><h2>Session Insight</h2></div>
                  <div className="summary-grid">
                    <div><p className="label">Limit Risk</p><p className="value">{snapshot?.insights?.limitRisk || '-'}</p></div>
                    <div><p className="label">Largest Turn</p><p className="value">{formatCompactNumber(snapshot?.insights?.largestTurn)}</p></div>
                    <div><p className="label">Driver</p><p className="value">{snapshot?.insights?.dominantDriver || '-'}</p></div>
                    <div><p className="label">File Changes</p><p className="value">{formatCompactNumber(snapshot?.insights?.fileChanges)}</p></div>
                    <div><p className="label">Heavy Turns</p><p className="value">{formatCompactNumber(snapshot?.insights?.heavyTurnCount)}</p></div>
                  </div>
                </section>
              </>
            )}

            {activeTab === 'tokens' && (
              <>
                <section className="card">
                  <div className="card-head"><h2>Tokens</h2></div>
                  <div className="summary-grid">
                    <div><p className="label">Last Turn</p><p className="value">{formatCompactNumber(snapshot?.tokens?.lastTurn?.total_tokens)}</p></div>
                    <div><p className="label">Session Total</p><p className="value">{formatCompactNumber(snapshot?.tokens?.sessionTotal?.total_tokens)}</p></div>
                    <div><p className="label">Context</p><p className="value">{snapshot?.tokens ? `${snapshot.tokens.contextUsagePercent}%` : '-'}</p></div>
                  </div>
                  <div className="chart-box"><EChart option={lineSeriesOption(series.tokens)} /></div>
                </section>
                <section className="card">
                  <div className="card-head"><h2>Drivers</h2></div>
                  <div className="chart-box small"><EChart option={horizontalBarOption(snapshot?.attribution?.topDriversChart || [])} /></div>
                  <div className="summary-grid">
                    {(snapshot?.attribution?.topDriversChart || []).slice(0, 3).map((item) => (
                      <div key={item.label}><p className="label">{item.label}</p><p className="value">{item.percent}%</p></div>
                    ))}
                  </div>
                </section>
              </>
            )}

            {activeTab === 'flow' && (
              <>
                <section className="card">
                  <div className="card-head"><h2>Recent Events</h2></div>
                  <div className="chart-box"><EChart option={barTimeSeriesOption(series.events, 'Events', '#4f46e5')} /></div>
                </section>
                <section className="card">
                  <div className="card-head"><h2>File Activity</h2></div>
                  <div className="chart-box"><EChart option={barTimeSeriesOption(series.files, 'Files', '#1f7a43')} /></div>
                </section>
              </>
            )}

            {activeTab === 'optimizer' && (
              <>
                <section className="card">
                  <div className="card-head"><h2>Usage Optimizer</h2></div>
                  <div className="summary-grid">
                    <div><p className="label">Status</p><p className="value">{snapshot?.optimizer?.status || '-'}</p></div>
                    <div><p className="label">Avg Window Use</p><p className="value">{snapshot?.optimizer ? `${snapshot.optimizer.averageUse}%` : '-'}</p></div>
                    <div><p className="label">Plan Fit</p><p className="value">{snapshot?.optimizer?.planFit || '-'}</p></div>
                    <div><p className="label">Window Pressure</p><p className="value">{snapshot?.optimizer ? `${snapshot.optimizer.pressurePercent}%` : '-'}</p></div>
                    <div><p className="label">Unused Capacity</p><p className="value">{snapshot?.optimizer ? `${snapshot.optimizer.unusedPercent}%` : '-'}</p></div>
                    <div><p className="label">Dominant Driver</p><p className="value">{snapshot?.optimizer?.dominantDriver || '-'}</p></div>
                  </div>
                </section>
                <section className="card">
                  <div className="card-head"><h2>Usage Shape</h2></div>
                  <div className="chart-box small"><EChart option={optimizerBarOption(snapshot?.optimizer)} /></div>
                </section>
                <section className="card">
                  <div className="card-head"><h2>Recommendations</h2></div>
                  <ul className="recommendations">
                    {(snapshot?.optimizer?.recommendations || []).map((item) => <li key={item}>{item}</li>)}
                  </ul>
                </section>
              </>
            )}
          </section>
        </section>
      </section>
    </main>
  )
}

export default App
