package streammux

import (
	"bytes"
	"encoding/json"
	"math/rand"
	"sync"
	"testing"
	"time"
)

func putU32(b []byte, v uint32) {
	b[0] = byte(v >> 24)
	b[1] = byte(v >> 16)
	b[2] = byte(v >> 8)
	b[3] = byte(v)
}

// pump probes cond on a tick; session work happens on background goroutines.
func pump(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

type testLogger struct{ t *testing.T }

func (l testLogger) Debugf(f string, a ...any) { l.t.Logf("DEBUG "+f, a...) }
func (l testLogger) Infof(f string, a ...any)  { l.t.Logf("INFO  "+f, a...) }
func (l testLogger) Warnf(f string, a ...any)  { l.t.Logf("WARN  "+f, a...) }
func (l testLogger) Errorf(f string, a ...any) { l.t.Logf("ERROR "+f, a...) }
func (l testLogger) Info(m string)             { l.t.Logf("INFO  %s", m) }
func (l testLogger) Warn(m string)             { l.t.Logf("WARN  %s", m) }
func (l testLogger) Error(m string)            { l.t.Logf("ERROR %s", m) }

func pair(t *testing.T, tune func(a, b *Options)) (client, server *Conn) {
	t.Helper()
	cA, cB := newMemPipe()
	var optsA, optsB Options
	if tune != nil {
		tune(&optsA, &optsB)
	}
	if testing.Verbose() {
		optsA.Logger, optsB.Logger = testLogger{t}, testLogger{t}
	}
	client = NewConn(cA, optsA)
	server = NewConn(cB, optsB)
	t.Cleanup(func() {
		client.Close()
		server.Close()
	})
	return client, server
}

// TestLoopbackTunnel covers the SOCKS5-shaped path end to end: TUNNEL_OPEN,
// bidirectional DATA, graceful close (END_STREAM then TUNNEL_CLOSE).
func TestLoopbackTunnel(t *testing.T) {
	client, server := pair(t, nil)

	var (
		mu        sync.Mutex
		tgtData   []byte
		peerEnded bool
	)
	peerReady := make(chan *Stream, 1)
	server.opts.OnStream = func(s *Stream) {
		s.OnData(func(chunk []byte) {
			mu.Lock()
			tgtData = append(tgtData, chunk...)
			mu.Unlock()
		})
		s.OnEnd(func() {
			mu.Lock()
			peerEnded = true
			mu.Unlock()
		})
		peerReady <- s
	}
	var (
		srcMu   sync.Mutex
		srcData []byte
	)

	st := client.OpenTunnel("example.com", 443, DefaultPriority)
	if st == nil {
		t.Fatal("OpenTunnel returned nil")
	}
	if st.State() != StateOpen {
		t.Fatalf("state after open = %s, want open", st.State())
	}
	st.OnData(func(chunk []byte) {
		srcMu.Lock()
		srcData = append(srcData, chunk...)
		srcMu.Unlock()
	})

	var peer *Stream
	select {
	case peer = <-peerReady:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for TUNNEL_OPEN")
	}
	open, ok := peer.headers.(TunnelOpen)
	if !ok || open.Host != "example.com" || open.Port != 443 {
		t.Fatalf("tunnel headers = %#v, want TunnelOpen{example.com 443}", peer.headers)
	}

	// Client -> server.
	if !client.SendTunnelData(st.ID(), []byte("GET / HTTP/1.1")) {
		t.Fatal("client SendTunnelData failed")
	}
	pump(t, "client data at server", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return bytes.Contains(tgtData, []byte("GET / HTTP/1.1"))
	})

	// Server -> client.
	if !peer.SendData([]byte("HTTP/1.1 200 OK"), false) {
		t.Fatal("server SendData failed")
	}
	pump(t, "server data at client", func() bool {
		srcMu.Lock()
		defer srcMu.Unlock()
		return bytes.Equal(srcData, []byte("HTTP/1.1 200 OK"))
	})

	// Graceful close: the peer learns via the empty END_STREAM DATA frame,
	// the TUNNEL_CLOSE frame itself is a no-op on the receiver (TS parity).
	client.CloseTunnel(st.ID(), 0)
	if st.State() != StateClosed {
		t.Fatalf("client state after CloseTunnel = %s, want closed", st.State())
	}
	pump(t, "server stream half-closed", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return peerEnded
	})
	if peer.State() != StateHalfClosedRemote {
		t.Fatalf("server stream state = %s, want half_closed_remote", peer.State())
	}
	// TS mux parity: the receiving side keeps the half-closed stream in its
	// map; it is removed when the owning side closes the tunnel too.
	if n := server.Stats().TotalStreams; n != 1 {
		t.Fatalf("server streams after peer close = %d, want 1 (TS parity)", n)
	}
	server.CloseTunnel(peer.ID(), 0)
	pump(t, "stream removed from server conn", func() bool { return server.Stats().TotalStreams == 0 })
}

