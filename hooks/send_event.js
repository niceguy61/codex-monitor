#!/usr/bin/env node

import http from 'http';

function parseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.on('data', (chunk) => {
      raw += chunk;
    });
    process.stdin.on('end', () => resolve(raw));
    process.stdin.on('error', () => resolve(''));
  });
}

function buildEventType(payload) {
  const type = payload?.type || payload?.eventType;
  if (type === 'exec_command_end') return 'tool_complete';
  if (type === 'function_call') return 'tool_start';
  if (type === 'session_meta') return 'turn_start';
  if (type === 'agent-turn-complete') return 'turn_complete';
  return type || 'unknown';
}

async function main() {
  const stdinRaw = await readStdin();
  const stdinPayload = parseJson(stdinRaw);
  const argvPayload = parseJson(process.argv[process.argv.length - 1]);
  const payload = stdinPayload || argvPayload || {};
  if (!Object.keys(payload).length) {
    process.exit(0);
  }

  const event = {
    eventType: buildEventType(payload),
    timestamp: new Date().toISOString(),
    source: 'notify_hook',
    summary: payload.type || payload['last-assistant-message'] || 'notify',
    payload,
  };

  const body = JSON.stringify(event);
  const port = Number(process.env.CODEX_MONITOR_PORT || 3001);
  const host = process.env.CODEX_MONITOR_HOST || '127.0.0.1';

  const req = http.request(
    {
      host,
      port,
      path: '/codex/events',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    },
    () => {
      process.exit(0);
    },
  );

  req.on('error', () => {
    process.exit(0);
  });

  req.write(body);
  req.end();
}

main();
