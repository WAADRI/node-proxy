package server

import (
	"encoding/json"
	"fmt"
	"sync"
	"time"
)

// NetTestTask tracks one network-test run (TS NetworkTestManager): dispatched
// to online nodes, results collected per (clientId, target). Server-local
// execution was removed by decision (2026-11-07) - tests always run on nodes;
// omitting the clients selection means "all online nodes".
type NetTestTask struct {
	ID        string            `json:"id"`
	Type      string            `json:"type"`
	Targets   []string          `json:"targets"`
	Mode      string            `json:"mode"` // nodes
	Clients   []string          `json:"clients"`
	Expect    int               `json:"expect"`
	State     string            `json:"state"` // queued | running | done
	CreatedAt int64             `json:"createdAt"`
	Results   []NetTestReport   `json:"results"`
	Error     string            `json:"error,omitempty"`
	Labels    map[string]string `json:"clientLabels,omitempty"`

	doneSeen map[string]bool
}

// NetTestReport is one (node, target) result.
type NetTestReport struct {
	ClientID string         `json:"clientId"`
	Index    int            `json:"index"`
	Target   string         `json:"target"`
	Result   map[string]any `json:"result"`
}

// NetTestManager owns the task table.
type NetTestManager struct {
	mu    sync.Mutex
	tasks map[string]*NetTestTask
	srv   *Server
}

func NewNetTestManager(srv *Server) *NetTestManager {
	return &NetTestManager{srv: srv, tasks: map[string]*NetTestTask{}}
}

var netTestTypes = []string{"ping", "tcping", "http", "dns", "traceroute"}

const netTestMaxTargets = 20

// Start validates and creates a task, dispatching to the requested nodes
// (clients nil or "all" = every online node; a list = those nodes).
func (m *NetTestManager) Start(testType string, targets []string, options map[string]any, clients any) (string, error) {
	valid := false
	for _, t := range netTestTypes {
		if t == testType {
			valid = true
			break
		}
	}
	if !valid {
		return "", fmt.Errorf("Unknown test type: %s", testType)
	}
	list := []string{}
	for _, t := range targets {
		t = trimSpace(t)
		if t != "" {
			list = append(list, t)
		}
	}
	if len(list) == 0 {
		return "", fmt.Errorf("No targets provided")
	}
	if len(list) > netTestMaxTargets {
		return "", fmt.Errorf("Too many targets (max %d)", netTestMaxTargets)
	}

	var clientIDs []string
	switch c := clients.(type) {
	case string:
		if c == "all" {
			for _, node := range m.srv.Mgr.All() {
				clientIDs = append(clientIDs, node.ID)
			}
		} else if c != "" {
			clientIDs = []string{c}
		}
	case []any:
		for _, item := range c {
			if s, ok := item.(string); ok && s != "" {
				clientIDs = append(clientIDs, s)
			}
		}
	case nil:
		// omitted -> all online nodes
	default:
		return "", fmt.Errorf("invalid clients value")
	}
	if len(clientIDs) == 0 {
		for _, node := range m.srv.Mgr.All() {
			clientIDs = append(clientIDs, node.ID)
		}
		if len(clientIDs) == 0 {
			return "", fmt.Errorf("没有可用的在线节点")
		}
	}
	mode := "nodes"

	task := &NetTestTask{
		ID: newID()[:12], Type: testType, Targets: list,
		Mode: mode, Clients: clientIDs, State: "queued",
		CreatedAt: time.Now().UnixMilli(), Results: []NetTestReport{},
		Labels: map[string]string{}, doneSeen: map[string]bool{},
	}
	task.Expect = len(clientIDs) * len(list)
	for _, cid := range clientIDs {
		task.Labels[cid] = cid
	}

	m.mu.Lock()
	m.tasks[task.ID] = task
	m.mu.Unlock()

	payload, _ := json.Marshal(map[string]any{
		"type":    "net_test",
		"taskId":  task.ID,
		"payload": map[string]any{"type": testType, "targets": list, "options": options},
	})
	sent := 0
	for _, cid := range clientIDs {
		if node := m.srv.Mgr.Get(cid); node != nil && node.WS != nil && node.WS.sendText(payload) {
			sent++
		}
	}
	if sent == 0 {
		m.mu.Lock()
		task.State = "done"
		task.Error = "no target node accepted the task"
		m.mu.Unlock()
		return task.ID, nil
	}
	task.State = "running"
	return task.ID, nil
}

// HandleProgress folds a node report into the task.
func (m *NetTestManager) HandleProgress(taskID, clientID string, index int, target string, result map[string]any) {
	m.mu.Lock()
	defer m.mu.Unlock()
	task := m.tasks[taskID]
	if task == nil {
		return
	}
	task.State = "running"
	task.Results = append(task.Results, NetTestReport{
		ClientID: clientID, Index: index, Target: target, Result: result,
	})
}

// HandleDone marks a node's completion; the task completes when every
// (node, target) reported or every node reported done.
func (m *NetTestManager) HandleDone(taskID, clientID, errMsg string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	task := m.tasks[taskID]
	if task == nil {
		return
	}
	task.doneSeen[clientID] = true
	if errMsg != "" && task.Error == "" {
		task.Error = clientID + ": " + errMsg
	}
	if len(task.Results) >= task.Expect || len(task.doneSeen) >= len(task.Clients) {
		task.State = "done"
	}
}

// Get returns a task snapshot.
func (m *NetTestManager) Get(id string) *NetTestTask {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.tasks[id]
}
