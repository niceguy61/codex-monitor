package ingest

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/sunny/codex-monitor/internal/monitor"
)

type Runtime struct {
	RepoPath    string
	SessionsDir string
	mu          sync.Mutex
	store       *monitor.Store
	fileOffsets map[string]int64
	initialized bool
}

func NewRuntime(repoPath, sessionsDir string) *Runtime {
	return &Runtime{
		RepoPath:    repoPath,
		SessionsDir: sessionsDir,
		store:       monitor.NewStore(repoPath),
		fileOffsets: make(map[string]int64),
	}
}

func (r *Runtime) Snapshot() (monitor.Snapshot, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	files, err := listRecentJSONLFiles(r.SessionsDir)
	if err != nil {
		return monitor.Snapshot{}, err
	}
	for _, filePath := range files {
		if err := r.ingestFile(filePath, !r.initialized); err != nil {
			return monitor.Snapshot{}, err
		}
	}
	r.initialized = true
	return r.store.Snapshot(time.Now()), nil
}

func listRecentJSONLFiles(root string) ([]string, error) {
	years, err := listNames(root)
	if err != nil {
		return nil, err
	}
	years = filterDirs(years)
	if len(years) > 2 {
		years = years[len(years)-2:]
	}

	files := make([]string, 0)
	for _, year := range years {
		months, _ := listNames(filepath.Join(root, year.Name()))
		months = filterDirs(months)
		if len(months) > 3 {
			months = months[len(months)-3:]
		}
		for _, month := range months {
			days, _ := listNames(filepath.Join(root, year.Name(), month.Name()))
			days = filterDirs(days)
			if len(days) > 5 {
				days = days[len(days)-5:]
			}
			for _, day := range days {
				dir := filepath.Join(root, year.Name(), month.Name(), day.Name())
				entries, _ := listNames(dir)
				for _, entry := range entries {
					if !entry.Type().IsRegular() || !strings.HasSuffix(entry.Name(), ".jsonl") {
						continue
					}
					files = append(files, filepath.Join(dir, entry.Name()))
				}
			}
		}
	}
	sort.Strings(files)
	if len(files) > 5 {
		files = files[len(files)-5:]
	}
	return files, nil
}

func listNames(dirPath string) ([]os.DirEntry, error) {
	entries, err := os.ReadDir(dirPath)
	if err != nil {
		return nil, err
	}
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].Name() < entries[j].Name()
	})
	return entries, nil
}

func filterDirs(entries []os.DirEntry) []os.DirEntry {
	out := make([]os.DirEntry, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			out = append(out, entry)
		}
	}
	return out
}

func (r *Runtime) ingestFile(filePath string, fullRead bool) error {
	file, err := os.Open(filePath)
	if err != nil {
		return err
	}
	defer file.Close()

	stat, err := file.Stat()
	if err != nil {
		return err
	}

	offset := r.fileOffsets[filePath]
	if fullRead || stat.Size() < offset {
		offset = 0
	}
	if _, err := file.Seek(offset, io.SeekStart); err != nil {
		return err
	}

	chunk, err := io.ReadAll(file)
	if err != nil {
		return err
	}
	r.fileOffsets[filePath] = offset + int64(len(chunk))

	for _, rawLine := range bytes.Split(chunk, []byte{'\n'}) {
		line := strings.TrimSpace(string(rawLine))
		if line == "" {
			continue
		}
		var parsed map[string]any
		if err := json.Unmarshal([]byte(line), &parsed); err != nil {
			continue
		}
		for _, event := range parseLineToEvents(parsed, r.RepoPath) {
			r.store.Record(event)
		}
	}
	return nil
}

