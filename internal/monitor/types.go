package monitor

import "time"

const (
	MaxEvents        = 400
	MaxFileEvents    = 120
	IdleThreshold    = 30 * time.Second
	TopBucketCount   = 6
	RecentEventCount = 60
	RecentFileCount  = 60
)

type Event struct {
	ID            string
	EventType     string
	Timestamp     time.Time
	ToolName      string
	CallID        string
	ThreadID      string
	TurnID        string
	SessionID     string
	FilePath      string
	Status        string
	Source        string
	Summary       string
	Message       string
	Fingerprint   string
	FileEventType string
	Payload       map[string]any
}

type FileEvent struct {
	ID        string
	Timestamp time.Time
	EventType string
	FilePath  string
	Source    string
	ToolName  string
}

type Status struct {
	State           string
	CurrentTool     string
	LastEventAt     *time.Time
	WaitingApproval bool
}

type TokenUsage struct {
	TotalTokens           int
	InputTokens           int
	OutputTokens          int
	ReasoningOutputTokens int
}

type SessionTokens struct {
	LastTurn            TokenUsage
	SessionTotal        TokenUsage
	ContextWindow       int
	ContextUsagePercent float64
}

type LimitWindow struct {
	UsedPercent float64
	ResetsAt    *time.Time
}

type Usage struct {
	PlanType  string
	Primary   *LimitWindow
	Secondary *LimitWindow
}

type CountItem struct {
	Label string
	Value int
}

type InsightSummary struct {
	DominantDriver string
	LargestTurn    int
	FileChanges    int
	HeavyTurnCount int
	LimitRisk      string
}

type Snapshot struct {
	RepoPath    string
	Status      Status
	Events      []Event
	Files       []FileEvent
	EventTypes  []CountItem
	FileTypes   []CountItem
	Tokens      *SessionTokens
	Usage       *Usage
	Insights    InsightSummary
	Totals      Totals
	GeneratedAt time.Time
}

type Totals struct {
	Events int
	Files  int
}
