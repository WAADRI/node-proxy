package wstransport

import (
	"bytes"
	"crypto/rand"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/WAADRI/node-proxy-go/internal/streammux"
)

// startWSPair upgrades one WebSocket connection and returns both Transports.
func startWSPair(t *testing.T) (client, server *Transport) {
	t.Helper()
	up := websocket.Upgrader{}
	ready := make(chan *Transport, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := up.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		ready <- Wrap(c)
		select {} // keep the handler parked until the test server shuts down
	}))
	t.Cleanup(srv.Close)

	wsURL := "ws" + srv.URL[len("http"):] + "/"
	c, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	select {
	case serverT := <-ready:
		return Wrap(c), serverT
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for upgrade")
		return nil, nil
	}
}

// TestWSLoopbackSession runs two full mux sessions over a real WebSocket
// pair: batching, flow control and ping all traverse actual WS framing.
func TestWSLoopbackSession(t *testing.T) {
	clientT, serverT := startWSPair(t)

	payload := make([]byte, 300*1024) // spans many frames + batches
	if _, err := rand.Read(payload); err != nil {
		t.Fatal(err)
	}

	var (
		mu       sync.Mutex
		received []byte
		maxChunk int
		ended    = make(chan struct{})
	)
	server := streammux.NewConn(serverT, streammux.Options{
		OnStream: func(s *streammux.Stream) {
			s.OnData(func(chunk []byte) {
				mu.Lock()
				received = append(received, chunk...)
				if len(chunk) > maxChunk {
					maxChunk = len(chunk)
				}
				mu.Unlock()
			})
			s.OnEnd(func() { close(ended) })
		},
	})
	client := streammux.NewConn(clientT, streammux.Options{})
	t.Cleanup(func() {
		client.Close()
		server.Close()
	})

	st := client.OpenTunnel("ws.loopback", 1, streammux.DefaultPriority)
	if st == nil {
		t.Fatal("OpenTunnel returned nil")
	}
	if !st.SendData(payload, true) {
		t.Fatal("SendData failed")
	}

	select {
	case <-ended:
	case <-time.After(15 * time.Second):
		t.Fatal("timed out waiting for stream end over WS")
	}
	mu.Lock()
	defer mu.Unlock()
	if !bytes.Equal(received, payload) {
		t.Fatalf("payload corrupted over WS: got %d bytes, want %d", len(received), len(payload))
	}
	if maxChunk > streammux.MaxFrameSize {
		t.Fatalf("chunk %d exceeds MaxFrameSize", maxChunk)
	}

	// Ping across the real socket too.
	rttCh := make(chan int64, 1)
	deadline := time.Now().Add(5 * time.Second)
	for len(rttCh) == 0 && time.Now().Before(deadline) {
		client.Ping(func(rtt int64) { rttCh <- rtt })
		time.Sleep(10 * time.Millisecond)
	}
	if len(rttCh) == 0 {
		t.Fatal("timed out waiting for PONG over WS")
	}
	if rtt := <-rttCh; rtt < 0 || rtt > 5000 {
		t.Fatalf("rtt %d ms out of range", rtt)
	}
}

// TestWSTextFrameIgnored verifies the legacy path: a WS text frame is not
// parsed as a mux message (session ignores it), and the session keeps
// working - the very next binary PING still gets a PONG.
func TestWSTextFrameIgnored(t *testing.T) {
	clientT, serverT := startWSPair(t)

	server := streammux.NewConn(serverT, streammux.Options{})
	t.Cleanup(server.Close)

	// Legacy text frame toward the session: ignored (TS replies PONG to
	// {type:"ping"} there; the Go session's policy is documented divergence).
	if err := clientT.WriteMessage([]byte(`{"type":"ping"}`)); err != nil {
		t.Fatalf("write text: %v", err)
	}
	time.Sleep(100 * time.Millisecond) // let it arrive

	// Binary PING built through the codec: session must still be alive.
	ping, _ := streammux.JSONFrame(streammux.TypePing, 0, 0, streammux.PingTime{Time: 12345})
	if err := clientT.WriteMessage(ping.MustEncode()); err != nil {
		t.Fatalf("write ping: %v", err)
	}
	clientT.conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, pong, err := clientT.conn.ReadMessage()
	if err != nil {
		t.Fatalf("read pong: %v", err)
	}
	frames, err := streammux.ParseMessage(pong)
	if err != nil || len(frames) != 1 || frames[0].Type != streammux.TypePong {
		t.Fatalf("expected single PONG frame, got %v (%v)", frames, err)
	}
}
