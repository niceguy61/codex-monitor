import { mkdir, appendFile, readFile } from 'fs/promises';
import path from 'path';

const MAX_EVENTS = 400;
const MAX_FILE_EVENTS = 120;
const IDLE_THRESHOLD_MS = 30_000;
const TOP_BUCKET_COUNT = 6;
const TOKEN_TREND_COUNT = 10;
const HEAVY_TURN_MIN_THRESHOLD = 100_000;
const SERVICE_MAP_LIMIT = 5;
const SERVICE_FLOW_LIMIT = 8;

function toIso(value) {
  if (!value) return new Date().toISOString();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function eventSummary(event) {
  if (event.summary) return String(event.summary);
  if (event.toolName) return event.toolName;
  if (event.filePath) return event.filePath;
  if (event.message) return event.message;
  return event.eventType;
}

function pickFileEventType(eventType, parsedCmdType) {
  if (eventType === 'file_read' || parsedCmdType === 'read') return 'file_read';
  if (eventType === 'file_write' || parsedCmdType === 'write') return 'file_write';
  if (eventType === 'file_edit' || parsedCmdType === 'edit') return 'file_edit';
  if (eventType === 'file_delete' || parsedCmdType === 'delete') return 'file_delete';
  return null;
}

function topCounts(items, pickKey) {
  const counts = new Map();
  for (const item of items) {
    const key = pickKey(item);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_BUCKET_COUNT)
    .map(([label, value]) => ({ label, value }));
}

function getTokenInfo(event) {
  const info = event?.payload?.info;
  if (!info?.total_token_usage && !info?.last_token_usage) return null;
  return info;
}

function getRateLimits(event) {
  return event?.payload?.rate_limits || null;
}

function formatTrendLabel(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '--';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * ratio)));
  return sorted[index];
}

function classifyActivity(event) {
  const toolName = String(event.toolName || '').toLowerCase();
  const eventType = String(event.eventType || '').toLowerCase();

  if (toolName === 'apply_patch' || eventType === 'file_edit' || eventType === 'file_write' || eventType === 'file_delete') {
    return 'file_change';
  }
  if (toolName.startsWith('web.') || toolName === 'web_search' || toolName === 'web.open') {
    return 'web';
  }
  if (
    toolName.includes('mcp') ||
    toolName.startsWith('read_mcp_resource') ||
    toolName.startsWith('lsp_') ||
    toolName.startsWith('ast_grep') ||
    toolName.startsWith('state_') ||
    toolName.startsWith('project_memory')
  ) {
    return 'mcp';
  }
  if (toolName.includes('agent') || toolName === 'spawn_agent' || toolName === 'send_input' || toolName === 'wait_agent') {
    return 'agent';
  }
  if (toolName === 'exec_command') {
    return 'exec_command';
  }
  if (eventType === 'approval_request' || eventType === 'approval_result') {
    return 'approval';
  }
  if (toolName) {
    return toolName;
  }
  return null;
}

function serviceLaneForEvent(event) {
  const toolName = String(event.toolName || '').toLowerCase();
  const eventType = String(event.eventType || '').toLowerCase();

  if (eventType === 'user_prompt') return 'prompts';
  if (eventType === 'skill_usage') return 'skills';
  if (['spawn_agent', 'send_input', 'wait_agent', 'close_agent', 'resume_agent'].includes(toolName)) {
    return 'agents';
  }
  if (event.fileEventType || eventType.startsWith('file_')) return 'artifacts';
  if (eventType === 'token_usage' || eventType === 'approval_request' || eventType === 'approval_result') return 'usage';
  if (eventType === 'tool_start' || eventType === 'tool_complete') return 'tools';
  return null;
}

