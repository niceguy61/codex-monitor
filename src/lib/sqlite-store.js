import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'fs';
import path from 'path';

export class SqliteEventStore {
  constructor(options = {}) {
    this.dbPath = options.dbPath;
    this.jsonlPath = options.jsonlPath;
    this.db = new Database(this.dbPath);
    this.insertStmt = null;
  }

  init() {
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        tool_name TEXT,
        file_path TEXT,
        status TEXT,
        source TEXT,
        summary TEXT,
        message TEXT,
        fingerprint TEXT UNIQUE,
        file_event_type TEXT,
        raw_json TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_events_event_type ON events(event_type);
      CREATE INDEX IF NOT EXISTS idx_events_tool_name ON events(tool_name);
      CREATE INDEX IF NOT EXISTS idx_events_file_path ON events(file_path);
    `);

    this.insertStmt = this.db.prepare(`
      INSERT OR IGNORE INTO events (
        id,
        event_type,
        timestamp,
        tool_name,
        file_path,
        status,
        source,
        summary,
        message,
        fingerprint,
        file_event_type,
        raw_json
      ) VALUES (
        @id,
        @event_type,
        @timestamp,
        @tool_name,
        @file_path,
        @status,
        @source,
        @summary,
        @message,
        @fingerprint,
        @file_event_type,
        @raw_json
      )
    `);

    this.#backfillFromJsonl();
  }

  persist(event) {
    if (!this.insertStmt) {
      throw new Error('sqlite store not initialized');
    }

    this.insertStmt.run({
      id: event.id,
      event_type: event.eventType,
      timestamp: event.timestamp,
      tool_name: event.toolName || null,
      file_path: event.filePath || null,
      status: event.status || null,
      source: event.source || null,
      summary: event.summary || null,
      message: event.message || null,
      fingerprint: event.fingerprint || null,
      file_event_type: event.fileEventType || null,
      raw_json: JSON.stringify(event),
    });
  }

  getStats() {
    const total = this.db.prepare('SELECT COUNT(*) AS count FROM events').get();
    const latest = this.db.prepare('SELECT MAX(timestamp) AS timestamp FROM events').get();
    return {
      count: total.count,
      latestTimestamp: latest.timestamp,
      dbPath: this.dbPath,
    };
  }

  getRecentEvents(limit = 50) {
    return this.db.prepare(`
      SELECT
        id,
        event_type AS eventType,
        timestamp,
        tool_name AS toolName,
        file_path AS filePath,
        status,
        source,
        summary,
        message,
        file_event_type AS fileEventType
      FROM events
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(limit);
  }

  getEventTypeSummary(limit = 12) {
    return this.db.prepare(`
      SELECT
        event_type AS eventType,
        COUNT(*) AS count
      FROM events
      GROUP BY event_type
      ORDER BY count DESC
      LIMIT ?
    `).all(limit);
  }

  getDailyTokenSummary(limit = 30) {
    const rows = this.db.prepare(`
      SELECT
        substr(timestamp, 1, 10) AS day,
        raw_json AS rawJson
      FROM events
      WHERE event_type = 'token_usage'
      ORDER BY day DESC, timestamp DESC
    `).all();

    const byDay = new Map();
    for (const row of rows) {
      if (!byDay.has(row.day)) {
        byDay.set(row.day, {
          day: row.day,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
        });
      }
      const target = byDay.get(row.day);
      try {
        const parsed = JSON.parse(row.rawJson);
        const usage = parsed?.payload?.info?.last_token_usage;
        target.totalTokens += usage?.total_tokens || 0;
        target.inputTokens += usage?.input_tokens || 0;
        target.outputTokens += usage?.output_tokens || 0;
        target.reasoningTokens += usage?.reasoning_output_tokens || 0;
      } catch {
        // Ignore malformed row payloads.
      }
    }

    return [...byDay.values()]
      .sort((a, b) => b.day.localeCompare(a.day))
      .slice(0, limit);
  }

  close() {
    this.db.close();
  }

  #backfillFromJsonl() {
    if (!this.jsonlPath || !existsSync(this.jsonlPath)) return;

    const content = readFileSync(this.jsonlPath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    if (!lines.length) return;

    const transaction = this.db.transaction((entries) => {
      for (const line of entries) {
        try {
          const event = JSON.parse(line);
          this.persist(event);
        } catch {
          // Ignore malformed historical lines.
        }
      }
    });

    transaction(lines);
  }
}

export function buildSqlitePaths(dataDir) {
  return {
    dbPath: path.join(dataDir, 'events.db'),
    jsonlPath: path.join(dataDir, 'events.jsonl'),
  };
}
