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

## Linux TUI Direction

The next TUI should be a Linux-native terminal application, not a JavaScript dashboard rendered in a terminal.

Target shape:
- keyboard-first, `htop`/`k9s` style
- no always-on web server requirement
- local session ingest from `~/.codex/sessions`
- focused on current status, recent events, and drill-down

MVP scope:
1. top status bar: repo, state, current tool, last event age
2. main event list with keyboard navigation
3. detail pane for the selected event
4. recent file activity pane
5. refresh/filter/help keys

Recommended implementation direction:
- Go + Bubble Tea for the first Linux TUI pass
- reuse the existing ingest/event derivation logic as the reference behavior
- keep observability ambitions out of the first terminal version

This means the current web app remains the observability/dashboard surface, while the future Linux TUI is a separate operator console.

Current TUI entrypoint:

```bash
go run ./cmd/codex-monitor-tui
```

Build a local binary:

```bash
go build ./cmd/codex-monitor-tui
```

Optional flags:
- `-repo /path/to/repo`
- `-sessions-dir ~/.codex/sessions`
- `-interval 2s`

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
env GOCACHE=/tmp/go-build GOMODCACHE=/tmp/go-mod go test ./cmd/codex-monitor-tui ./internal/...
```