function serviceLabelForEvent(event) {
  if (event.eventType === 'user_prompt') return 'prompt';
  if (event.eventType === 'skill_usage') return event.toolName ? `$${event.toolName}` : event.summary || 'skill';
  if (event.fileEventType) return event.fileEventType;
  if (event.eventType === 'token_usage') return 'token_usage';
  if (event.eventType === 'approval_request') return 'approval';
  return event.toolName || event.summary || event.eventType;
}

function shortSummary(value, limit = 96) {
  const summary = String(value || '').replace(/\s+/g, ' ').trim();
  if (!summary) return '';
  return summary.length > limit ? `${summary.slice(0, limit - 3)}...` : summary;
}

function serviceNodeForEvent(event) {
  const laneKey = serviceLaneForEvent(event);
  if (!laneKey) return null;
  if (laneKey === 'usage') return null;

  const laneLabels = {
    prompts: 'Prompt',
    skills: 'Skill',
    agents: 'Agent',
    tools: 'Tool',
    artifacts: 'Artifact',
  };

  return {
    id: `${laneKey}-${event.id || event.fingerprint || event.timestamp}`,
    lane: laneKey,
    laneLabel: laneLabels[laneKey] || laneKey,
    label: serviceLabelForEvent(event),
    summary: shortSummary(event.summary || event.message || event.eventType),
    timestamp: event.timestamp,
    count: 1,
  };
}

function compactFlowNodes(nodes) {
  const compacted = [];

  for (const node of nodes) {
    const previous = compacted[compacted.length - 1];
    if (previous && previous.lane === node.lane && previous.label === node.label) {
      previous.count += 1;
      previous.timestamp = node.timestamp;
      if (!previous.summary && node.summary) previous.summary = node.summary;
      continue;
    }
    compacted.push({ ...node });
  }

  if (compacted.length <= SERVICE_FLOW_LIMIT) return compacted;

  const prompt = compacted[0]?.lane === 'prompts' ? compacted[0] : null;
  const tailLimit = prompt ? SERVICE_FLOW_LIMIT - 1 : SERVICE_FLOW_LIMIT;
  return [
    ...(prompt ? [prompt] : []),
    ...compacted.slice(-tailLimit),
  ];
}

function deriveLatestServiceFlow(events) {
  const chronologicalEvents = [...events].sort((a, b) => {
    const aTime = new Date(a.timestamp).getTime();
    const bTime = new Date(b.timestamp).getTime();
    return aTime - bTime;
  });
  const lastPromptIndex = chronologicalEvents.map((event) => event.eventType).lastIndexOf('user_prompt');
  const turnEvents = lastPromptIndex >= 0 ? chronologicalEvents.slice(lastPromptIndex) : chronologicalEvents.slice(-80);
  const stageOrder = ['prompts', 'skills', 'agents', 'tools', 'artifacts'];
  const nodesByStage = new Map(stageOrder.map((stage) => [stage, new Map()]));

  for (const node of turnEvents.map(serviceNodeForEvent).filter(Boolean)) {
    const stage = nodesByStage.get(node.lane);
    if (!stage) continue;
    const key = node.lane === 'prompts' ? 'prompt' : node.label;
    const existing = stage.get(key);
    if (existing) {
      existing.count += 1;
      existing.timestamp = node.timestamp;
      if (node.summary) existing.summary = node.summary;
    } else {
      stage.set(key, { ...node });
    }
  }

  const nodes = compactFlowNodes(stageOrder.flatMap((stage) => [...nodesByStage.get(stage).values()]));

  return {
    title: lastPromptIndex >= 0 ? 'Latest Prompt Flow' : 'Recent Runtime Flow',
    prompt: nodes.find((node) => node.lane === 'prompts') || null,
    nodes,
    edges: nodes.slice(1).map((node, index) => ({
      from: nodes[index].id,
      to: node.id,
    })),
  };
}

