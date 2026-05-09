package ui

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/sunny/codex-monitor/internal/ingest"
	"github.com/sunny/codex-monitor/internal/monitor"
)

type tickMsg time.Time

type snapshotMsg struct {
	snapshot monitor.Snapshot
	err      error
}

type tabMode string

const (
	tabOverview tabMode = "overview"
	tabEvents   tabMode = "events"
	tabFiles    tabMode = "files"
)

type focusPane string

const (
	focusEvents focusPane = "events"
	focusFiles  focusPane = "files"
	focusDetail focusPane = "detail"
)

type Model struct {
	runtime       *ingest.Runtime
	interval      time.Duration
	width         int
	height        int
	snapshot      monitor.Snapshot
	tab           tabMode
	focus         focusPane
	eventPreset   string
	recentLimit   int
	timeWindow    time.Duration
	payloadFull   bool
	eventSelected int
	fileSelected  int
	detailOffset  int
	filterInput   textinput.Model
	filterMode    bool
	errorText     string
	lastRefreshed time.Time
}

func NewModel(runtime *ingest.Runtime, interval time.Duration) (Model, error) {
	input := textinput.New()
	input.Placeholder = "filter events"
	input.CharLimit = 64
	input.Width = 24

	return Model{
		runtime:     runtime,
		interval:    interval,
		tab:         tabOverview,
		focus:       focusEvents,
		recentLimit: 20,
		timeWindow:  30 * time.Minute,
		filterInput: input,
	}, nil
}

func (m Model) Init() tea.Cmd {
	return tea.Batch(fetchSnapshotCmd(m.runtime), tickCmd(m.interval))
}

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		return m, nil
	case snapshotMsg:
		if msg.err != nil {
			m.errorText = msg.err.Error()
			return m, nil
		}
		m.snapshot = msg.snapshot
		m.errorText = ""
		m.lastRefreshed = time.Now()
		m.eventSelected = clamp(m.eventSelected, 0, max(0, len(m.filteredEvents())-1))
		m.fileSelected = clamp(m.fileSelected, 0, max(0, len(m.visibleFiles())-1))
		m.detailOffset = clamp(m.detailOffset, 0, max(0, len(m.detailLines())-m.detailPageSize()))
		return m, nil
	case tickMsg:
		return m, tea.Batch(fetchSnapshotCmd(m.runtime), tickCmd(m.interval))
	case tea.KeyMsg:
		if m.filterMode {
			switch msg.String() {
			case "esc":
				m.filterMode = false
				m.filterInput.Blur()
				return m, nil
			case "enter":
				m.filterMode = false
				m.filterInput.Blur()
				m.eventSelected = 0
				m.fileSelected = 0
				m.detailOffset = 0
				return m, nil
			}
			var cmd tea.Cmd
			m.filterInput, cmd = m.filterInput.Update(msg)
			m.eventSelected = 0
			m.fileSelected = 0
			m.detailOffset = 0
			return m, cmd
		}

		switch msg.String() {
		case "q", "ctrl+c":
			return m, tea.Quit
		case "r":
			return m, fetchSnapshotCmd(m.runtime)
		case "/", "f":
			m.filterMode = true
			m.filterInput.Focus()
			return m, nil
		case "0":
			m.eventPreset = ""
			m.eventSelected = 0
			m.detailOffset = 0
			return m, nil
		case "t":
			m.eventPreset = "tool"
			m.tab = tabEvents
			m.focus = focusEvents
			m.eventSelected = 0
			m.detailOffset = 0
			return m, nil
		case "p":
			m.eventPreset = "file"
			m.tab = tabEvents
			m.focus = focusEvents
			m.eventSelected = 0
			m.detailOffset = 0
			return m, nil
		case "a":
			m.eventPreset = "approval"
			m.tab = tabEvents
			m.focus = focusEvents
			m.eventSelected = 0
			m.detailOffset = 0
			return m, nil
		case "x":
			m.eventPreset = "error"
			m.tab = tabEvents
			m.focus = focusEvents
			m.eventSelected = 0
			m.detailOffset = 0
			return m, nil
		case "o":
			m.eventPreset = "token"
			m.tab = tabEvents
			m.focus = focusEvents
			m.eventSelected = 0
			m.detailOffset = 0
			return m, nil
		case "1":
			m.tab = tabOverview
			m.focus = focusEvents
			m.detailOffset = 0
			return m, nil
		case "!":
			m.recentLimit = 10
			m.eventSelected = 0
			m.fileSelected = 0
			return m, nil
		case "2":
			m.tab = tabEvents
			m.focus = focusEvents
			m.detailOffset = 0
			return m, nil
		case "@":
			m.recentLimit = 20
			m.eventSelected = 0
			m.fileSelected = 0
			return m, nil
		case "3":
			m.tab = tabFiles
			m.focus = focusFiles
			m.detailOffset = 0
			return m, nil
		case "m":
			m.timeWindow = 5 * time.Minute
			m.eventSelected = 0
			m.fileSelected = 0
			m.detailOffset = 0
			return m, nil
		case "n":
			m.timeWindow = 30 * time.Minute
			m.eventSelected = 0
			m.fileSelected = 0
			m.detailOffset = 0
			return m, nil
		case "b":
			m.timeWindow = 1 * time.Hour
			m.eventSelected = 0
			m.fileSelected = 0
			m.detailOffset = 0
			return m, nil
		case "#":
			m.recentLimit = 50
			m.eventSelected = 0
			m.fileSelected = 0
			return m, nil
		case "h", "left":
			m.tab = prevTab(m.tab)
			m.focus = defaultFocusForTab(m.tab)
			m.detailOffset = 0
			return m, nil
		case "l", "right":
			m.tab = nextTab(m.tab)
			m.focus = defaultFocusForTab(m.tab)
			m.detailOffset = 0
			return m, nil
		case "tab":
			m.focus = nextFocusForTab(m.tab, m.focus)
			m.detailOffset = 0
			return m, nil
		case "shift+tab":
			m.focus = prevFocusForTab(m.tab, m.focus)
			m.detailOffset = 0
			return m, nil
		case "j", "down":
			m.moveDown()
			return m, nil
		case "k", "up":
			m.moveUp()
			return m, nil
		case "pgdown", "d":
			m.detailOffset = clamp(m.detailOffset+max(1, m.detailPageSize()/2), 0, max(0, len(m.detailLines())-m.detailPageSize()))
			return m, nil
		case "pgup", "u":
			m.detailOffset = clamp(m.detailOffset-max(1, m.detailPageSize()/2), 0, max(0, len(m.detailLines())-m.detailPageSize()))
			return m, nil
		case "g":
			switch m.focus {
			case focusFiles:
				m.fileSelected = 0
			case focusDetail:
				m.detailOffset = 0
			default:
				m.eventSelected = 0
			}
			return m, nil
		case "G":
			switch m.focus {
			case focusFiles:
				m.fileSelected = max(0, len(m.snapshot.Files)-1)
			case focusDetail:
				m.detailOffset = max(0, len(m.detailLines())-m.detailPageSize())
			default:
				m.eventSelected = max(0, len(m.filteredEvents())-1)
			}
			return m, nil
		case "enter":
			if m.focus == focusFiles {
				m.jumpToSelectedFileEvents()
				return m, nil
			}
			if m.focus == focusEvents {
				m.jumpToEventFile()
				return m, nil
			}
		case "e", " ":
			if m.focus == focusDetail && m.tab != tabFiles {
				m.payloadFull = !m.payloadFull
				m.detailOffset = 0
				return m, nil
			}
		}
	}
	return m, nil
}

