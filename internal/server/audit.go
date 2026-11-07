package server

import (
	"encoding/json"
	"os"
	"strings"
	"sync"
)

// AuditLog records proxy request summaries for the panel (TS audit.ts).
// In-memory ring for queries plus JSONL persistence: every record appends to
// the file, and the tail is reloaded on boot so query() survives restarts
// (the TS module rotates files; a single size-capped file covers the same
// need here - extend to rotation if it ever matters).
type AuditLog struct {
	mu      sync.Mutex
	entries []AuditEntry
	cap     int
	total   int64
	path    string
}

// AuditEntry mirrors the TS RequestLogData record.
type AuditEntry struct {
	Time       int64  `json:"time"`
	Method     string `json:"method"`
	URL        string `json:"url"`
	Host       string `json:"host"`
	Protocol   string `json:"protocol"`
	ClientID   string `json:"clientId"`
	ClientTags string `json:"clientTags,omitempty"`
	RequestID  string `json:"requestId,omitempty"`
	Status     string `json:"status"` // success | error
	StatusCode int    `json:"statusCode"`
	Duration   int64  `json:"duration"`
	Bytes      int    `json:"bytes,omitempty"`
	Error      string `json:"error,omitempty"`
}

func NewAuditLog(capacity int) *AuditLog {
	if capacity <= 0 {
		capacity = 5000
	}
	return &AuditLog{cap: capacity}
}

// Log appends one record (and persists it).
func (a *AuditLog) Log(e AuditEntry) {
	a.mu.Lock()
	a.total++
	if len(a.entries) >= a.cap {
		a.entries = a.entries[1:]
	}
	a.entries = append(a.entries, e)
	path := a.path
	a.mu.Unlock()
	if path != "" {
		if data, err := json.Marshal(e); err == nil {
			appendLine(path, data)
		}
	}
}

// appendLine appends one JSON line, creating the file as needed.
func appendLine(path string, data []byte) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.Write(append(data, '\n'))
}

// LoadFromFile replays the persisted tail into the ring (called on boot).
func (a *AuditLog) LoadFromFile(path string) {
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	loaded := 0
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var e AuditEntry
		if json.Unmarshal([]byte(line), &e) != nil {
			continue
		}
		a.mu.Lock()
		if len(a.entries) >= a.cap {
			a.entries = a.entries[1:]
		}
		a.entries = append(a.entries, e)
		a.mu.Unlock()
		loaded++
	}
	a.mu.Lock()
	a.path = path
	a.mu.Unlock()
	_ = loaded
}

// SetPersistPath enables persistence for future records.
func (a *AuditLog) SetPersistPath(path string) {
	a.mu.Lock()
	a.path = path
	a.mu.Unlock()
}

// Query filters by optional status/clientId and limits (TS query subset).
func (a *AuditLog) Query(status, clientID string, limit int) []AuditEntry {
	a.mu.Lock()
	defer a.mu.Unlock()
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	out := make([]AuditEntry, 0, limit)
	for i := len(a.entries) - 1; i >= 0 && len(out) < limit; i-- {
		e := a.entries[i]
		if status != "" && e.Status != status {
			continue
		}
		if clientID != "" && e.ClientID != clientID {
			continue
		}
		out = append(out, e)
	}
	return out
}

// Stats aggregates the ring.
func (a *AuditLog) Stats() map[string]any {
	a.mu.Lock()
	defer a.mu.Unlock()
	byStatus := map[string]int{}
	var durationSum int64
	window := len(a.entries)
	for _, e := range a.entries {
		byStatus[e.Status]++
		durationSum += e.Duration
	}
	avg := int64(0)
	if window > 0 {
		avg = durationSum / int64(window)
	}
	return map[string]any{
		"total":          a.total,
		"inWindow":       window,
		"byStatus":       byStatus,
		"avgDurationMS":  avg,
		"windowDuration": "in-memory ring",
	}
}