func parseLineToEvents(parsed map[string]any, repoPath string) []monitor.Event {
	timestampText, _ := parsed["timestamp"].(string)
	eventType, _ := parsed["type"].(string)
	if timestampText == "" || eventType == "" {
		return nil
	}
	timestamp, err := time.Parse(time.RFC3339Nano, timestampText)
	if err != nil {
		return nil
	}

	payload, _ := parsed["payload"].(map[string]any)
	switch eventType {
	case "session_meta":
		if cwd, _ := payload["cwd"].(string); cwd != repoPath {
			return nil
		}
		id, _ := payload["id"].(string)
		return []monitor.Event{{
			EventType:   "turn_start",
			Timestamp:   timestamp,
			Source:      "session_log",
			Summary:     "session_meta",
			Payload:     payload,
			Fingerprint: "turn_start|" + id + "|" + timestamp.UTC().Format(time.RFC3339Nano),
		}}
	case "response_item":
		return parseResponseItem(timestamp, payload, repoPath)
	case "event_msg":
		return parseEventMsg(timestamp, payload, repoPath)
	default:
		return nil
	}
}

func parseResponseItem(timestamp time.Time, payload map[string]any, repoPath string) []monitor.Event {
	payloadType, _ := payload["type"].(string)
	switch payloadType {
	case "function_call":
		name, _ := payload["name"].(string)
		callID, _ := payload["call_id"].(string)
		argsRaw, _ := payload["arguments"].(string)
		args := map[string]any{}
		if argsRaw != "" {
			_ = json.Unmarshal([]byte(argsRaw), &args)
		}
		if workdir, _ := args["workdir"].(string); workdir != "" && workdir != repoPath {
			return nil
		}

		events := []monitor.Event{{
			EventType: "tool_start",
			Timestamp: timestamp,
			Source:    "session_log",
			ToolName:  name,
			Summary:   summaryFromArgs(args, name),
			Payload: map[string]any{
				"call_id":   callID,
				"arguments": args,
			},
			Fingerprint: "tool_start|" + callID + "|" + name + "|" + timestamp.UTC().Format(time.RFC3339Nano),
		}}

		if name == "exec_command" && toString(args["sandbox_permissions"]) == "require_escalated" {
			events = append(events, monitor.Event{
				EventType: "approval_request",
				Timestamp: timestamp,
				Source:    "session_log",
				ToolName:  name,
				Summary:   firstNonEmpty(toString(args["justification"]), summaryFromArgs(args, "approval requested")),
				Payload: map[string]any{
					"call_id":   callID,
					"arguments": args,
				},
				Fingerprint: "approval_request|" + callID + "|" + timestamp.UTC().Format(time.RFC3339Nano),
			})
		}
		return events
	case "custom_tool_call":
		if toString(payload["name"]) != "apply_patch" {
			return nil
		}
		callID := toString(payload["call_id"])
		input := toString(payload["input"])
		files := parseApplyPatchInput(input)
		events := make([]monitor.Event, 0, len(files))
		for index, item := range files {
			events = append(events, buildFileEvent(timestamp, "apply_patch", callID, []string{"apply_patch"}, item, index))
		}
		return events
	default:
		return nil
	}
}

func parseEventMsg(timestamp time.Time, payload map[string]any, repoPath string) []monitor.Event {
	switch toString(payload["type"]) {
	case "exec_command_end":
		if cwd := toString(payload["cwd"]); cwd != repoPath {
			return nil
		}
		callID := toString(payload["call_id"])
		command := toStringSlice(payload["command"])
		events := []monitor.Event{{
			EventType:   "tool_complete",
			Timestamp:   timestamp,
			Source:      "session_log",
			ToolName:    "exec_command",
			Summary:     commandSummary(command),
			Status:      toString(payload["status"]),
			Payload:     payload,
			Fingerprint: "tool_complete|" + callID + "|" + timestamp.UTC().Format(time.RFC3339Nano),
		}}

		for _, item := range toParsedCommands(payload["parsed_cmd"]) {
			events = append(events, buildFileEvent(timestamp, "exec_command", callID, command, item, 0))
		}

		if toInt(payload["exit_code"]) == 0 {
			events = append(events, monitor.Event{
				EventType:   "approval_result",
				Timestamp:   timestamp,
				Source:      "session_log",
				ToolName:    "exec_command",
				Summary:     "command completed",
				Payload:     payload,
				Fingerprint: "approval_result|" + callID + "|" + timestamp.UTC().Format(time.RFC3339Nano),
			})
		}
		return events
	case "token_count":
		info, ok := payload["info"].(map[string]any)
		if !ok || len(info) == 0 {
			return nil
		}
		return []monitor.Event{{
			EventType:   "token_usage",
			Timestamp:   timestamp,
			Source:      "session_log",
			Summary:     "token usage",
			Payload:     payload,
			Fingerprint: "token_usage|" + timestamp.UTC().Format(time.RFC3339Nano),
		}}
	default:
		return nil
	}
}

