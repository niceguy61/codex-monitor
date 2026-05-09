# Linux TUI MVP

## Positioning

This TUI is not a terminal port of the React dashboard.

It should behave like a lightweight operator console:
- open fast
- work locally
- stay keyboard-first
- answer "what is happening right now?"

The first version is a status board, not a full observability product.

## Product Boundary

In scope:
- current runtime state
- current tool / wait state
- recent event stream
- recent file activity
- event detail drill-down
- lightweight refresh and filtering

Out of scope for MVP:
- long-range analytics
- historical charts
- cross-session reporting
- alerting
- trace correlation
- embedded web views

## Runtime Model

Preferred runtime:
- Linux-native binary
- no backend server required for local use
- reads `~/.codex/sessions/*.jsonl`
- derives the same normalized event types already used by the backend

Preferred stack:
- Go
- Bubble Tea
- Lip Gloss

Why this direction:
- easy Linux distribution
- single binary
- good TUI state/update model
- lower runtime overhead than a Node terminal app

## MVP Layout

### Header

Show:
- repo path
- overall state
- current tool
- approval wait state
- last event age

### Main Pane

Recent events list:
- newest-first
- keyboard navigation
- compact rows
- status/type emphasis over verbose text

Suggested columns:
- time
- event type
- tool
- summary

### Detail Pane

Shows the selected event:
- timestamp
- source
- status
- file path if present
- summary/message

### Secondary Pane

Recent file activity:
- read/write/edit/delete mix
- file path
- timestamp

### Footer

Key hints:
- `q` quit
- `r` refresh
- `/` filter
- `enter` detail focus

## Data Contract

Use the existing normalized event model as the behavioral reference:
- `turn_start`
- `turn_complete`
- `tool_start`
- `tool_complete`
- `file_read`
- `file_write`
- `file_edit`
- `file_delete`
- `approval_request`
- `approval_result`
- `token_usage`
- `error`

Status derivation should stay simple:
- `idle`
- `working`
- `tool_running`
- `wait`

## Implementation Notes

Recommended code split:
- `cmd/codex-monitor-tui` for the binary entrypoint
- `internal/ingest` for session-log parsing
- `internal/model` for normalized events and derived snapshot state
- `internal/ui` for Bubble Tea views

The first implementation should not depend on SQLite or the existing HTTP API.
It can borrow logic from the current Node implementation, but should not require the web server to run.
