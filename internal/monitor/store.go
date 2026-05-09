package monitor

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

type Store struct {
	repoPath      string
	events        []Event
	fileEvents    []FileEvent
	byFingerprint map[string]struct{}
}

func NewStore(repoPath string) *Store {
	return &Store{
		repoPath:      repoPath,
		byFingerprint: make(map[string]struct{}),
	}
}

func (s *Store) Record(raw Event) {
	event := normalizeEvent(raw)
	if event.Fingerprint != "" {
		if _, exists := s.byFingerprint[event.Fingerprint]; exists {
			return
		}
		s.byFingerprint[event.Fingerprint] = struct{}{}
	}

	s.events = append(s.events, event)
	if len(s.events) > MaxEvents {
		trim := len(s.events) - MaxEvents
		for _, item := range s.events[:trim] {
			delete(s.byFingerprint, item.Fingerprint)
		}
		s.events = s.events[trim:]
	}

	if event.FileEventType != "" && event.FilePath != "" {
		s.fileEvents = append(s.fileEvents, FileEvent{
			ID:        event.ID,
			Timestamp: event.Timestamp,
			EventType: event.FileEventType,
			FilePath:  event.FilePath,
			Source:    event.Source,
			ToolName:  event.ToolName,
		})
		if len(s.fileEvents) > MaxFileEvents {
			s.fileEvents = s.fileEvents[len(s.fileEvents)-MaxFileEvents:]
		}
	}
}

func (s *Store) Snapshot(now time.Time) Snapshot {
	recentEvents := reverseEvents(s.events, RecentEventCount)
	recentFiles := reverseFiles(s.fileEvents, RecentFileCount)
	tokenEvents := make([]Event, 0)
	for _, event := range s.events {
		if event.EventType == "token_usage" {
			tokenEvents = append(tokenEvents, event)
		}
	}

	var latestToken *Event
	if len(tokenEvents) > 0 {
		latestToken = &tokenEvents[len(tokenEvents)-1]
	}

	tokens := buildTokens(latestToken)
	usage := buildUsage(latestToken)

	return Snapshot{
		RepoPath:   s.repoPath,
		Status:     deriveStatus(s.events, now),
		Events:     recentEvents,
		Files:      recentFiles,
		EventTypes: topCounts(s.events, func(event Event) string { return event.EventType }),
		FileTypes:  topCounts(s.fileEvents, func(event FileEvent) string { return event.EventType }),
		Tokens:     tokens,
		Usage:      usage,
		Insights:   deriveInsights(s.events, s.fileEvents, tokens, usage),
		Totals: Totals{
			Events: len(s.events),
			Files:  len(s.fileEvents),
		},
		GeneratedAt: now,
	}
}

func normalizeEvent(raw Event) Event {
	event := raw
	if event.ID == "" {
		event.ID = fmt.Sprintf("%d-%s", time.Now().UnixNano(), strings.ReplaceAll(event.EventType, " ", "-"))
	}
	if event.Source == "" {
		event.Source = "session_log"
	}
	if event.CallID == "" {
		event.CallID = firstString(event.Payload["call_id"], nestedMapString(event.Payload, "arguments", "call_id"))
	}
	if event.ThreadID == "" {
		event.ThreadID = firstString(event.Payload["thread_id"], event.Payload["conversation_id"])
	}
	if event.TurnID == "" {
		event.TurnID = firstString(event.Payload["turn_id"])
	}
	if event.SessionID == "" {
		event.SessionID = firstString(event.Payload["id"], event.Payload["session_id"])
	}
	if event.Summary == "" {
		switch {
		case event.ToolName != "":
			event.Summary = event.ToolName
		case event.FilePath != "":
			event.Summary = event.FilePath
		default:
			event.Summary = event.EventType
		}
	}
	if event.Fingerprint == "" {
		event.Fingerprint = strings.Join([]string{
			event.EventType,
			event.Timestamp.UTC().Format(time.RFC3339Nano),
			event.ToolName,
			event.FilePath,
		}, "|")
	}
	if event.FileEventType == "" {
		switch event.EventType {
		case "file_read", "file_write", "file_edit", "file_delete":
			event.FileEventType = event.EventType
		}
	}
	return event
}

func reverseEvents(items []Event, limit int) []Event {
	if len(items) == 0 {
		return nil
	}
	start := max(0, len(items)-limit)
	out := make([]Event, 0, len(items)-start)
	for index := len(items) - 1; index >= start; index-- {
		out = append(out, items[index])
	}
	return out
}

func reverseFiles(items []FileEvent, limit int) []FileEvent {
	if len(items) == 0 {
		return nil
	}
	start := max(0, len(items)-limit)
	out := make([]FileEvent, 0, len(items)-start)
	for index := len(items) - 1; index >= start; index-- {
		out = append(out, items[index])
	}
	return out
}

func topCounts[T any](items []T, pick func(T) string) []CountItem {
	counts := make(map[string]int)
	for _, item := range items {
		label := pick(item)
		if label == "" {
			continue
		}
		counts[label]++
	}

	buckets := make([]CountItem, 0, len(counts))
	for label, value := range counts {
		buckets = append(buckets, CountItem{Label: label, Value: value})
	}
	sort.Slice(buckets, func(i, j int) bool {
		if buckets[i].Value == buckets[j].Value {
			return buckets[i].Label < buckets[j].Label
		}
		return buckets[i].Value > buckets[j].Value
	})
	if len(buckets) > TopBucketCount {
		buckets = buckets[:TopBucketCount]
	}
	return buckets
}

