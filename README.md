# codex-monitor

Dependency-light Codex runtime monitor. The first deliverable is a browser dashboard; the backend
is intentionally reusable for a later TUI.

## Product Direction

This project is not meant to be a web clone of the Codex CLI status line.

Its value is higher when it acts as an observability layer for:
- plan and quota visibility
- token analytics across turns
- event and file-flow monitoring
- session review and usage patterns

In short:
- CLI bottom bar: current state
- codex-monitor: current state + usage analytics + execution flow

## Web MVP

Features:
- `POST /codex/events` ingest endpoint for a notify hook
- polling of `~/.codex/sessions/*.jsonl` to derive tool and file events
- computed runtime status instead of persisted state
- static dashboard with current state, plan/quota status, token analytics, and event/file activity

Current dashboard priority:
1. `Now` card with state, current tool, plan badge, quota usage, and reset countdown
2. `Tokens` card with last turn, session total, context ratio, and token breakdown
3. `Recent Events` mix chart
4. `File Activity` mix chart

Current layout target:
- row 1: `Now`
- row 2: `Plan/Quota`, `Tokens`
- row 3: `Recent Events`, `File Activity`

Near-term roadmap:
- approaching-limit warning
- heavy-turn detection
- session insight card
- edit/write/delete-focused file intelligence

## Run

```bash
npm start
```

Default URL: `http://127.0.0.1:3001`

## Hook setup

Point Codex `notify` to the hook script:

```toml
notify = ["node", "/mnt/d/github/codex-monitor/hooks/send_event.js"]
```

Optional env vars:
- `PORT` or `CODEX_MONITOR_PORT`
- `HOST` or `CODEX_MONITOR_HOST`
- `CODEX_SESSIONS_DIR`

## Checks

```bash
npm run check
```
