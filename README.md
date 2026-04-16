# codex-monitor

Codex runtime monitor with a split frontend/backend architecture.

Current structure:
- `frontend/` — Vite + React UI
- `backend/` — Node + SQLite API and ingest layer

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

## Current State

Implemented:
- `POST /codex/events` ingest endpoint for a notify hook
- polling of `~/.codex/sessions/*.jsonl` to derive tool, file, approval, and token events
- SQLite-backed event persistence and history APIs
- React frontend under `frontend/`
- ECharts-based history/time-series charts
- tabbed dashboard: `Overview`, `Tokens`, `Flow`, `Optimizer`

Current dashboard priority:
1. `Now`
2. summary strip (`5h/7d usage + reset`)
3. time controls
4. `Overview`
5. `Tokens`
6. `Flow`
7. `Optimizer`

Current layout target:
- row 1: `Now`
- row 2: summary strip
- row 3: tabs + time controls + tab panels

Near-term roadmap:
- React polish and parity with legacy static UI
- richer optimizer heuristics
- history views on top of SQLite APIs
- edit/write/delete-focused file intelligence

## Run

This project works best as a host-native tool because the backend needs direct access to:
- `~/.codex/sessions`
- local notify hooks
- host filesystem paths and repo working directories
- local SQLite data under `.data/`

Backend API:

```bash
cd backend
npm install
npm start
```

Frontend UI:

```bash
cd frontend
npm install
npm run dev
```

Default URLs:
- frontend: `http://127.0.0.1:5173`
- backend API: `http://127.0.0.1:3001`

Development model:
- `frontend/` is now the primary UI surface
- `backend/` is the runtime ingest and API layer
- the older static files under `public/` are legacy and should not be the primary target for new UI work

## Hook setup

Point Codex `notify` to the hook script:

```toml
notify = ["node", "/mnt/d/github/codex-monitor/backend/hooks/send_event.js"]
```

Optional env vars:
- `PORT` or `CODEX_MONITOR_PORT`
- `HOST` or `CODEX_MONITOR_HOST`
- `CODEX_SESSIONS_DIR`
- `CODEX_MONITOR_REPO_PATH`

## Checks

```bash
cd backend && npm run check
cd frontend && npm run build
```