func (m Model) View() string {
	if m.width == 0 || m.height == 0 {
		return "loading..."
	}

	header := m.renderHeader()
	footer := m.renderFooter()

	bodyHeight := max(8, m.height-lipgloss.Height(header)-lipgloss.Height(footer)-2)
	leftWidth := max(48, int(float64(m.width)*0.58))
	rightWidth := max(28, m.width-leftWidth-1)
	if rightWidth < 24 {
		leftWidth = m.width
		rightWidth = 0
	}

	var body string
	if rightWidth == 0 {
		body = lipgloss.NewStyle().Width(m.width).Height(bodyHeight).Render(m.renderPrimaryPane(bodyHeight))
	} else {
		leftPane := lipgloss.NewStyle().Width(leftWidth).Height(bodyHeight).Render(m.renderPrimaryPane(bodyHeight))
		rightTopHeight := max(8, bodyHeight/2)
		rightBottomHeight := max(6, bodyHeight-rightTopHeight-1)
		rightPane := lipgloss.JoinVertical(lipgloss.Left,
			lipgloss.NewStyle().Width(rightWidth).Height(rightTopHeight).Render(m.renderDetailPane(rightTopHeight)),
			lipgloss.NewStyle().Width(rightWidth).Height(rightBottomHeight).Render(m.renderSecondaryPane(rightBottomHeight)),
		)
		body = lipgloss.JoinHorizontal(lipgloss.Top, leftPane, rightPane)
	}

	return lipgloss.JoinVertical(lipgloss.Left, header, body, footer)
}