function deriveServiceMap(events) {
  const laneDefs = [
    { key: 'prompts', label: 'Prompt' },
    { key: 'skills', label: 'Skills' },
    { key: 'agents', label: 'Agents' },
    { key: 'tools', label: 'Tools' },
    { key: 'artifacts', label: 'Artifacts' },
    { key: 'usage', label: 'Usage' },
  ];
  const lanes = new Map(laneDefs.map((lane) => [lane.key, { ...lane, items: new Map(), total: 0 }]));

  for (const event of events) {
    const laneKey = serviceLaneForEvent(event);
    if (!laneKey || !lanes.has(laneKey)) continue;
    const lane = lanes.get(laneKey);
    const label = serviceLabelForEvent(event);
    const existing = lane.items.get(label) || {
      label,
      count: 0,
      latestAt: null,
      summary: null,
    };

    existing.count += 1;
    existing.latestAt = event.timestamp;
    existing.summary = event.summary || null;
    lane.total += 1;
    lane.items.set(label, existing);
  }

  return {
    lanes: [...lanes.values()].map((lane) => ({
      key: lane.key,
      label: lane.label,
      total: lane.total,
      items: [...lane.items.values()]
        .sort((a, b) => new Date(b.latestAt).getTime() - new Date(a.latestAt).getTime())
        .slice(0, SERVICE_MAP_LIMIT),
    })),
    edges: [
      ['prompts', 'skills'],
      ['skills', 'agents'],
      ['skills', 'tools'],
      ['agents', 'tools'],
      ['tools', 'artifacts'],
      ['tools', 'usage'],
    ],
    latestFlow: deriveLatestServiceFlow(events),
  };
}

function deriveAttribution(events, tokenEvents) {
  if (!tokenEvents.length) {
    return {
      topDrivers: [],
      topDriversChart: [],
      heavyTurns: [],
    };
  }

  const usageByTag = new Map();
  const heavyTurns = [];
  const turnTotals = tokenEvents.map((event) => event.payload?.info?.last_token_usage?.total_tokens || 0);
  const adaptiveThreshold = Math.max(
    HEAVY_TURN_MIN_THRESHOLD,
    percentile(turnTotals.slice(-20), 0.8),
  );

  for (let index = 0; index < tokenEvents.length; index += 1) {
    const tokenEvent = tokenEvents[index];
    const previousTimestamp = index > 0 ? tokenEvents[index - 1].timestamp : null;
    const startMs = previousTimestamp ? new Date(previousTimestamp).getTime() : Number.NEGATIVE_INFINITY;
    const endMs = new Date(tokenEvent.timestamp).getTime();
    const relatedEvents = events.filter((event) => {
      const eventMs = new Date(event.timestamp).getTime();
      return event.eventType !== 'token_usage' && eventMs > startMs && eventMs <= endMs;
    });

    const tags = [...new Set(relatedEvents.map(classifyActivity).filter(Boolean))];
    const totalTokens = tokenEvent.payload?.info?.last_token_usage?.total_tokens || 0;

    for (const tag of tags) {
      usageByTag.set(tag, (usageByTag.get(tag) || 0) + totalTokens);
    }

    if (totalTokens >= adaptiveThreshold) {
      heavyTurns.push({
        timestamp: tokenEvent.timestamp,
        totalTokens,
        tags,
      });
    }
  }

  const topDrivers = [...usageByTag.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([label, value]) => ({ label, value }));
  const totalAttributed = topDrivers.reduce((sum, item) => sum + item.value, 0);

  return {
    topDrivers,
    topDriversChart: topDrivers.map((item) => ({
      label: item.label,
      value: item.value,
      percent: totalAttributed > 0 ? Number(((item.value / totalAttributed) * 100).toFixed(1)) : 0,
    })),
    heavyThreshold: adaptiveThreshold,
    heavyTurns: heavyTurns.slice(-5).reverse(),
  };
}

