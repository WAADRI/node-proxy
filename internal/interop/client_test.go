package interop

import (
	"context"
	"encoding/base64"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/WAADRI/node-proxy-go/internal/client"
)

// TestLiveClientAgainstTSSim runs the Go client against a Node bridge that
// simulates the TS server. It verifies the JSON auth handshake (text frames),
// the info/heartbeat/stats reporting, tunnel dispatch (the client must dial a
// real TCP target and pipe both ways), and tunnel_error on refused targets.
//
// Topology: Go client <-> [byte relay] <- bridge(TS mux + server sim). The
// relay taps nothing; assertions come from bridge events and the echo server.
func TestLiveClientAgainstTSSim(t *testing.T) {
	node := findNode(t)
	repo := findTSRepo(t)

	// TCP echo server: the target the client will dial through the tunnel.
	echo := startEchoServer(t)
	echoPort := echo.Addr().(*net.TCPAddr).Port

	// WebSocket exchange: both peers dial in; the test relays bytes.
	up := websocket.Upgrader{}
	var (
		connMu  sync.Mutex
		pending []*websocket.Conn
		relayOn bool
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		connMu.Lock()
		pending = append(pending, c)
		if len(pending) == 2 && !relayOn {
			relayOn = true
			go pumpWS(pending[0], pending[1])
			go pumpWS(pending[1], pending[0])
		}
		connMu.Unlock()
	}))
	t.Cleanup(srv.Close)
	wsURL := "ws" + srv.URL[len("http"):] + "/"

	// Bridge dials first (peer #1), then arms the server sim.
	b := startBridge(t, node, repo, wsURL)
	b.waitEvent(t, "bridge ready", 10*time.Second, func(ev map[string]any) bool {
		return ev["event"] == "ready"
	})
	b.send(t, map[string]any{"op": "sim", "token": "test-token-123"})
	b.waitEvent(t, "sim armed", 5*time.Second, func(ev map[string]any) bool {
		return ev["event"] == "simArmed"
	})

	// Go client dials (peer #2); the relay starts once both are present.
	cfg := &client.Config{
		ServerURL:             wsURL,
		AuthToken:             "test-token-123",
		Region:                "test-region",
		Tags:                  "go,test",
		TLSRejectUnauthorized: true,
		ClientID:              "go-test-node-1",
		ReconnectDelay:        50 * time.Millisecond,
		MaxReconnectDelay:     100 * time.Millisecond,
		ReconnectJitter:       10 * time.Millisecond,
		HeartbeatInterval:     150 * time.Millisecond,
		TunnelTimeout:         2 * time.Second,
		RequestTimeout:        5 * time.Second,
		MaxConcurrentRequests: 100,
	}
	good := client.New(cfg, nil)
	goodStop := make(chan struct{})
	go func() {
		ctx, cancel := context.WithCancel(context.Background())
		go func() {
			<-goodStop
			cancel()
		}()
		_ = good.Run(ctx)
	}()
	t.Cleanup(func() { close(goodStop) })

	b.waitEvent(t, "auth accepted", 15*time.Second, func(ev map[string]any) bool {
		return ev["event"] == "authed"
	})

	// Identity report.
	infoEv := b.waitEvent(t, "info report", 10*time.Second, func(ev map[string]any) bool {
		return ev["event"] == "info"
	})
	info, _ := infoEv["info"].(map[string]any)
	if info == nil || info["clientId"] != "go-test-node-1" || info["supportsMux"] != true || info["region"] != "test-region" {
		t.Fatalf("info = %v, want clientId/supportsMux/region", info)
	}

	// Heartbeat + stats flow.
	b.waitEvent(t, "heartbeat", 10*time.Second, func(ev map[string]any) bool {
		return ev["event"] == "heartbeat"
	})
	statsEv := b.waitEvent(t, "stats", 10*time.Second, func(ev map[string]any) bool {
		return ev["event"] == "stats"
	})
	if stats, _ := statsEv["stats"].(map[string]any); stats == nil || stats["maxConcurrentRequests"] != float64(100) {
		t.Fatalf("stats = %v, want maxConcurrentRequests=100", statsEv["stats"])
	}

	// Tunnel: the sim asks the node to reach the echo server; the client
	// must dial it and pipe both ways.
	b.send(t, map[string]any{"op": "openTunnelTo", "host": "127.0.0.1", "port": echoPort})
	openEv := b.waitEvent(t, "tunnel opened", 10*time.Second, func(ev map[string]any) bool {
		return ev["event"] == "opened"
	})
	tunnelID := idOf(openEv)

	b.waitEvent(t, "tunnel_ready from client", 10*time.Second, func(ev map[string]any) bool {
		if ev["event"] != "stream" || idOf(ev) != tunnelID {
			return false
		}
		h, _ := ev["headers"].(map[string]any)
		return h != nil && h["type"] == "tunnel_ready"
	})

	// Round-trip through the client into the echo server and back.
	payload := "hello-through-go-node"
	b.send(t, map[string]any{"op": "sendData", "id": tunnelID,
		"dataB64": base64.StdEncoding.EncodeToString([]byte(payload))})
	waitFor(t, "echo round-trip via client", func() bool { return bridgeSawData(t, b, tunnelID, payload) })

	// Clean tunnel close from the sim side.
	b.send(t, map[string]any{"op": "closeTunnel", "id": tunnelID, "reason": 0})

	// Refused target: the client must answer tunnel_error (connect refused).
	b.send(t, map[string]any{"op": "openTunnelTo", "host": "127.0.0.1", "port": 1})
	badOpen := b.waitEvent(t, "bad tunnel opened", 10*time.Second, func(ev map[string]any) bool {
		return ev["event"] == "opened"
	})
	badID := idOf(badOpen)
	b.waitEvent(t, "tunnel_error from client", 10*time.Second, func(ev map[string]any) bool {
		if ev["event"] != "stream" || idOf(ev) != badID {
			return false
		}
		h, _ := ev["headers"].(map[string]any)
		return h != nil && h["type"] == "tunnel_error"
	})

	// --- HTTP request dispatch: the sim sends a mux request; the Go client
	// executes it against a real HTTP target and answers with a response.
	httpTarget := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-trace") != "live" {
			w.WriteHeader(400)
			return
		}
		w.Header().Set("content-type", "text/plain")
		w.WriteHeader(200)
		_, _ = w.Write([]byte("live-ok"))
	}))
	t.Cleanup(httpTarget.Close)

	b.send(t, map[string]any{"op": "openRequest", "id": "live-1", "method": "GET",
		"url": httpTarget.URL + "/probe", "headers": map[string]any{"x-trace": "live"}})
	reqOpen := b.waitEvent(t, "request stream opened", 10*time.Second, func(ev map[string]any) bool {
		return ev["event"] == "opened"
	})
	reqID := idOf(reqOpen)
	b.waitEvent(t, "response headers from client", 15*time.Second, func(ev map[string]any) bool {
		if ev["event"] != "stream" || idOf(ev) != reqID {
			return false
		}
		h, _ := ev["headers"].(map[string]any)
		return h != nil && h["type"] == "response" && h["statusCode"] == float64(200)
	})
	waitFor(t, "response body at sim", func() bool {
		return bridgeSawData(t, b, reqID, "live-ok")
	})
}