func (m Model) renderHeader() string {
	status := m.snapshot.Status
	lastEvent := "-"
	if status.LastEventAt != nil {
		lastEvent = fmt.Sprintf("%s (%s)", relativeTime(*status.LastEventAt), status.LastEventAt.Local().Format("01-02 15:04:05"))
	}

	plan := "-"
	if m.snapshot.Usage != nil && m.snapshot.Usage.PlanType != "" {
		plan = m.snapshot.Usage.PlanType
	}
	tokens := "-"
	context := "-"
	if m.snapshot.Tokens != nil {
		tokens = compactInt(m.snapshot.Tokens.LastTurn.TotalTokens)
		context = formatPercent(m.snapshot.Tokens.ContextUsagePercent)
	}

	usageLine := "usage primary -   secondary -"
	resetLine := "reset primary -   secondary -"
	if m.snapshot.Usage != nil {
		usageLine = fmt.Sprintf("usage primary %s %s   secondary %s %s",
			renderLimitWindow(m.snapshot.Usage.Primary),
			renderUsageBar(m.snapshot.Usage.Primary),
			renderLimitWindow(m.snapshot.Usage.Secondary),
			renderUsageBar(m.snapshot.Usage.Secondary),
		)
		resetLine = fmt.Sprintf("reset primary %s   secondary %s",
			renderResetWindow(m.snapshot.Usage.Primary),
			renderResetWindow(m.snapshot.Usage.Secondary),
		)
	}

	lines := []string{
		titleStyle.Render("codex-monitor tui") + "  " + subtleStyle.Render("linux operator console"),
		m.renderTabs(),
		fmt.Sprintf("repo %s", subtleStyle.Render(m.snapshot.RepoPath)),
		fmt.Sprintf("filters preset %s   text %s", firstNonEmpty(m.eventPreset, "all"), firstNonEmpty(strings.TrimSpace(m.filterInput.Value()), "-")),
		fmt.Sprintf("window recent %d   range %s", m.recentLimit, renderTimeWindow(m.timeWindow)),
		fmt.Sprintf("state %s   tool %s   last %s   plan %s   last turn %s   context %s",
			badgeStyle(status.State).Render(status.State),
			firstNonEmpty(status.CurrentTool, "-"),
			lastEvent,
			plan,
			tokens,
			context,
		),
		fmt.Sprintf("%s   totals events %d files %d", usageLine, m.snapshot.Totals.Events, m.snapshot.Totals.Files),
		resetLine,
	}
	if m.errorText != "" {
		lines = append(lines, errorStyle.Render("error: "+m.errorText))
	}
	return frameStyle.Width(m.width).Render(strings.Join(lines, "\n"))
}

func (m Model) renderTabs() string {
	tabs := []string{
		m.renderTab(tabOverview, "1 Overview"),
		m.renderTab(tabEvents, "2 Events"),
		m.renderTab(tabFiles, "3 Files"),
	}
	return lipgloss.JoinHorizontal(lipgloss.Left, tabs...)
}

func (m Model) renderTab(tab tabMode, label string) string {
	style := tabStyle
	if m.tab == tab {
		style = activeTabStyle
	}
	return style.Render(label)
}

func (m Model) renderPrimaryPane(height int) string {
	switch m.tab {
	case tabFiles:
		return m.renderFilesOnly(height)
	case tabEvents:
		return m.renderEventList(height)
	default:
		return m.renderOverview(height)
	}
}

func (m Model) renderOverview(height int) string {
	topHeight := max(10, height/2)
	bottomHeight := max(6, height-topHeight-1)
	return lipgloss.JoinVertical(lipgloss.Left,
		lipgloss.NewStyle().Height(topHeight).Render(m.renderOverviewSummary(topHeight)),
		lipgloss.NewStyle().Height(bottomHeight).Render(m.renderEventList(bottomHeight)),
	)
}

func (m Model) renderEventList(height int) string {
	events := m.filteredEvents()
	lines := []string{m.sectionTitle("Recent Events", m.focus == focusEvents)}
	if len(events) == 0 {
		lines = append(lines, subtleStyle.Render("no matching events"))
		return panelStyle.Height(height).Render(strings.Join(lines, "\n"))
	}

	maxRows := max(1, height-2)
	start := clamp(m.eventSelected-maxRows/2, 0, max(0, len(events)-maxRows))
	end := min(len(events), start+maxRows)
	for index := start; index < end; index++ {
		event := events[index]
		line := fmt.Sprintf("%s  %s  %-14s  %s",
			event.Timestamp.Local().Format("15:04:05"),
			renderEventBadge(event),
			truncate(firstNonEmpty(event.ToolName, "-"), 14),
			truncate(firstNonEmpty(event.Summary, event.FilePath, "-"), max(10, m.width/3)),
		)
		if index == m.eventSelected {
			lines = append(lines, m.selectionStyle(m.focus == focusEvents).Render(line))
		} else {
			lines = append(lines, line)
		}
	}
	return panelStyle.Height(height).Render(strings.Join(lines, "\n"))
}

