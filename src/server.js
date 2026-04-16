import http from 'http';
import { mkdir, readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import { MonitorStore } from './lib/monitor.js';
import { SessionIngestor } from './lib/session-ingest.js';
import { SqliteEventStore, buildSqlitePaths } from './lib/sqlite-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const publicDir = path.join(repoRoot, 'public');
const chartJsPath = path.join(repoRoot, 'node_modules', 'chart.js', 'dist', 'chart.umd.js');
const dataDir = process.env.CODEX_MONITOR_DATA_DIR || path.join(repoRoot, '.data');
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3001);
const sessionsRoot = process.env.CODEX_SESSIONS_DIR || path.join(process.env.HOME || '', '.codex', 'sessions');
const sqlitePaths = buildSqlitePaths(dataDir);

const sqliteStore = new SqliteEventStore(sqlitePaths);
sqliteStore.init();

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const store = new MonitorStore({
  repoPath: repoRoot,
  dataDir,
  sqliteStore,
});

const ingestor = new SessionIngestor({
  repoPath: repoRoot,
  sessionsRoot,
  store,
});

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}

async function serveStatic(res, requestPath) {
  const cleanPath = requestPath === '/' ? '/index.html' : requestPath;
  const filePath = path.join(publicDir, cleanPath);
  if (!filePath.startsWith(publicDir)) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }

  try {
    const body = await readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'application/octet-stream' });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: 'not_found' });
  }
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
    sendJson(res, 200, {
      items: sqliteStore.getEventTypeSummary(Math.max(1, Math.min(limit, 50))),
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

  if (req.method === 'GET' && url.pathname === '/vendor/chart.js') {
    try {
      const body = await readFile(chartJsPath);
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      res.end(body);
    } catch {
      sendJson(res, 404, { error: 'chart_js_not_found' });
    }
    return;
  }

  await serveStatic(res, url.pathname);
});

async function bootstrap() {
  await mkdir(dataDir, { recursive: true });
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