func deriveStatus(events []Event, now time.Time) Status {
	if len(events) == 0 {
		return Status{State: "idle"}
	}

	lastEvent := events[len(events)-1]
	lastEventAt := lastEvent.Timestamp
	if now.Sub(lastEventAt) > IdleThreshold {
		return Status{
			State:       "idle",
			LastEventAt: &lastEventAt,
		}
	}

	approvalPending := false
	activeTool := ""
	for index := len(events) - 1; index >= 0; index-- {
		event := events[index]
		switch event.EventType {
		case "approval_result":
			approvalPending = false
		case "approval_request":
			if !approvalPending {
				approvalPending = true
			}
		case "tool_start":
			activeTool = firstNonEmpty(event.ToolName, event.Summary)
			index = -1
		case "tool_complete":
			index = -1
		}
	}

	if approvalPending {
		return Status{
			State:           "wait",
			CurrentTool:     activeTool,
			LastEventAt:     &lastEventAt,
			WaitingApproval: true,
		}
	}
	if activeTool != "" {
		return Status{
			State:       "tool_running",
			CurrentTool: activeTool,
			LastEventAt: &lastEventAt,
		}
	}
	return Status{
		State:       "working",
		LastEventAt: &lastEventAt,
	}
}

func buildTokens(latest *Event) *SessionTokens {
	if latest == nil {
		return nil
	}
	info, ok := latest.Payload["info"].(map[string]any)
	if !ok {
		return nil
	}
	lastTurn := toTokenUsage(info["last_token_usage"])
	sessionTotal := toTokenUsage(info["total_token_usage"])
	contextWindow := toInt(info["model_context_window"])
	contextPercent := 0.0
	if contextWindow > 0 {
		contextPercent = float64(sessionTotal.TotalTokens) / float64(contextWindow) * 100
	}
	return &SessionTokens{
		LastTurn:            lastTurn,
		SessionTotal:        sessionTotal,
		ContextWindow:       contextWindow,
		ContextUsagePercent: round1(contextPercent),
	}
}

func buildUsage(latest *Event) *Usage {
	if latest == nil {
		return nil
	}
	rateLimits, ok := latest.Payload["rate_limits"].(map[string]any)
	if !ok {
		return nil
	}
	return &Usage{
		PlanType:  toString(rateLimits["plan_type"], "unknown"),
		Primary:   toLimitWindow(rateLimits["primary"]),
		Secondary: toLimitWindow(rateLimits["secondary"]),
	}
}

func deriveInsights(events []Event, files []FileEvent, tokens *SessionTokens, usage *Usage) InsightSummary {
	driver := "-"
	topDrivers := topCounts(events, classifyActivity)
	if len(topDrivers) > 0 {
		driver = topDrivers[0].Label
	}

	largestTurn := 0
	if tokens != nil {
		largestTurn = tokens.LastTurn.TotalTokens
	}

	risk := "low"
	if usage != nil {
		maxUsage := 0.0
		if usage.Primary != nil {
			maxUsage = max(maxUsage, usage.Primary.UsedPercent)
		}
		if usage.Secondary != nil {
			maxUsage = max(maxUsage, usage.Secondary.UsedPercent)
		}
		switch {
		case maxUsage > 80:
			risk = "high"
		case maxUsage > 50:
			risk = "medium"
		}
	}

	fileChanges := 0
	for _, file := range files {
		if file.EventType != "file_read" {
			fileChanges++
		}
	}

	return InsightSummary{
		DominantDriver: driver,
		LargestTurn:    largestTurn,
		FileChanges:    fileChanges,
		LimitRisk:      risk,
	}
}

func classifyActivity(event Event) string {
	name := strings.ToLower(event.ToolName)
	eventType := strings.ToLower(event.EventType)
	switch {
	case name == "apply_patch" || eventType == "file_edit" || eventType == "file_write" || eventType == "file_delete":
		return "file_change"
	case strings.Contains(name, "agent"):
		return "agent"
	case name == "exec_command":
		return "exec_command"
	case strings.HasPrefix(name, "web."):
		return "web"
	case eventType == "approval_request" || eventType == "approval_result":
		return "approval"
	case name != "":
		return name
	default:
		return eventType
	}
}

func toTokenUsage(value any) TokenUsage {
	data, _ := value.(map[string]any)
	return TokenUsage{
		TotalTokens:           toInt(data["total_tokens"]),
		InputTokens:           toInt(data["input_tokens"]),
		OutputTokens:          toInt(data["output_tokens"]),
		ReasoningOutputTokens: toInt(data["reasoning_output_tokens"]),
	}
}

func toLimitWindow(value any) *LimitWindow {
	data, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	window := &LimitWindow{
		UsedPercent: toFloat(data["used_percent"]),
	}
	if reset := toTime(data["resets_at"]); reset != nil {
		window.ResetsAt = reset
	}
	return window
}

func toTime(value any) *time.Time {
	text, ok := value.(string)
	if !ok || text == "" {
		return nil
	}
	parsed, err := time.Parse(time.RFC3339, text)
	if err != nil {
		return nil
	}
	return &parsed
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

func toFloat(value any) float64 {
	switch v := value.(type) {
	case float64:
		return v
	case int:
		return float64(v)
	case int64:
		return float64(v)
	default:
		return 0
	}
}

func toString(value any, fallback string) string {
	text, ok := value.(string)
	if !ok || text == "" {
		return fallback
	}
	return text
}

func round1(value float64) float64 {
	return float64(int(value*10+0.5)) / 10
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func firstString(values ...any) string {
	for _, value := range values {
		if text, ok := value.(string); ok && text != "" {
			return text
		}
	}
	return ""
}

func nestedMapString(payload map[string]any, key, nested string) any {
	child, ok := payload[key].(map[string]any)
	if !ok {
		return nil
	}
	return child[nested]
}