func (m Model) renderFilesOnly(height int) string {
	lines := []string{m.sectionTitle("File Activity", m.focus == focusFiles)}
	files := m.visibleFiles()
	if len(files) == 0 {
		lines = append(lines, subtleStyle.Render("no file activity"))
		return panelStyle.Height(height).Render(strings.Join(lines, "\n"))
	}
	rows := max(1, height-2)
	start := clamp(m.fileSelected-rows/2, 0, max(0, len(files)-rows))
	end := min(len(files), start+rows)
	for index := start; index < end; index++ {
		lines = append(lines, renderFileRow(files[index], index == m.fileSelected, m.focus == focusFiles, m.width))
	}
	return panelStyle.Height(height).Render(strings.Join(lines, "\n"))
}

func (m Model) renderDetailPane(height int) string {
	lines := []string{m.sectionTitle(m.detailTitle(), m.focus == focusDetail)}
	detailLines := m.detailLines()
	if len(detailLines) == 0 {
		lines = append(lines, subtleStyle.Render("no detail available"))
		return panelStyle.Height(height).Render(strings.Join(lines, "\n"))
	}
	available := max(1, height-2)
	start := clamp(m.detailOffset, 0, max(0, len(detailLines)-available))
	end := min(len(detailLines), start+available)
	lines = append(lines, detailLines[start:end]...)
	return panelStyle.Height(height).Render(strings.Join(lines, "\n"))
}

func (m Model) renderSecondaryPane(height int) string {
	if m.tab == tabFiles {
		return panelStyle.Height(height).Render(strings.Join([]string{
			sectionTitleStyle.Render("Files Help"),
			"tab/shift+tab focus",
			"j/k move selection",
			"pgup/pgdn scroll detail",
			"enter jump to related events",
			"1/2/3 switch tabs",
		}, "\n"))
	}

	lines := []string{m.sectionTitle("Recent Files", m.focus == focusFiles)}
	files := m.visibleFiles()
	if len(files) == 0 {
		lines = append(lines, subtleStyle.Render("no file activity"))
		return panelStyle.Height(height).Render(strings.Join(lines, "\n"))
	}
	rows := min(len(files), max(1, height-2))
	start := clamp(m.fileSelected-rows/2, 0, max(0, len(files)-rows))
	end := min(len(files), start+rows)
	for index := start; index < end; index++ {
		lines = append(lines, renderFileRow(files[index], index == m.fileSelected, m.focus == focusFiles, m.width))
	}
	return panelStyle.Height(height).Render(strings.Join(lines, "\n"))
}

func (m Model) renderOverviewSummary(height int) string {
	lines := []string{sectionTitleStyle.Render("Overview")}
	lines = append(lines,
		fmt.Sprintf("live refreshed   %s", renderRefreshAge(m.lastRefreshed)),
		fmt.Sprintf("visible events   %d", len(m.filteredEvents())),
		fmt.Sprintf("visible files    %d", len(m.visibleFiles())),
		fmt.Sprintf("dominant driver  %s", firstNonEmpty(m.snapshot.Insights.DominantDriver, "-")),
		fmt.Sprintf("largest turn     %s", compactInt(m.snapshot.Insights.LargestTurn)),
		fmt.Sprintf("file changes     %d", m.snapshot.Insights.FileChanges),
		fmt.Sprintf("limit risk       %s", riskStyle(m.snapshot.Insights.LimitRisk).Render(firstNonEmpty(m.snapshot.Insights.LimitRisk, "-"))),
		"",
		"top event types",
	)
	for _, item := range m.snapshot.EventTypes {
		lines = append(lines, fmt.Sprintf("  %-18s %d", item.Label, item.Value))
	}
	if len(m.snapshot.FileTypes) > 0 {
		lines = append(lines, "", "top file types")
		for _, item := range m.snapshot.FileTypes {
			lines = append(lines, fmt.Sprintf("  %-18s %d", item.Label, item.Value))
		}
	}
	return panelStyle.Height(height).Render(strings.Join(lines, "\n"))
}

func (m Model) renderFooter() string {
	filterText := m.filterInput.Value()
	if filterText == "" {
		filterText = "-"
	}
	filterLine := fmt.Sprintf("filter %s", filterText)
	if m.filterMode {
		filterLine = "filter " + m.filterInput.View()
	}

	usageSummary := "usage -"
	if m.snapshot.Usage != nil {
		usageSummary = fmt.Sprintf("usage %s / %s   top %s",
			renderLimitWindow(m.snapshot.Usage.Primary),
			renderLimitWindow(m.snapshot.Usage.Secondary),
			renderTopEventTypes(m.snapshot.EventTypes),
		)
	} else {
		usageSummary = "top " + renderTopEventTypes(m.snapshot.EventTypes)
	}

	return footerStyle.Width(m.width).Render(
		fmt.Sprintf("q quit   r refresh   1/2/3 tabs   !/@/# recent 10/20/50   m/n/b range 5m/30m/1h   tab focus   j/k move   enter jump   e payload   pgup/pgdn scroll   0 all t tool p file a approval x error o token   %s   %s", filterLine, usageSummary),
	)
}

