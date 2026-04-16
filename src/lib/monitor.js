import { mkdir, appendFile, readFile } from 'fs/promises';
import path from 'path';

const MAX_EVENTS = 400;
const MAX_FILE_EVENTS = 120;
const IDLE_THRESHOLD_MS = 30_000;
const TOP_BUCKET_COUNT = 6;
const TOKEN_TREND_COUNT = 10;

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

export class MonitorStore {
  constructor(options = {}) {
    this.repoPath = options.repoPath;
    this.dataDir = options.dataDir;
    this.logPath = path.join(this.dataDir, 'events.jsonl');
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
    const recent = [...this.events].reverse();
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