// bridgeSawData scans (and consumes) bridge data events for an exact payload.
func bridgeSawData(t *testing.T, b *bridge, streamID uint32, want string) bool {
	t.Helper()
	b.mu.Lock()
	defer b.mu.Unlock()
	kept := b.events[:0]
	found := false
	for _, ev := range b.events {
		if !found && ev["event"] == "data" && idOf(ev) == streamID {
			if raw, ok := ev["dataB64"].(string); ok {
				if dec, err := base64.StdEncoding.DecodeString(raw); err == nil && string(dec) == want {
					found = true
					continue
				}
			}
		}
		kept = append(kept, ev)
	}
	b.events = kept
	return found
}

// pumpWS relays WebSocket messages 1:1 between two peers, preserving type.
func pumpWS(from, to *websocket.Conn) {
	for {
		mt, data, err := from.ReadMessage()
		if err != nil {
			return
		}
		if err := to.WriteMessage(mt, data); err != nil {
			return
		}
	}
}

// startEchoServer listens on a random port and echoes everything back.
func startEchoServer(t *testing.T) *net.TCPListener {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		for {
			conn, err := l.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				buf := make([]byte, 16*1024)
				for {
					n, rerr := c.Read(buf)
					if n > 0 {
						if _, werr := c.Write(buf[:n]); werr != nil {
							return
						}
					}
					if rerr != nil {
						return
					}
				}
			}(conn)
		}
	}()
	t.Cleanup(func() { l.Close() })
	return l.(*net.TCPListener)
}