func (m Model) filteredEvents() []monitor.Event {
	needle := strings.ToLower(strings.TrimSpace(m.filterInput.Value()))
	out := make([]monitor.Event, 0)
	for _, event := range m.snapshot.Events {
		if !withinWindow(event.Timestamp, m.timeWindow) {
			continue
		}
		if !matchesPreset(event, m.eventPreset) {
			continue
		}
		if needle == "" {
			out = append(out, event)
			continue
		}
		haystack := strings.ToLower(strings.Join([]string{
			event.EventType,
			event.ToolName,
			event.FilePath,
			event.Summary,
			event.Message,
		}, " "))
		if strings.Contains(haystack, needle) {
			out = append(out, event)
		}
	}
	if len(out) > m.recentLimit {
		return out[:m.recentLimit]
	}
	return out
}

func (m Model) selectedEvent() (monitor.Event, bool) {
	events := m.filteredEvents()
	if len(events) == 0 {
		return monitor.Event{}, false
	}
	index := clamp(m.eventSelected, 0, len(events)-1)
	return events[index], true
}

func (m Model) selectedFile() (monitor.FileEvent, bool) {
	files := m.visibleFiles()
	if len(files) == 0 {
		return monitor.FileEvent{}, false
	}
	index := clamp(m.fileSelected, 0, len(files)-1)
	return files[index], true
}

func (m Model) detailTitle() string {
	if m.tab == tabFiles {
		return "File Detail"
	}
	return "Event Detail"
}

func (m Model) detailLines() []string {
	if m.tab == tabFiles {
		file, ok := m.selectedFile()
		if !ok {
			return nil
		}
		related := m.relatedEventsForFile(file.FilePath)
		return []string{
			fmt.Sprintf("time    %s", file.Timestamp.Local().Format("2006-01-02 15:04:05")),
			fmt.Sprintf("type    %s", file.EventType),
			fmt.Sprintf("tool    %s", firstNonEmpty(file.ToolName, "-")),
			fmt.Sprintf("source  %s", firstNonEmpty(file.Source, "-")),
			fmt.Sprintf("related %d events", len(related)),
			"",
			"path",
			file.FilePath,
			"",
			"hint",
			"enter jumps to related events",
		}
	}

	event, ok := m.selectedEvent()
	if !ok {
		return nil
	}

	lines := []string{
		fmt.Sprintf("time    %s", event.Timestamp.Local().Format("2006-01-02 15:04:05")),
		fmt.Sprintf("type    %s", event.EventType),
		fmt.Sprintf("tool    %s", firstNonEmpty(event.ToolName, "-")),
		fmt.Sprintf("call    %s", firstNonEmpty(event.CallID, "-")),
		fmt.Sprintf("thread  %s", firstNonEmpty(event.ThreadID, "-")),
		fmt.Sprintf("turn    %s", firstNonEmpty(event.TurnID, "-")),
		fmt.Sprintf("session %s", firstNonEmpty(event.SessionID, "-")),
		fmt.Sprintf("status  %s", firstNonEmpty(event.Status, "-")),
		fmt.Sprintf("source  %s", firstNonEmpty(event.Source, "-")),
		fmt.Sprintf("file    %s", firstNonEmpty(event.FilePath, "-")),
		fmt.Sprintf("related %s", m.relatedSummary(event)),
		"",
		"summary",
		firstNonEmpty(event.Summary, "-"),
	}
	if event.Message != "" {
		lines = append(lines, "", "message", event.Message)
	}
	if payloadSummary := summarizePayloadWithMode(event.Payload, m.payloadFull); payloadSummary != "" {
		lines = append(lines, "", fmt.Sprintf("payload (%s)", payloadModeLabel(m.payloadFull)), payloadSummary)
	}
	return wrapLines(lines)
}

func wrapLines(lines []string) []string {
	out := make([]string, 0, len(lines))
	for _, line := range lines {
		split := strings.Split(line, "\n")
		out = append(out, split...)
	}
	return out
}

func (m *Model) moveDown() {
	switch m.focus {
	case focusFiles:
		m.fileSelected = clamp(m.fileSelected+1, 0, max(0, len(m.visibleFiles())-1))
		m.detailOffset = 0
	case focusDetail:
		m.detailOffset = clamp(m.detailOffset+1, 0, max(0, len(m.detailLines())-m.detailPageSize()))
	default:
		m.eventSelected = clamp(m.eventSelected+1, 0, max(0, len(m.filteredEvents())-1))
		m.detailOffset = 0
	}
}