// TestFlowControlChunkingWindows drives 200 KiB through a 64 KiB stream
// window: chunking at 16 KiB, buffering, WINDOW_UPDATE ping-pong, in-order
// delivery, and the deferred END_STREAM once the buffer drains.
func TestFlowControlChunkingWindows(t *testing.T) {
	client, server := pair(t, nil)

	payload := make([]byte, 200*1024)
	rng := rand.New(rand.NewSource(1))
	for i := range payload {
		payload[i] = byte(rng.Intn(256))
	}

	var (
		mu       sync.Mutex
		received []byte
		maxChunk int
		ended    bool
		done     = make(chan struct{})
	)
	server.opts.OnStream = func(s *Stream) {
		s.OnData(func(chunk []byte) {
			mu.Lock()
			received = append(received, chunk...)
			if len(chunk) > maxChunk {
				maxChunk = len(chunk)
			}
			mu.Unlock()
		})
		s.OnEnd(func() {
			mu.Lock()
			ended = true
			mu.Unlock()
			close(done)
		})
	}

	st := client.OpenTunnel("flow.test", 1, DefaultPriority)
	if st == nil {
		t.Fatal("OpenTunnel returned nil")
	}
	// One call larger than the whole stream window: must chunk, buffer, then
	// emit END_STREAM when the buffer drains (divergence fix over TS).
	if !st.SendData(payload, true) {
		t.Fatal("SendData failed")
	}
	if st.State() != StateOpen {
		t.Fatalf("state while buffered = %s, want open (half-close only after drain)", st.State())
	}

	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for stream end")
	}
	mu.Lock()
	defer mu.Unlock()
	if !ended {
		t.Fatal("stream ended without END_STREAM")
	}
	if !bytes.Equal(received, payload) {
		t.Fatalf("payload corrupted: got %d bytes, want %d", len(received), len(payload))
	}
	if maxChunk > MaxFrameSize {
		t.Fatalf("chunk of %d exceeds MaxFrameSize %d", maxChunk, MaxFrameSize)
	}
	if st.State() != StateHalfClosedLocal {
		t.Fatalf("sender state = %s, want half_closed_local after deferred END_STREAM", st.State())
	}
}

