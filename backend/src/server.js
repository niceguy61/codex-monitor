import http from 'http';
import { mkdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import { MonitorStore } from './lib/monitor.js';
import { SessionIngestor } from './lib/session-ingest.js';
import { SqliteEventStore, buildSqlitePaths } from './lib/sqlite-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, '..');
const projectRoot = path.resolve(__dirname, '../..');
const monitoredRepoPath = process.env.CODEX_MONITOR_REPO_PATH || projectRoot;
const dataDir = process.env.CODEX_MONITOR_DATA_DIR || path.join(projectRoot, '.data');
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3001);
const sessionsRoot = process.env.CODEX_SESSIONS_DIR || path.join(process.env.HOME || '', '.codex', 'sessions');
const sqlitePaths = buildSqlitePaths(dataDir);
let sqliteStore;

let store;

let ingestor;

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}

function parseRange(url) {
  const now = Date.now();
  const last = url.searchParams.get('last');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');

  if (from && to) {
    return {
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
    };
  }

  const amount = last ? Number(last.slice(0, -1)) : 24;
  const unit = last ? last.slice(-1) : 'h';
  const unitMs =
    unit === 'm' ? 60_000 :
    unit === 'h' ? 3_600_000 :
    unit === 'd' ? 86_400_000 :
    3_600_000;
  const rangeMs = Math.max(1, amount) * unitMs;
  return {
    from: new Date(now - rangeMs).toISOString(),
    to: new Date(now).toISOString(),
  };
}

function resolveBucketMs(url, range) {
  const explicit = Number(url.searchParams.get('bucket_ms') || 0);
  if (explicit > 0) return explicit;

  const spanMs = new Date(range.to).getTime() - new Date(range.from).getTime();
  if (spanMs <= 15 * 60_000) return 60_000;
  if (spanMs <= 60 * 60_000) return 5 * 60_000;
  if (spanMs <= 6 * 60 * 60_000) return 15 * 60_000;
  if (spanMs <= 24 * 60 * 60_000) return 60 * 60_000;
  if (spanMs <= 7 * 24 * 60 * 60_000) return 6 * 60 * 60_000;
  return 24 * 60 * 60_000;
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);

  if (req.method === 'GET' && url.pathname === '/api/snapshot') {
    sendJson(res, 200, store.snapshot());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/history/events') {
    const limit = Number(url.searchParams.get('limit') || 50);
    sendJson(res, 200, {
      items: sqliteStore.getRecentEvents(Math.max(1, Math.min(limit, 200))),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/history/event-types') {
    const limit = Number(url.searchParams.get('limit') || 12);
    const range = parseRange(url);
    sendJson(res, 200, {
      range,
      items: sqliteStore.getEventTypeSummaryForRange(range, Math.max(1, Math.min(limit, 50))),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/history/file-types') {
    const limit = Number(url.searchParams.get('limit') || 12);
    const range = parseRange(url);
    sendJson(res, 200, {
      range,
      items: sqliteStore.getFileTypeSummaryForRange(range, Math.max(1, Math.min(limit, 50))),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/history/daily-tokens') {
    const limit = Number(url.searchParams.get('limit') || 30);
    sendJson(res, 200, {
      items: sqliteStore.getDailyTokenSummary(Math.max(1, Math.min(limit, 120))),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/history/timeseries') {
    const metric = url.searchParams.get('metric') || 'tokens';
    const range = parseRange(url);
    const bucketMs = resolveBucketMs(url, range);

    const items =
      metric === 'events' ? sqliteStore.getEventTimeSeries(range, bucketMs) :
      metric === 'files' ? sqliteStore.getFileTimeSeries(range, bucketMs) :
      sqliteStore.getTokenTimeSeries(range, bucketMs);

    sendJson(res, 200, {
      metric,
      range,
      bucketMs,
      items,
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    store.subscribe(res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/codex/events') {
    try {
      const raw = await collectBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const event = await store.record({
        eventType: body.eventType,
        timestamp: body.timestamp,
        payload: body.payload,
        source: body.source || 'notify_hook',
        summary: body.summary,
        toolName: body.toolName,
        filePath: body.filePath,
        status: body.status,
      });
      sendJson(res, 202, { ok: true, accepted: !!event });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/healthz') {
    sendJson(res, 200, { ok: true, sqlite: sqliteStore.getStats() });
    return;
  }

  sendJson(res, 404, { error: 'not_found' });
});

async function bootstrap() {
  await mkdir(dataDir, { recursive: true });
  sqliteStore = new SqliteEventStore(sqlitePaths);
  sqliteStore.init();

  store = new MonitorStore({
    repoPath: monitoredRepoPath,
    dataDir,
    sqliteStore,
  });

  ingestor = new SessionIngestor({
    repoPath: monitoredRepoPath,
    sessionsRoot,
    store,
  });

  await store.init();

  server.listen(port, host, () => {
    console.log(`codex-monitor listening on http://${host}:${port}`);
  });

  ingestor.poll().catch(() => {});
  setInterval(() => {
    ingestor.poll().catch(() => {});
  }, 2_000);
}

bootstrap().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
