// Package interop holds the live compatibility tests between the Go
// StreamMux session and the real TypeScript StreamMux from a node-proxy
// checkout. The test spawns tools/interop/bridge.mjs under Node and drives
// both muxes over an actual WebSocket.
//
// The tests skip (not fail) when Node or the checkout is unavailable, so the
// suite stays green on machines without the TS repo. Point
// NODE_PROXY_TS_REPO at a checkout to enable them.
package interop

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/WAADRI/node-proxy-go/internal/streammux"
	"github.com/WAADRI/node-proxy-go/internal/wstransport"
)

const defaultTSRepo = `C:\Users\Administrator\Downloads\tmp-ref\node-proxy`

func findTSRepo(t *testing.T) string {
	t.Helper()
	repo := os.Getenv("NODE_PROXY_TS_REPO")
	if repo == "" {
		repo = defaultTSRepo
	}
	if _, err := os.Stat(filepath.Join(repo, "server", "lib", "stream-mux.ts")); err != nil {
		t.Skipf("TS checkout not found at %s (set NODE_PROXY_TS_REPO); skipping live interop", repo)
	}
	return repo
}

func findNode(t *testing.T) string {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not on PATH; skipping live interop")
	}
	return node
}

// bridge is one spawned bridge.mjs process with its JSON-lines control plane.
type bridge struct {
	in io.WriteCloser

	mu     sync.Mutex
	events []map[string]any
	notify chan struct{}
}

func startBridge(t *testing.T, node, repo, wsURL string) *bridge {
	t.Helper()
	_, thisFile, _, _ := runtime.Caller(0)
	script := filepath.Join(filepath.Dir(thisFile), "..", "..", "tools", "interop", "bridge.mjs")
	cmd := exec.Command(node, script, repo)
	cmd.Env = append(os.Environ(), "WS_URL="+wsURL)
	cmd.Stderr = os.Stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}

	b := &bridge{in: stdin, notify: make(chan struct{}, 4096)}
	done := make(chan struct{})
	go func() {
		defer close(done)
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 1024*1024), 16*1024*1024)
		for sc.Scan() {
			var ev map[string]any
			if json.Unmarshal(sc.Bytes(), &ev) != nil {
				continue
			}
			b.mu.Lock()
			b.events = append(b.events, ev)
			b.mu.Unlock()
			select {
			case b.notify <- struct{}{}:
			default:
			}
		}
	}()
	if err := cmd.Start(); err != nil {
		t.Fatalf("start bridge: %v", err)
	}
	t.Cleanup(func() {
		_ = b.in.Close()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			_ = cmd.Process.Kill()
		}
	})
	return b
}

// waitEvent returns the first event matching pred, consuming it.
func (b *bridge) waitEvent(t *testing.T, what string, timeout time.Duration, pred func(ev map[string]any) bool) map[string]any {
	t.Helper()
	deadline := time.After(timeout)
	for {
		b.mu.Lock()
		for i, ev := range b.events {
			if pred(ev) {
				b.events = append(b.events[:i], b.events[i+1:]...)
				b.mu.Unlock()
				return ev
			}
		}
		b.mu.Unlock()
		select {
		case <-b.notify:
		case <-deadline:
			t.Fatalf("timed out waiting for %s", what)
		}
	}
}

func (b *bridge) send(t *testing.T, cmd map[string]any) {
	t.Helper()
	line, _ := json.Marshal(cmd)
	if _, err := b.in.Write(append(line, '\n')); err != nil {
		t.Fatalf("bridge stdin: %v", err)
	}
}

// dataBytes sums received "data" events for a stream, consuming them.
func (b *bridge) dataBytes(streamID uint32) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	total := 0
	kept := b.events[:0]
	for _, ev := range b.events {
		if ev["event"] == "data" && idOf(ev) == streamID {
			if raw, ok := ev["dataB64"].(string); ok {
				if dec, err := base64.StdEncoding.DecodeString(raw); err == nil {
					total += len(dec)
					continue // consumed
				}
			}
		}
		kept = append(kept, ev)
	}
	b.events = kept
	return total
}

func idOf(ev map[string]any) uint32 {
	if f, ok := ev["id"].(float64); ok {
		return uint32(f)
	}
	return 0
}

// ---------------------------------------------------------------------------
// The live test
// ---------------------------------------------------------------------------