function deriveOverviewInsights(events, fileEvents, usage, attribution, tokens) {
  const dominantDriver = attribution.topDrivers?.[0] || null;
  const largestTurn = attribution.heavyTurns?.[0]?.totalTokens || tokens?.lastTurn?.total_tokens || 0;
  const fileChanges = fileEvents.filter((event) => event.eventType !== 'file_read').length;
  const primaryUsage = usage?.primary?.used_percent || 0;
  const secondaryUsage = usage?.secondary?.used_percent || 0;
  const maxUsage = Math.max(primaryUsage, secondaryUsage);
  const risk =
    maxUsage > 80 ? 'high' :
    maxUsage > 50 ? 'medium' :
    'low';

  return {
    dominantDriver: dominantDriver ? dominantDriver.label : '-',
    largestTurn,
    fileChanges,
    heavyTurnCount: attribution.heavyTurns?.length || 0,
    limitRisk: risk,
  };
}

function deriveOptimizer(usage, attribution, tokens) {
  const primary = usage?.primary?.used_percent || 0;
  const secondary = usage?.secondary?.used_percent || 0;
  const averageUse = Number(((primary + secondary) / 2).toFixed(1));
  const pressurePercent = Math.max(primary, secondary);
  const unusedPercent = Number((100 - averageUse).toFixed(1));
  const dominantDriver = attribution.topDrivers?.[0]?.label || '-';
  const heavyTurnCount = attribution.heavyTurns?.length || 0;
  const lastTurn = tokens?.lastTurn?.total_tokens || 0;

  let status = 'balanced';
  if (averageUse < 20) status = 'underused';
  if (averageUse > 75 || heavyTurnCount >= 3) status = 'overdriving';

  let planFit = 'good';
  if (averageUse < 20) planFit = 'underusing current plan';
  if (averageUse > 75) planFit = 'near upper usage band';

  const recommendations = [];
  if (averageUse < 20) {
    recommendations.push('You are leaving a large part of the paid window unused.')
    recommendations.push('Batch deeper work into active windows instead of spreading tiny checks across the day.')
  }
  if (averageUse > 75) {
    recommendations.push('Current window pressure is high. Avoid broad re-exploration until usage cools down.')
    recommendations.push('Group expensive work into fewer, better-scoped turns.')
  }
  if (dominantDriver === 'web') {
    recommendations.push('Web-heavy turns dominate cost. Prefer focused lookups instead of repeated browsing.')
  }
  if (dominantDriver === 'exec_command') {
    recommendations.push('Command-heavy turns dominate cost. Batch shell reads before asking for another analysis pass.')
  }
  if (dominantDriver === 'agent') {
    recommendations.push('Agent-driven turns are expensive. Delegate only bounded sidecar work.')
  }
  if (heavyTurnCount > 0 && lastTurn >= 100_000) {
    recommendations.push('Recent turns are unusually large. Trim context and avoid repeated re-analysis.')
  }
  if (!recommendations.length) {
    recommendations.push('Usage looks balanced. Keep the current operating pattern.')
  }

  return {
    status,
    averageUse,
    pressurePercent,
    unusedPercent,
    planFit,
    dominantDriver,
    heavyTurnCount,
    recommendations: recommendations.slice(0, 3),
  };
}