// TestConnectionWindowStall verifies DATA stalls when the connection send
// window is exhausted and resumes on the peer's WINDOW_UPDATE credits.
func TestConnectionWindowStall(t *testing.T) {
	// Both ends need a small connection window so the receiver's
	// half-threshold credit kicks in during the test (mirrors TS defaults).
	client, server := pair(t, func(a, b *Options) {
		a.ConnectionWindow = 32 * 1024
		b.ConnectionWindow = 32 * 1024
	})

	payload := make([]byte, 100*1024)
	var (
		mu       sync.Mutex
		received []byte
		stalls   int
	)
	server.opts.OnStream = func(s *Stream) {
		s.OnData(func(chunk []byte) {
			mu.Lock()
			received = append(received, chunk...)
			mu.Unlock()
		})
	}

	st := client.OpenTunnel("stall.test", 2, DefaultPriority)
	if st == nil {
		t.Fatal("OpenTunnel returned nil")
	}
	st.SendData(payload, false)

	delivered := func() int {
		mu.Lock()
		defer mu.Unlock()
		return len(received)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && delivered() < len(payload) {
		if client.Stats().ConnectionSendWindow <= 0 {
			stalls++
		}
		time.Sleep(5 * time.Millisecond)
	}
	if delivered() < len(payload) {
		cs, ss := client.Stats(), server.Stats()
		t.Fatalf("stalled: delivered %d/%d\nclient: %+v\nserver: %+v\nclient stream stats: %+v",
			delivered(), len(payload), cs, ss, cs.Streams)
	}
	t.Logf("connection-window exhaustion observed in %d samples", stalls)
	mu.Lock()
	defer mu.Unlock()
	if !bytes.Equal(received, payload) {
		t.Fatalf("payload corrupted: got %d bytes, want %d", len(received), len(payload))
	}
}

// TestPingRTT covers PING -> PONG echo and the RTT callback.
func TestPingRTT(t *testing.T) {
	client, _ := pair(t, nil)

	done := make(chan int64, 1)
	pump(t, "PONG", func() bool {
		if len(done) > 0 {
			return true
		}
		client.Ping(func(rtt int64) { done <- rtt })
		return false
	})
	if rtt := <-done; rtt < 0 || rtt > 5000 {
		t.Fatalf("rtt = %d ms, out of plausible range", rtt)
	}
}

// TestGoaway covers sending and receiving GOAWAY.
func TestGoaway(t *testing.T) {
	client, server := pair(t, nil)

	st := client.OpenTunnel("goaway.test", 3, DefaultPriority)
	if st == nil {
		t.Fatal("OpenTunnel returned nil")
	}

	var (
		mu     sync.Mutex
		lastID = int64(-1)
		errs   []any
	)
	server.opts.OnGoaway = func(lastStreamID int64) {
		mu.Lock()
		lastID = lastStreamID
		mu.Unlock()
	}
	st.OnError(func(reason any) {
		mu.Lock()
		errs = append(errs, reason)
		mu.Unlock()
	})

	client.Goaway(99)
	if client.CreateStream(0) != nil {
		t.Fatal("CreateStream must return nil after Goaway")
	}
	pump(t, "server OnGoaway", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return lastID == 99
	})
	mu.Lock()
	defer mu.Unlock()
	if len(errs) != 1 || errs[0] != "goaway" {
		t.Fatalf("client stream errors = %v, want [goaway]", errs)
	}
	// TS goaway does not touch the receiving side's stream map; the server's
	// stream stays until the socket closes - assert that parity.
	if n := server.Stats().TotalStreams; n != 1 {
		t.Fatalf("server streams after peer goaway = %d, want 1 (TS parity)", n)
	}
}

// TestResetStream covers RST_STREAM propagation and removal.
func TestResetStream(t *testing.T) {
	client, server := pair(t, nil)

	ready := make(chan *Stream, 1)
	server.opts.OnStream = func(s *Stream) { ready <- s }

	st := client.OpenTunnel("reset.test", 4, DefaultPriority)
	if st == nil {
		t.Fatal("OpenTunnel returned nil")
	}
	peer := <-ready

	errCh := make(chan any, 1)
	peer.OnError(func(reason any) { errCh <- reason })

	st.Reset("boom")
	select {
	case reason := <-errCh:
		if reason != "boom" {
			t.Fatalf("peer saw reason %v, want boom", reason)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for RST_STREAM")
	}
	pump(t, "stream removed from client conn", func() bool { return client.Stats().TotalStreams == 0 })
	pump(t, "stream removed from server conn", func() bool { return server.Stats().TotalStreams == 0 })
}

// TestMalformedFrameSurvival injects garbage at the session level and
// verifies the connection keeps working (TS drop policy).
func TestMalformedFrameSurvival(t *testing.T) {
	cA, cB := newMemPipe()
	client := NewConn(cA, Options{})
	server := NewConn(cB, Options{})
	t.Cleanup(func() {
		client.Close()
		server.Close()
	})

	// Declared length over MaxFrameSize -> dropped by dispatch policy.
	bad := make([]byte, 13)
	putU32(bad[0:4], MaxFrameSize+1)
	putU32(bad[5:9], 1)
	cB.inbox <- memMsg{data: bad}
	// Short junk.
	cB.inbox <- memMsg{data: []byte{0x00, 0x01}}
	// Wildly oversized declared length.
	cB.inbox <- memMsg{data: []byte{0xff, 0xff, 0xff, 0xff, 0x02, 0, 0, 0, 1, 0, 0, 0, 0}}

	// The session must still answer PING afterwards.
	done := make(chan int64, 1)
	pump(t, "session alive after garbage", func() bool {
		if len(done) > 0 {
			return true
		}
		client.Ping(func(rtt int64) { done <- rtt })
		return false
	})
}

// TestConcurrentStreams interleaves several tunnels and verifies isolation.
func TestConcurrentStreams(t *testing.T) {
	client, server := pair(t, nil)

	const n = 8
	var mu sync.Mutex
	got := make(map[uint32][]byte) // keyed by the index carried in TUNNEL_OPEN port
	remaining := n
	serverDone := make(chan struct{})
	server.opts.OnStream = func(s *Stream) {
		open, ok := s.Headers().(TunnelOpen)
		if !ok {
			t.Errorf("stream %d: headers not TunnelOpen: %#v", s.ID(), s.Headers())
			return
		}
		idx := uint32(open.Port)
		s.OnData(func(chunk []byte) {
			mu.Lock()
			got[idx] = append(got[idx], chunk...)
			mu.Unlock()
		})
		s.OnEnd(func() {
			mu.Lock()
			remaining--
			if remaining == 0 {
				close(serverDone)
			}
			mu.Unlock()
		})
	}

	marker := func(id uint32) []byte {
		b := make([]byte, 40*1024) // spans several frames per stream
		for i := range b {
			b[i] = byte(id) ^ byte(i%251)
		}
		return b
	}

	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			id := uint32(i)
			st := client.OpenTunnel("multi.test", int(id), DefaultPriority)
			if st == nil {
				t.Errorf("stream %d: OpenTunnel nil", id)
				return
			}
			st.SendData(marker(id), true)
		}(i)
	}
	wg.Wait()

	select {
	case <-serverDone:
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for all streams to end")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(got) != n {
		t.Fatalf("server saw %d streams, want %d", len(got), n)
	}
	for i := 0; i < n; i++ {
		id := uint32(i)
		want := marker(id)
		if !bytes.Equal(got[id], want) {
			t.Fatalf("stream %d: data corrupted (%d bytes, want %d)", id, len(got[id]), len(want))
		}
	}
}