func TestLiveInteropWithTS(t *testing.T) {
	node := findNode(t)
	repo := findTSRepo(t)

	var (
		acceptedMu      sync.Mutex
		acceptedStreams = map[uint32]*streammux.Stream{}
		endedMu         sync.Mutex
		remoteEnded     = map[uint32]bool{}
	)

	// WebSocket endpoint; the Go session lives on the server side.
	up := websocket.Upgrader{}
	serverCh := make(chan *streammux.Conn, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		conn := streammux.NewConn(wstransport.Wrap(c), streammux.Options{
			OnStream: func(s *streammux.Stream) {
				acceptedMu.Lock()
				acceptedStreams[s.ID()] = s
				acceptedMu.Unlock()
				s.OnData(func([]byte) {}) // drain; delivery checked via stream stats
				s.OnEnd(func() {
					endedMu.Lock()
					remoteEnded[s.ID()] = true
					endedMu.Unlock()
				})
			},
		})
		serverCh <- conn
		select {} // park; conn owns the socket from here
	}))
	t.Cleanup(srv.Close)

	wsURL := "ws" + srv.URL[len("http"):] + "/"
	b := startBridge(t, node, repo, wsURL)
	b.waitEvent(t, "bridge ready", 10*time.Second, func(ev map[string]any) bool {
		return ev["event"] == "ready"
	})
	goConn := <-serverCh

	// --- Scenario A: Go opens a tunnel; TS echoes data; Go closes. ---------
	st := goConn.OpenTunnel("interop.test", 1234, streammux.DefaultPriority)
	if st == nil {
		t.Fatal("OpenTunnel returned nil")
	}
	streamEv := b.waitEvent(t, "TS sees TUNNEL_OPEN", 10*time.Second, func(ev map[string]any) bool {
		return ev["event"] == "stream"
	})
	hdr, _ := streamEv["headers"].(map[string]any)
	if hdr == nil || hdr["host"] != "interop.test" || hdr["port"] != float64(1234) {
		t.Fatalf("TS tunnel headers = %v, want {host:interop.test port:1234}", streamEv["headers"])
	}
	tsID := idOf(streamEv)

	// TS -> Go: 20 KiB.
	c1 := bytes.Repeat([]byte{0xA1}, 10*1024)
	c2 := bytes.Repeat([]byte{0xB2}, 10*1024)
	b.send(t, map[string]any{"op": "sendData", "id": tsID, "dataB64": base64.StdEncoding.EncodeToString(c1)})
	b.send(t, map[string]any{"op": "sendData", "id": tsID, "dataB64": base64.StdEncoding.EncodeToString(c2)})
	waitFor(t, "TS data counted at Go", func() bool {
		// The accepted-side drain handler counts via Stats on the Go stream.
		return goStreamBytes(t, goConn, st.ID()) >= len(c1)+len(c2)
	})

	// Go -> TS: 48 KiB (multi-frame batch on the wire).
	goPayload := bytes.Repeat([]byte{0xC3}, 48*1024)
	if !st.SendData(goPayload, false) {
		t.Fatal("Go SendData failed")
	}
	waitFor(t, "bridge received Go data", func() bool { return b.dataBytes(tsID) >= len(goPayload) })

	// Graceful close from Go: TS must see END_STREAM.
	goConn.CloseTunnel(st.ID(), 0)
	b.waitEvent(t, "TS sees stream end", 10*time.Second, func(ev map[string]any) bool {
		return ev["event"] == "end" && idOf(ev) == tsID
	})

	// --- Scenario B: TS opens a tunnel; Go accepts and serves it. ----------
	b.send(t, map[string]any{"op": "openTunnel", "host": "ts.open.test", "port": 80})
	openedEv := b.waitEvent(t, "bridge opened", 10*time.Second, func(ev map[string]any) bool {
		return ev["event"] == "opened"
	})
	tsOpenID := idOf(openedEv)

	var goPeer *streammux.Stream
	waitFor(t, "Go accepted TS TUNNEL_OPEN", func() bool {
		goPeer = findAccepted(t, &acceptedMu, &acceptedStreams, "ts.open.test", 80)
		return goPeer != nil
	})

	// Go -> TS on the accepted stream: 60 KiB through TS receive windows.
	goBack := bytes.Repeat([]byte{0xD4}, 60*1024)
	if !goPeer.SendData(goBack, false) {
		t.Fatal("Go SendData on accepted stream failed")
	}
	waitFor(t, "bridge received accepted-stream data", func() bool {
		return b.dataBytes(tsOpenID) >= len(goBack)
	})

	// TS closes its own tunnel; Go must half-close via END_STREAM.
	b.send(t, map[string]any{"op": "closeTunnel", "id": tsOpenID, "reason": 0})
	waitFor(t, "Go stream half-closed from TS close", func() bool {
		endedMu.Lock()
		defer endedMu.Unlock()
		return remoteEnded[tsOpenID]
	})

	// --- Scenario C: ping/pong both directions. ---------------------------
	rttCh := make(chan int64, 1)
	deadline := time.Now().Add(5 * time.Second)
	for len(rttCh) == 0 && time.Now().Before(deadline) {
		goConn.Ping(func(rtt int64) { rttCh <- rtt })
		time.Sleep(10 * time.Millisecond)
	}
	if len(rttCh) == 0 {
		t.Fatal("no RTT from TS PONG")
	}
	b.send(t, map[string]any{"op": "ping"})
	b.waitEvent(t, "bridge RTT (Go PONG)", 10*time.Second, func(ev map[string]any) bool {
		v, ok := ev["ms"].(float64)
		return ev["event"] == "rtt" && ok && v >= 0
	})

	// --- Scenario D: GOAWAY from Go reaches TS. ---------------------------
	goConn.Goaway(7)
	b.waitEvent(t, "TS sees GOAWAY", 10*time.Second, func(ev map[string]any) bool {
		return ev["event"] == "goaway" && ev["lastStreamId"] == float64(7)
	})
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func findAccepted(t *testing.T, mu *sync.Mutex, m *map[uint32]*streammux.Stream, host string, port int) *streammux.Stream {
	t.Helper()
	mu.Lock()
	defer mu.Unlock()
	for _, s := range *m {
		if open, ok := s.Headers().(streammux.TunnelOpen); ok && open.Host == host && open.Port == port {
			return s
		}
	}
	return nil
}

// goStreamBytes reports total DATA bytes received on a Go-side stream via
// its stats.
func goStreamBytes(t *testing.T, conn *streammux.Conn, id uint32) int {
	t.Helper()
	for _, s := range conn.Stats().Streams {
		if s.ID == id {
			return s.TotalBytesReceived
		}
	}
	return 0
}