func (m *Model) moveUp() {
	switch m.focus {
	case focusFiles:
		m.fileSelected = clamp(m.fileSelected-1, 0, max(0, len(m.visibleFiles())-1))
		m.detailOffset = 0
	case focusDetail:
		m.detailOffset = clamp(m.detailOffset-1, 0, max(0, len(m.detailLines())-m.detailPageSize()))
	default:
		m.eventSelected = clamp(m.eventSelected-1, 0, max(0, len(m.filteredEvents())-1))
		m.detailOffset = 0
	}
}

func (m *Model) jumpToSelectedFileEvents() {
	file, ok := m.selectedFile()
	if !ok {
		return
	}
	m.tab = tabEvents
	m.focus = focusEvents
	m.filterInput.SetValue(file.FilePath)
	m.eventSelected = 0
	m.detailOffset = 0
}

func (m *Model) jumpToEventFile() {
	event, ok := m.selectedEvent()
	if !ok || event.FilePath == "" {
		return
	}
	m.tab = tabFiles
	m.focus = focusFiles
	files := m.visibleFiles()
	for index, file := range files {
		if file.FilePath == event.FilePath {
			m.fileSelected = index
			m.detailOffset = 0
			return
		}
	}
	m.fileSelected = 0
	m.detailOffset = 0
}

func (m Model) relatedEventsForFile(filePath string) []monitor.Event {
	if filePath == "" {
		return nil
	}
	out := make([]monitor.Event, 0)
	for _, event := range m.snapshot.Events {
		if event.FilePath == filePath {
			out = append(out, event)
		}
	}
	return out
}

func (m Model) relatedSummary(event monitor.Event) string {
	parts := make([]string, 0, 3)
	if event.CallID != "" {
		count := 0
		for _, item := range m.snapshot.Events {
			if item.CallID == event.CallID {
				count++
			}
		}
		parts = append(parts, fmt.Sprintf("call:%d", count))
	}
	if event.ThreadID != "" {
		count := 0
		for _, item := range m.snapshot.Events {
			if item.ThreadID == event.ThreadID {
				count++
			}
		}
		parts = append(parts, fmt.Sprintf("thread:%d", count))
	}
	if event.FilePath != "" {
		parts = append(parts, fmt.Sprintf("file:%d", len(m.relatedEventsForFile(event.FilePath))))
	}
	if len(parts) == 0 {
		return "-"
	}
	return strings.Join(parts, "  ")
}

func (m Model) detailPageSize() int {
	bodyHeight := max(8, m.height-lipgloss.Height(m.renderHeader())-lipgloss.Height(m.renderFooter())-2)
	return max(1, max(8, bodyHeight/2)-2)
}

func (m Model) sectionTitle(label string, focused bool) string {
	if focused {
		return focusedTitleStyle.Render(label)
	}
	return sectionTitleStyle.Render(label)
}

func (m Model) selectionStyle(focused bool) lipgloss.Style {
	if focused {
		return focusedSelectionStyle
	}
	return selectedStyle
}

func defaultFocusForTab(tab tabMode) focusPane {
	if tab == tabFiles {
		return focusFiles
	}
	return focusEvents
}

func nextTab(current tabMode) tabMode {
	switch current {
	case tabOverview:
		return tabEvents
	case tabEvents:
		return tabFiles
	default:
		return tabOverview
	}
}

func prevTab(current tabMode) tabMode {
	switch current {
	case tabFiles:
		return tabEvents
	case tabEvents:
		return tabOverview
	default:
		return tabFiles
	}
}

func nextFocusForTab(tab tabMode, current focusPane) focusPane {
	if tab == tabFiles {
		switch current {
		case focusFiles:
			return focusDetail
		default:
			return focusFiles
		}
	}
	switch current {
	case focusEvents:
		return focusDetail
	case focusDetail:
		return focusFiles
	default:
		return focusEvents
	}
}

func prevFocusForTab(tab tabMode, current focusPane) focusPane {
	if tab == tabFiles {
		switch current {
		case focusDetail:
			return focusFiles
		default:
			return focusDetail
		}
	}
	switch current {
	case focusFiles:
		return focusDetail
	case focusDetail:
		return focusEvents
	default:
		return focusFiles
	}
}

func renderFileRow(file monitor.FileEvent, selected, focused bool, width int) string {
	line := fmt.Sprintf("%s  %s  %s",
		file.Timestamp.Local().Format("15:04:05"),
		renderFileBadge(file.EventType),
		truncate(file.FilePath, max(10, width/4)),
	)
	if selected {
		if focused {
			return focusedSelectionStyle.Render(line)
		}
		return selectedStyle.Render(line)
	}
	return line
}