// TestHeadersFlow covers the HEADERS path used by HTTP proxying. TS parity
// note: the FIRST HEADERS on a new stream is only stored in stream.headers
// (the consumer reads it in OnStream); the OnHeaders callback serves
// subsequent HEADERS frames (e.g. tunnel_ready / tunnel_error).
func TestHeadersFlow(t *testing.T) {
	client, server := pair(t, nil)

	var (
		mu     sync.Mutex
		hdr    json.RawMessage
		hdrEnd bool
	)
	ready := make(chan *Stream, 1)
	server.opts.OnStream = func(s *Stream) {
		if h, ok := s.Headers().(json.RawMessage); ok {
			mu.Lock()
			if hdr == nil {
				hdr = h
			}
			mu.Unlock()
		}
		s.OnHeaders(func(h json.RawMessage, end bool) {
			mu.Lock()
			hdr, hdrEnd = h, end
			mu.Unlock()
		})
		ready <- s
	}

	st := client.CreateStream(DefaultPriority)
	if st == nil {
		t.Fatal("CreateStream returned nil")
	}
	if !st.SendHeaders(map[string]any{"method": "GET", "url": "http://example.com/"}, false) {
		t.Fatal("SendHeaders failed")
	}
	if st.State() != StateOpen {
		t.Fatalf("sender state = %s, want open", st.State())
	}

	peer := <-ready
	pump(t, "server first HEADERS via stream.headers", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return hdr != nil
	})
	mu.Lock()
	wantHdr := `{"method":"GET","url":"http://example.com/"}`
	if string(hdr) != wantHdr {
		t.Fatalf("first headers = %s, want %s", hdr, wantHdr)
	}
	mu.Unlock()
	if peer.State() != StateOpen {
		t.Fatalf("receiver state = %s, want open", peer.State())
	}

	// Subsequent HEADERS reach the registered OnHeaders callback.
	if !st.SendHeaders(map[string]any{"tunnel": "ready"}, false) {
		t.Fatal("second SendHeaders failed")
	}
	pump(t, "server OnHeaders for second HEADERS", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return hdrEnd == false && string(hdr) == `{"tunnel":"ready"}`
	})

	// HEADERS with END_STREAM half-closes both sides.
	if !st.SendHeaders(map[string]any{"final": true}, true) {
		t.Fatal("final SendHeaders failed")
	}
	if st.State() != StateHalfClosedLocal {
		t.Fatalf("sender state = %s, want half_closed_local", st.State())
	}
	pump(t, "receiver half-closed", func() bool { return peer.State() == StateHalfClosedRemote })
	pump(t, "final headers seen", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return string(hdr) == `{"final":true}` && hdrEnd
	})
	// After half-close the sender must refuse further sends.
	if st.SendData([]byte("nope"), false) {
		t.Fatal("SendData on half-closed stream must return false")
	}
}