type parsedCommand struct {
	Type string
	Path string
}

func buildFileEvent(timestamp time.Time, toolName, callID string, command []string, item parsedCommand, suffix int) monitor.Event {
	eventType := "file_read"
	switch item.Type {
	case "write":
		eventType = "file_write"
	case "edit":
		eventType = "file_edit"
	case "delete":
		eventType = "file_delete"
	}
	return monitor.Event{
		EventType:     eventType,
		Timestamp:     timestamp,
		Source:        "session_log",
		FilePath:      item.Path,
		ToolName:      toolName,
		Summary:       item.Path,
		FileEventType: eventType,
		Payload: map[string]any{
			"call_id": callID,
			"command": command,
			"parsed_cmd": []map[string]any{
				{"type": item.Type, "path": item.Path},
			},
		},
		Fingerprint: eventType + "|" + timestamp.UTC().Format(time.RFC3339Nano) + "|" + item.Path + "|" + callID + "|" + string(rune(suffix+'0')),
	}
}

func parseApplyPatchInput(input string) []parsedCommand {
	lines := strings.Split(input, "\n")
	files := make([]parsedCommand, 0)
	for _, line := range lines {
		switch {
		case strings.HasPrefix(line, "*** Add File: "):
			files = append(files, parsedCommand{Type: "write", Path: strings.TrimSpace(strings.TrimPrefix(line, "*** Add File: "))})
		case strings.HasPrefix(line, "*** Update File: "):
			files = append(files, parsedCommand{Type: "edit", Path: strings.TrimSpace(strings.TrimPrefix(line, "*** Update File: "))})
		case strings.HasPrefix(line, "*** Delete File: "):
			files = append(files, parsedCommand{Type: "delete", Path: strings.TrimSpace(strings.TrimPrefix(line, "*** Delete File: "))})
		}
	}
	return files
}

func toParsedCommands(value any) []parsedCommand {
	raw, ok := value.([]any)
	if !ok {
		return nil
	}
	out := make([]parsedCommand, 0, len(raw))
	for _, item := range raw {
		entry, ok := item.(map[string]any)
		if !ok {
			continue
		}
		path := toString(entry["path"])
		if path == "" {
			continue
		}
		out = append(out, parsedCommand{
			Type: toString(entry["type"]),
			Path: path,
		})
	}
	return out
}

func summaryFromArgs(args map[string]any, fallback string) string {
	if cmd := toString(args["cmd"]); cmd != "" {
		return cmd
	}
	if rawList, ok := args["cmd"].([]any); ok {
		parts := make([]string, 0, len(rawList))
		for _, item := range rawList {
			if text := toString(item); text != "" {
				parts = append(parts, text)
			}
		}
		if len(parts) > 0 {
			return strings.Join(parts, " ")
		}
	}
	return fallback
}

func commandSummary(command []string) string {
	if len(command) == 0 {
		return "exec_command"
	}
	return command[len(command)-1]
}

func toStringSlice(value any) []string {
	raw, ok := value.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		text := toString(item)
		if text != "" {
			out = append(out, text)
		}
	}
	return out
}

func toString(value any) string {
	text, _ := value.(string)
	return text
}

func toInt(value any) int {
	switch v := value.(type) {
	case int:
		return v
	case int64:
		return int(v)
	case float64:
		return int(v)
	default:
		return 0
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