export class MonitorStore {
  constructor(options = {}) {
    this.repoPath = options.repoPath;
    this.dataDir = options.dataDir;
    this.logPath = path.join(this.dataDir, 'events.jsonl');
    this.sqliteStore = options.sqliteStore || null;
    this.events = [];
    this.fileEvents = [];
    this.byFingerprint = new Set();
    this.clients = new Set();
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true });
    try {
      const content = await readFile(this.logPath, 'utf8');
      const lines = content.split('\n').filter(Boolean);
      for (const line of lines.slice(-MAX_EVENTS)) {
        try {
          const event = JSON.parse(line);
          this.#ingestIntoMemory(event, false);
        } catch {
          // Ignore malformed historical lines.
        }
      }
    } catch {
      // Fresh workspace.
    }
  }

  subscribe(res) {
    this.clients.add(res);
    res.write(`data: ${JSON.stringify({ type: 'snapshot', payload: this.snapshot() })}\n\n`);
    res.on('close', () => {
      this.clients.delete(res);
    });
  }

  async record(rawEvent, options = {}) {
    const event = this.#normalizeEvent(rawEvent);
    const fingerprint = event.fingerprint;
    if (fingerprint && this.byFingerprint.has(fingerprint)) {
      return null;
    }

    this.#ingestIntoMemory(event, true);

    if (!options.skipPersist) {
      await appendFile(this.logPath, JSON.stringify(event) + '\n');
      if (this.sqliteStore) {
        this.sqliteStore.persist(event);
      }
    }

    const payload = JSON.stringify({ type: 'event', payload: event });
    for (const client of this.clients) {
      client.write(`data: ${payload}\n\n`);
    }
    return event;
  }

  snapshot() {
    const recentEvents = [...this.events].reverse().slice(0, 20);
    const recentFiles = [...this.fileEvents].reverse().slice(0, 20);
    const tokenEvents = this.events.filter((event) => event.eventType === 'token_usage');
    const latestTokenEvent = tokenEvents[tokenEvents.length - 1];
    const latestTokenInfo = getTokenInfo(latestTokenEvent);
    const latestRateLimits = getRateLimits(latestTokenEvent);
    const attribution = deriveAttribution(this.events, tokenEvents);
    const tokenTrend = tokenEvents.slice(-TOKEN_TREND_COUNT).map((event) => {
      const info = getTokenInfo(event) || {};
      return {
        label: formatTrendLabel(event.timestamp),
        total: info.last_token_usage?.total_tokens || 0,
        input: info.last_token_usage?.input_tokens || 0,
        output: info.last_token_usage?.output_tokens || 0,
        reasoning: info.last_token_usage?.reasoning_output_tokens || 0,
      };
    });
    const contextWindow = latestTokenInfo?.model_context_window || 0;
    const sessionTotal = latestTokenInfo?.total_token_usage?.total_tokens || 0;
    return {
      repoPath: this.repoPath,
      status: this.#deriveStatus(),
      events: recentEvents,
      files: recentFiles,
      charts: {
        eventTypes: topCounts(this.events, (event) => event.eventType),
        fileTypes: topCounts(this.fileEvents, (event) => event.eventType),
        tokenTrend,
      },
      tokens: latestTokenInfo
        ? {
            lastTurn: latestTokenInfo.last_token_usage,
            sessionTotal: latestTokenInfo.total_token_usage,
            contextWindow,
            contextUsagePercent:
              contextWindow > 0 ? Number(((sessionTotal / contextWindow) * 100).toFixed(1)) : 0,
          }
        : null,
      usage: latestRateLimits
        ? {
            planType: latestRateLimits.plan_type || 'unknown',
            primary: latestRateLimits.primary || null,
            secondary: latestRateLimits.secondary || null,
          }
        : null,
      attribution,
      serviceMap: deriveServiceMap(this.events),
      insights: deriveOverviewInsights(
        this.events,
        this.fileEvents,
        latestRateLimits
          ? {
              primary: latestRateLimits.primary || null,
              secondary: latestRateLimits.secondary || null,
            }
          : null,
        attribution,
        latestTokenInfo
          ? {
              lastTurn: latestTokenInfo.last_token_usage,
            }
          : null,
      ),
      optimizer: deriveOptimizer(
        latestRateLimits
          ? {
              primary: latestRateLimits.primary || null,
              secondary: latestRateLimits.secondary || null,
            }
          : null,
        attribution,
        latestTokenInfo
          ? {
              lastTurn: latestTokenInfo.last_token_usage,
            }
          : null,
      ),
      totals: {
        events: this.events.length,
        files: this.fileEvents.length,
      },
      generatedAt: new Date().toISOString(),
    };
  }

  #normalizeEvent(rawEvent) {
    const payload = rawEvent.payload ?? {};
    const timestamp = toIso(rawEvent.timestamp);
    const parsedCmd = ensureArray(payload.parsed_cmd);
    const firstParsed = parsedCmd[0] ?? {};
    const eventType = rawEvent.eventType || rawEvent.type || 'unknown';
    const filePath = rawEvent.filePath || payload.file_path || firstParsed.path || null;
    const toolName = rawEvent.toolName || payload.tool_name || payload.type || payload.name || null;
    const fingerprint =
      rawEvent.fingerprint ||
      [
        eventType,
        timestamp,
        toolName || '',
        filePath || '',
        payload.call_id || payload.turn_id || payload.thread_id || payload.id || '',
      ].join('|');

    return {
      id: rawEvent.id || `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      eventType,
      timestamp,
      toolName,
      filePath,
      status: rawEvent.status || payload.status || null,
      source: rawEvent.source || 'runtime',
      summary: rawEvent.summary || eventSummary({ ...rawEvent, eventType, toolName, filePath }),
      message: rawEvent.message || payload.message || null,
      payload,
      fingerprint,
      fileEventType: pickFileEventType(eventType, firstParsed.type),
    };
  }

  #ingestIntoMemory(event, trackFingerprint) {
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) {
      const removed = this.events.splice(0, this.events.length - MAX_EVENTS);
      for (const item of removed) {
        if (item.fingerprint) this.byFingerprint.delete(item.fingerprint);
      }
    }

    if (event.fileEventType && event.filePath) {
      this.fileEvents.push({
        id: event.id,
        timestamp: event.timestamp,
        eventType: event.fileEventType,
        filePath: event.filePath,
        source: event.source,
        toolName: event.toolName,
      });
      if (this.fileEvents.length > MAX_FILE_EVENTS) {
        this.fileEvents.splice(0, this.fileEvents.length - MAX_FILE_EVENTS);
      }
    }

    if (trackFingerprint && event.fingerprint) {
      this.byFingerprint.add(event.fingerprint);
    } else if (event.fingerprint) {
      this.byFingerprint.add(event.fingerprint);
    }
  }

  #deriveStatus() {
    const recent = [...this.events].sort((a, b) => {
      const aTime = new Date(a.timestamp).getTime();
      const bTime = new Date(b.timestamp).getTime();
      return bTime - aTime;
    });
    if (!recent.length) {
      return {
        state: 'idle',
        currentTool: null,
        lastEventAt: null,
        waitingApproval: false,
      };
    }

    const now = Date.now();
    const lastEventAt = recent[0].timestamp;
    const lastEventMs = new Date(lastEventAt).getTime();
    if (Number.isFinite(lastEventMs) && now - lastEventMs > IDLE_THRESHOLD_MS) {
      return {
        state: 'idle',
        currentTool: null,
        lastEventAt,
        waitingApproval: false,
      };
    }

    let approvalPending = false;
    let activeTool = null;

    for (const event of recent) {
      if (event.eventType === 'approval_result') {
        approvalPending = false;
      }
      if (event.eventType === 'approval_request' && !approvalPending) {
        approvalPending = true;
      }
      if (event.eventType === 'tool_complete' && !activeTool) {
        activeTool = null;
      }
      if (event.eventType === 'tool_start') {
        activeTool = event.toolName || event.summary;
        break;
      }
      if (event.eventType === 'tool_complete') {
        break;
      }
    }

    if (approvalPending) {
      return {
        state: 'wait',
        currentTool: activeTool,
        lastEventAt,
        waitingApproval: true,
      };
    }

    if (activeTool) {
      return {
        state: 'tool_running',
        currentTool: activeTool,
        lastEventAt,
        waitingApproval: false,
      };
    }

    return {
      state: 'working',
      currentTool: null,
      lastEventAt,
      waitingApproval: false,
    };
  }
}