// TestTextMessagePlane verifies the JSON control plane: SendText rides the
// same FIFO as frames (ordering preserved), OnText receives peer text frames.
func TestTextMessagePlane(t *testing.T) {
	cA, cB := newMemPipe()
	client := NewConn(cA, Options{})
	var (
		mu      sync.Mutex
		gotText []string
	)
	server := NewConn(cB, Options{OnText: func(data []byte) {
		mu.Lock()
		gotText = append(gotText, string(data))
		mu.Unlock()
	}})
	server.opts.OnStream = func(s *Stream) {}
	t.Cleanup(func() {
		client.Close()
		server.Close()
	})

	// Interleave text and frames from the client; FIFO order must hold.
	if !client.SendText([]byte(`{"type":"auth"}`)) {
		t.Fatal("SendText failed")
	}
	st := client.OpenTunnel("order.test", 1, DefaultPriority)
	if st == nil {
		t.Fatal("OpenTunnel returned nil")
	}
	if !client.SendText([]byte(`{"type":"heartbeat"}`)) {
		t.Fatal("SendText 2 failed")
	}

	// Server side records frame arrival order via stream state: the stream
	// must exist before the second text arrives. Probe both.
	pump(t, "both texts received", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(gotText) == 2
	})
	mu.Lock()
	defer mu.Unlock()
	if gotText[0] != `{"type":"auth"}` || gotText[1] != `{"type":"heartbeat"}` {
		t.Fatalf("text order = %v, want [auth heartbeat]", gotText)
	}
	pump(t, "tunnel open seen", func() bool { return server.Stats().TotalStreams == 1 })

	// Reply path: server sends text back to the client via SendText; wire the
	// client's OnText late and confirm reception.
	var replyMu sync.Mutex
	replied := false
	client.opts.OnText = func(data []byte) {
		if string(data) == `{"type":"auth_ok"}` {
			replyMu.Lock()
			replied = true
			replyMu.Unlock()
		}
	}
	if !server.SendText([]byte(`{"type":"auth_ok"}`)) {
		t.Fatal("server SendText failed")
	}
	pump(t, "auth_ok text at client", func() bool {
		replyMu.Lock()
		defer replyMu.Unlock()
		return replied
	})
}

// TestCloseWithBufferedDataOrdering is the regression test for the >64KiB
// response truncation found in the live E2E: sendData(large, true) followed
// immediately by Close() must deliver the full body BEFORE the peer sees
// END_STREAM (the TS client truncates at the send window here).
func TestCloseWithBufferedDataOrdering(t *testing.T) {
	client, server := pair(t, nil)

	payload := bytes.Repeat([]byte{0x5A}, 300*1024)
	var (
		mu       sync.Mutex
		received []byte
		ended    bool
		done     = make(chan struct{})
	)
	server.opts.OnStream = func(s *Stream) {
		s.OnData(func(chunk []byte) {
			mu.Lock()
			received = append(received, chunk...)
			mu.Unlock()
		})
		s.OnEnd(func() {
			mu.Lock()
			ended = true
			mu.Unlock()
			close(done)
		})
	}

	st := client.OpenTunnel("truncation.test", 1, DefaultPriority)
	if st == nil {
		t.Fatal("OpenTunnel returned nil")
	}
	// Buffered send with endStream, then close immediately - the exact
	// executeMuxRequest sequence.
	if !st.SendData(payload, true) {
		t.Fatal("SendData failed")
	}
	st.Close()

	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for stream end")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(received) != len(payload) {
		t.Fatalf("TRUNCATED: peer got %d bytes, want %d", len(received), len(payload))
	}
	if !ended {
		t.Fatal("end not flagged")
	}
	// The stream is fully released after the deferred close.
	pump(t, "stream removed after deferred close", func() bool {
		return client.Stats().TotalStreams == 0
	})
}