func (m Model) visibleFiles() []monitor.FileEvent {
	files := make([]monitor.FileEvent, 0, len(m.snapshot.Files))
	for _, file := range m.snapshot.Files {
		if withinWindow(file.Timestamp, m.timeWindow) {
			files = append(files, file)
		}
	}
	if len(files) > m.recentLimit {
		return files[:m.recentLimit]
	}
	return files
}

func renderEventBadge(event monitor.Event) string {
	label := truncate(event.EventType, 12)
	return eventBadgeStyle(event).Render(padBadge(label, 12))
}

func renderFileBadge(eventType string) string {
	return fileBadgeStyle(eventType).Render(padBadge(truncate(eventType, 10), 10))
}

func padBadge(label string, width int) string {
	if len(label) >= width {
		return label
	}
	return label + strings.Repeat(" ", width-len(label))
}

func eventBadgeStyle(event monitor.Event) lipgloss.Style {
	color := lipgloss.Color("245")
	switch {
	case event.EventType == "error":
		color = lipgloss.Color("203")
	case event.EventType == "approval_request" || event.EventType == "approval_result":
		color = lipgloss.Color("214")
	case event.EventType == "token_usage":
		color = lipgloss.Color("45")
	case event.FileEventType != "" || strings.HasPrefix(event.EventType, "file_"):
		color = lipgloss.Color("141")
	case event.EventType == "tool_start" || event.EventType == "tool_complete":
		color = lipgloss.Color("81")
	}
	return lipgloss.NewStyle().Foreground(color).Bold(true)
}

func fileBadgeStyle(eventType string) lipgloss.Style {
	color := lipgloss.Color("141")
	switch eventType {
	case "file_delete":
		color = lipgloss.Color("203")
	case "file_edit":
		color = lipgloss.Color("214")
	case "file_write":
		color = lipgloss.Color("81")
	case "file_read":
		color = lipgloss.Color("245")
	}
	return lipgloss.NewStyle().Foreground(color).Bold(true)
}

func fetchSnapshotCmd(runtime *ingest.Runtime) tea.Cmd {
	return func() tea.Msg {
		snapshot, err := runtime.Snapshot()
		return snapshotMsg{snapshot: snapshot, err: err}
	}
}

func tickCmd(interval time.Duration) tea.Cmd {
	return tea.Tick(interval, func(t time.Time) tea.Msg {
		return tickMsg(t)
	})
}

var (
	frameStyle            = lipgloss.NewStyle().Padding(0, 1, 1, 1)
	panelStyle            = lipgloss.NewStyle().Border(lipgloss.NormalBorder()).BorderForeground(lipgloss.Color("240")).Padding(0, 1)
	footerStyle           = lipgloss.NewStyle().Padding(0, 1).Foreground(lipgloss.Color("246"))
	tabStyle              = lipgloss.NewStyle().Padding(0, 1).Foreground(lipgloss.Color("246"))
	activeTabStyle        = lipgloss.NewStyle().Padding(0, 1).Bold(true).Foreground(lipgloss.Color("230")).Background(lipgloss.Color("238"))
	titleStyle            = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("230"))
	sectionTitleStyle     = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("229"))
	focusedTitleStyle     = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("229")).Underline(true)
	selectedStyle         = lipgloss.NewStyle().Foreground(lipgloss.Color("230")).Background(lipgloss.Color("24"))
	focusedSelectionStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("230")).Background(lipgloss.Color("62")).Bold(true)
	subtleStyle           = lipgloss.NewStyle().Foreground(lipgloss.Color("246"))
	errorStyle            = lipgloss.NewStyle().Foreground(lipgloss.Color("203"))
)

func badgeStyle(state string) lipgloss.Style {
	color := lipgloss.Color("240")
	switch state {
	case "working":
		color = lipgloss.Color("34")
	case "tool_running", "wait":
		color = lipgloss.Color("214")
	case "idle":
		color = lipgloss.Color("245")
	}
	return lipgloss.NewStyle().Foreground(color).Bold(true)
}

func relativeTime(t time.Time) string {
	diff := time.Since(t)
	switch {
	case diff < 5*time.Second:
		return "just now"
	case diff < time.Minute:
		return fmt.Sprintf("%ds ago", int(diff.Seconds()))
	case diff < time.Hour:
		return fmt.Sprintf("%dm ago", int(diff.Minutes()))
	case diff < 24*time.Hour:
		return fmt.Sprintf("%dh ago", int(diff.Hours()))
	default:
		return fmt.Sprintf("%dd ago", int(diff.Hours()/24))
	}
}

