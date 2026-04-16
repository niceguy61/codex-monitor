import { readdir, readFile } from 'fs/promises';
import path from 'path';

async function listNames(dirPath) {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

async function listRecentJsonlFiles(rootDir) {
  const years = (await listNames(rootDir)).filter((entry) => entry.isDirectory()).slice(-2);
  const files = [];

  for (const year of years) {
    const yearPath = path.join(rootDir, year.name);
    const months = (await listNames(yearPath)).filter((entry) => entry.isDirectory()).slice(-3);
    for (const month of months) {
      const monthPath = path.join(yearPath, month.name);
      const days = (await listNames(monthPath)).filter((entry) => entry.isDirectory()).slice(-5);
      for (const day of days) {
        const dayPath = path.join(monthPath, day.name);
        const dayFiles = (await listNames(dayPath))
          .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
          .map((entry) => path.join(dayPath, entry.name));
        files.push(...dayFiles);
      }
    }
  }

  return files.sort();
}

function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function buildFileEvent(base, item) {
  if (!item?.path) return null;
  const eventType =
    item.type === 'write'
      ? 'file_write'
      : item.type === 'edit'
        ? 'file_edit'
        : item.type === 'delete'
          ? 'file_delete'
          : 'file_read';
  return {
    eventType,
    timestamp: base.timestamp,
    source: 'session_log',
    filePath: item.path,
    toolName: base.toolName,
    summary: item.path,
    fingerprint: `${eventType}|${base.timestamp}|${item.path}|${base.callId || ''}|${item.fingerprint_suffix || 0}`,
    payload: {
      call_id: base.callId,
      parsed_cmd: [item],
      command: base.command,
    },
  };
}

function parseApplyPatchInput(input) {
  if (!input) return [];

  const files = [];
  const lines = String(input).split('\n');
  for (const line of lines) {
    if (line.startsWith('*** Add File: ')) {
      files.push({ type: 'write', path: line.slice('*** Add File: '.length).trim() });
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      files.push({ type: 'edit', path: line.slice('*** Update File: '.length).trim() });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      files.push({ type: 'delete', path: line.slice('*** Delete File: '.length).trim() });
    }
  }

  return files;
}

function parseLineToEvents(parsed, repoPath) {
  if (!parsed?.timestamp || !parsed?.type) return [];

  if (parsed.type === 'session_meta') {
    if (parsed.payload?.cwd !== repoPath) return [];
    return [
      {
        eventType: 'turn_start',
        timestamp: parsed.timestamp,
        source: 'session_log',
        summary: 'session_meta',
        payload: parsed.payload,
        fingerprint: `turn_start|${parsed.payload.id}|${parsed.timestamp}`,
      },
    ];
  }

  if (parsed.type === 'response_item' && parsed.payload?.type === 'function_call') {
    const name = parsed.payload.name;
    const args = safeJsonParse(parsed.payload.arguments || '{}') || {};
    if (args.workdir && args.workdir !== repoPath) return [];
    const events = [];

    if (name === 'exec_command') {
      events.push({
        eventType: 'tool_start',
        timestamp: parsed.timestamp,
        source: 'session_log',
        toolName: name,
        summary: args.cmd || name,
        payload: {
          call_id: parsed.payload.call_id,
          arguments: args,
        },
        fingerprint: `tool_start|${parsed.payload.call_id}|${args.cmd || ''}|${parsed.timestamp}`,
      });

      if (args.sandbox_permissions === 'require_escalated') {
        events.push({
          eventType: 'approval_request',
          timestamp: parsed.timestamp,
          source: 'session_log',
          toolName: name,
          summary: args.justification || args.cmd || 'approval requested',
          payload: {
            call_id: parsed.payload.call_id,
            arguments: args,
          },
          fingerprint: `approval_request|${parsed.payload.call_id}|${parsed.timestamp}`,
        });
      }
    }

    return events;
  }

  if (parsed.type === 'event_msg' && parsed.payload?.type === 'exec_command_end') {
    const payload = parsed.payload;
    if (payload.cwd !== repoPath) return [];
    const base = {
      timestamp: parsed.timestamp,
      toolName: 'exec_command',
      callId: payload.call_id,
      command: payload.command,
    };
    const events = [
      {
        eventType: 'tool_complete',
        timestamp: parsed.timestamp,
        source: 'session_log',
        toolName: 'exec_command',
        summary: payload.command?.slice?.(-1)?.[0] || payload.command?.join?.(' ') || 'exec_command',
        status: payload.status || null,
        payload,
        fingerprint: `tool_complete|${payload.call_id}|${payload.exit_code}|${parsed.timestamp}`,
      },
    ];

    for (const item of payload.parsed_cmd || []) {
      const fileEvent = buildFileEvent(base, item);
      if (fileEvent) events.push(fileEvent);
    }

    if (payload.exit_code === 0) {
      events.push({
        eventType: 'approval_result',
        timestamp: parsed.timestamp,
        source: 'session_log',
        toolName: 'exec_command',
        summary: 'command completed',
        payload,
        fingerprint: `approval_result|${payload.call_id}|${parsed.timestamp}`,
      });
    }

    return events;
  }

  if (
    parsed.type === 'response_item' &&
    parsed.payload?.type === 'custom_tool_call' &&
    parsed.payload?.name === 'apply_patch'
  ) {
    const patchFiles = parseApplyPatchInput(parsed.payload.input);
    if (!patchFiles.length) return [];

    return patchFiles.map((item, index) =>
      buildFileEvent(
        {
          timestamp: parsed.timestamp,
          toolName: 'apply_patch',
          callId: parsed.payload.call_id,
          command: ['apply_patch'],
        },
        {
          ...item,
          fingerprint_suffix: index,
        },
      ),
    ).filter(Boolean);
  }

  if (parsed.type === 'event_msg' && parsed.payload?.type === 'token_count') {
    if (!parsed.payload.info) return [];
    return [
      {
        eventType: 'token_usage',
        timestamp: parsed.timestamp,
        source: 'session_log',
        toolName: null,
        summary: 'token usage',
        payload: parsed.payload,
        fingerprint: `token_usage|${parsed.timestamp}|${parsed.payload.info.last_token_usage?.total_tokens || 0}`,
      },
    ];
  }

  return [];
}

export class SessionIngestor {
  constructor(options) {
    this.repoPath = options.repoPath;
    this.sessionsRoot = options.sessionsRoot;
    this.store = options.store;
    this.fileOffsets = new Map();
  }

  async poll() {
    const files = await listRecentJsonlFiles(this.sessionsRoot);
    const recent = files.slice(-5);
    for (const filePath of recent) {
      await this.#pollFile(filePath);
    }
  }

  async #pollFile(filePath) {
    let content;
    try {
      content = await readFile(filePath, 'utf8');
    } catch {
      return;
    }

    const offset = this.fileOffsets.get(filePath) || 0;
    if (content.length <= offset) return;
    this.fileOffsets.set(filePath, content.length);

    const chunk = content.slice(offset);
    const lines = chunk.split('\n').filter(Boolean);
    const parsedLines = lines.map((line) => safeJsonParse(line)).filter(Boolean);
    const repoKey = `${filePath}:repoMatch`;
    const knownMatch = this.fileOffsets.get(repoKey) === 1;
    const belongsToRepo = knownMatch || parsedLines.some(
      (item) => item.type === 'session_meta' && item.payload?.cwd === this.repoPath,
    );
    this.fileOffsets.set(repoKey, belongsToRepo ? 1 : 0);
    if (!belongsToRepo) return;

    for (const parsed of parsedLines) {
      const events = parseLineToEvents(parsed, this.repoPath);
      for (const event of events) {
        await this.store.record(event);
      }
    }
  }
}
