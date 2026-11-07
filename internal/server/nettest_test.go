package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/WAADRI/node-proxy-go/internal/client"
)

// TestNetTestEndToEnd drives a full network test: the API dispatches a task
// to an in-process Go client node, which probes a local HTTP target; the
// results come back through the JSON control plane.
func TestNetTestEndToEnd(t *testing.T) {
	srv, api, _ := newTestServer(t)
	srv.Cfg.AuthToken = "nettest-token"

	// Real HTTP target the node will probe.
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/plain")
		_, _ = w.Write([]byte("nettest-ok"))
	}))
	defer target.Close()

	// In-process client node.
	clientBase := httptest.NewServer(srv.muxForWS())
	defer clientBase.Close()
	clientURL := "ws" + strings.TrimPrefix(clientBase.URL, "http") + "/ws"
	cfg := &client.Config{
		ServerURL: clientURL, AuthToken: "nettest-token", ClientID: "probe-node",
		TLSRejectUnauthorized: true,
		ReconnectDelay:        50 * time.Millisecond, MaxReconnectDelay: 100 * time.Millisecond,
		ReconnectJitter: 10 * time.Millisecond, HeartbeatInterval: 0,
		TunnelTimeout: 2 * time.Second, RequestTimeout: 5 * time.Second,
		MaxConcurrentRequests: 100,
	}
	node := client.New(cfg, nil)
	stop := make(chan struct{})
	ctx, cancel := contextWithCancel(stop)
	go func() { _ = node.Run(ctx) }()
	t.Cleanup(func() { close(stop); cancel() })

	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) && len(srv.Mgr.All()) == 0 {
		time.Sleep(10 * time.Millisecond)
	}
	if len(srv.Mgr.All()) == 0 {
		t.Fatal("probe node never registered")
	}

	token := login(t, api.URL)

	// Types list matches the TS panel.
	code, out := apiCall(t, api.URL, token, "GET", "/api/network-test/types", "")
	if code != 200 || len(out["types"].([]any)) != 5 {
		t.Fatalf("types = %v", out)
	}

	// Validation: unknown type and empty targets -> 400.
	code, _ = apiCall(t, api.URL, token, "POST", "/api/network-test",
		`{"type":"bogus","targets":["x"]}`)
	if code != 400 {
		t.Fatalf("bogus type = %d, want 400", code)
	}
	code, _ = apiCall(t, api.URL, token, "POST", "/api/network-test",
		`{"type":"http","targets":[]}`)
	if code != 400 {
		t.Fatalf("empty targets = %d, want 400", code)
	}

	// Dispatch to the node.
	code, out = apiCall(t, api.URL, token, "POST", "/api/network-test",
		`{"type":"http","targets":["`+target.URL+`"],"clients":["probe-node"]}`)
	if code != 200 {
		t.Fatalf("start = %d: %v", code, out)
	}
	taskID, _ := out["taskId"].(string)
	if taskID == "" {
		t.Fatal("no taskId")
	}

	// Poll until done.
	deadline = time.Now().Add(15 * time.Second)
	var task map[string]any
	for time.Now().Before(deadline) {
		code, out = apiCall(t, api.URL, token, "GET", "/api/network-test/"+taskID, "")
		if code != 200 {
			t.Fatalf("get task = %d", code)
		}
		task = out["task"].(map[string]any)
		if task["state"] == "done" {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if task["state"] != "done" {
		t.Fatalf("task never completed: %v", task)
	}
	results := task["results"].([]any)
	if len(results) != 1 {
		t.Fatalf("results = %d, want 1", len(results))
	}
	r := results[0].(map[string]any)
	if r["clientId"] != "probe-node" || r["target"] != target.URL {
		t.Fatalf("report identity wrong: %v", r)
	}
	result := r["result"].(map[string]any)
	if result["ok"] != true || result["status"] != float64(200) {
		t.Fatalf("probe result wrong: %v", result)
	}
}

// TestAuditPersistence verifies records survive a restart via the JSONL file.
func TestAuditPersistence(t *testing.T) {
	dir := t.TempDir()
	auditPath := filepath.Join(dir, "runtime-audit.jsonl")

	boot := func() *AuditLog {
		a := NewAuditLog(100)
		a.LoadFromFile(auditPath)
		a.SetPersistPath(auditPath)
		return a
	}

	a1 := boot()
	a1.Log(AuditEntry{Time: 1, Method: "GET", URL: "http://x/1", ClientID: "n", Status: "success", StatusCode: 200})
	a1.Log(AuditEntry{Time: 2, Method: "GET", URL: "http://x/2", ClientID: "n", Status: "error", StatusCode: 502, Error: "boom"})

	a2 := boot()
	got := a2.Query("", "", 10)
	if len(got) != 2 {
		t.Fatalf("reloaded %d entries, want 2", len(got))
	}
	if got[0].URL != "http://x/2" || got[0].Error != "boom" {
		t.Fatalf("newest entry wrong: %+v", got[0])
	}

	if _, err := os.Stat(auditPath); err != nil {
		t.Fatal("audit file not created")
	}
}