func compactInt(value int) string {
	switch {
	case value >= 1_000_000:
		return fmt.Sprintf("%.1fm", float64(value)/1_000_000)
	case value >= 1_000:
		return fmt.Sprintf("%.1fk", float64(value)/1_000)
	default:
		return fmt.Sprintf("%d", value)
	}
}

func formatPercent(value float64) string {
	if value == float64(int(value)) {
		return fmt.Sprintf("%.0f%%", value)
	}
	return fmt.Sprintf("%.1f%%", value)
}

func truncate(value string, width int) string {
	if width <= 3 || len(value) <= width {
		return value
	}
	return value[:width-3] + "..."
}

func renderLimitWindow(limit *monitor.LimitWindow) string {
	if limit == nil {
		return "-"
	}
	return formatPercent(limit.UsedPercent)
}

func renderUsageBar(limit *monitor.LimitWindow) string {
	if limit == nil {
		return "[----------]"
	}
	width := 10
	filled := int((limit.UsedPercent / 100) * float64(width))
	if filled < 0 {
		filled = 0
	}
	if filled > width {
		filled = width
	}
	bar := "[" + strings.Repeat("#", filled) + strings.Repeat(".", width-filled) + "]"
	return usageBarStyle(limit.UsedPercent).Render(bar)
}

func renderResetWindow(limit *monitor.LimitWindow) string {
	if limit == nil || limit.ResetsAt == nil {
		return "-"
	}
	diff := time.Until(*limit.ResetsAt)
	if diff <= 0 {
		return "resetting"
	}
	switch {
	case diff >= 24*time.Hour:
		return fmt.Sprintf("%dd %dh", int(diff.Hours()/24), int(diff.Hours())%24)
	case diff >= time.Hour:
		return fmt.Sprintf("%dh %dm", int(diff.Hours()), int(diff.Minutes())%60)
	default:
		return fmt.Sprintf("%dm", int(diff.Minutes()))
	}
}

func renderTopEventTypes(items []monitor.CountItem) string {
	if len(items) == 0 {
		return "-"
	}
	top := items[0]
	return fmt.Sprintf("%s:%d", top.Label, top.Value)
}

func summarizePayload(payload map[string]any) string {
	return summarizePayloadWithMode(payload, false)
}

func summarizePayloadWithMode(payload map[string]any, full bool) string {
	if len(payload) == 0 {
		return ""
	}
	keys := make([]string, 0, len(payload))
	for key := range payload {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	target := payload
	if !full {
		target = make(map[string]any, min(5, len(keys)))
		for _, key := range keys[:min(5, len(keys))] {
			target[key] = payload[key]
		}
	}
	bytes, err := json.MarshalIndent(target, "", "  ")
	if err != nil {
		return ""
	}
	return string(bytes)
}

func payloadModeLabel(full bool) string {
	if full {
		return "expanded"
	}
	return "summary"
}

func matchesPreset(event monitor.Event, preset string) bool {
	switch preset {
	case "":
		return true
	case "tool":
		return event.EventType == "tool_start" || event.EventType == "tool_complete"
	case "file":
		return event.FileEventType != "" || strings.HasPrefix(event.EventType, "file_")
	case "approval":
		return event.EventType == "approval_request" || event.EventType == "approval_result"
	case "error":
		return event.EventType == "error"
	case "token":
		return event.EventType == "token_usage"
	default:
		return true
	}
}

func usageBarStyle(percent float64) lipgloss.Style {
	color := lipgloss.Color("42")
	switch {
	case percent > 80:
		color = lipgloss.Color("203")
	case percent > 50:
		color = lipgloss.Color("214")
	}
	return lipgloss.NewStyle().Foreground(color).Bold(true)
}

func riskStyle(risk string) lipgloss.Style {
	color := lipgloss.Color("42")
	switch risk {
	case "high":
		color = lipgloss.Color("203")
	case "medium":
		color = lipgloss.Color("214")
	default:
		color = lipgloss.Color("42")
	}
	return lipgloss.NewStyle().Foreground(color).Bold(true)
}

func renderTimeWindow(window time.Duration) string {
	switch window {
	case 5 * time.Minute:
		return "5m"
	case 30 * time.Minute:
		return "30m"
	case 1 * time.Hour:
		return "1h"
	default:
		return window.String()
	}
}

func renderRefreshAge(last time.Time) string {
	if last.IsZero() {
		return "-"
	}
	return relativeTime(last)
}

func withinWindow(timestamp time.Time, window time.Duration) bool {
	if window <= 0 {
		return true
	}
	return time.Since(timestamp) <= window
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func clamp(value, minValue, maxValue int) int {
	if value < minValue {
		return minValue
	}
	if value > maxValue {
		return maxValue
	}
	return value
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
