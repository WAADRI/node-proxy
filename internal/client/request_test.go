package client

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/WAADRI/node-proxy-go/internal/streammux"
)

// msgPipe is a minimal message-oriented transport for client tests.
type msgPipe struct {
	peer      *msgPipe
	inbox     chan pipeMsg
	closeOnce sync.Once
	closed    chan struct{}
}

type pipeMsg struct {
	data []byte
	text bool
}

func newMsgPipe() (a, b *msgPipe) {
	a = &msgPipe{inbox: make(chan pipeMsg, 4096), closed: make(chan struct{})}
	b = &msgPipe{inbox: make(chan pipeMsg, 4096), closed: make(chan struct{})}
	a.peer, b.peer = b, a
	return a, b
}

func (p *msgPipe) ReadMessage() ([]byte, bool, error) {
	select {
	case m := <-p.inbox:
		return m.data, m.text, nil
	case <-p.closed:
		return nil, false, errClosed
	}
}

func (p *msgPipe) WriteMessage(data []byte) error {
	return p.write(pipeMsg{data: append([]byte(nil), data...)})
}

func (p *msgPipe) WriteTextMessage(data []byte) error {
	return p.write(pipeMsg{data: append([]byte(nil), data...), text: true})
}

func (p *msgPipe) write(m pipeMsg) error {
	select {
	case p.peer.inbox <- m:
		return nil
	case <-p.closed:
		return errClosed
	}
}

func (p *msgPipe) Close() error {
	p.closeOnce.Do(func() { close(p.closed) })
	return nil
}

var errClosed = errClosedErr{}

type errClosedErr struct{}

func (errClosedErr) Error() string { return "pipe closed" }

func defaultTestConfig() *Config {
	return &Config{
		ServerURL:             "ws://127.0.0.1:1/ws",
		AuthToken:             "test-token",
		TLSRejectUnauthorized: true,
		ReconnectDelay:        50 * time.Millisecond,
		MaxReconnectDelay:     100 * time.Millisecond,
		ReconnectJitter:       10 * time.Millisecond,
		HeartbeatInterval:     0,
		RequestTimeout:        5 * time.Second,
		TunnelTimeout:         2 * time.Second,
		MaxConcurrentRequests: 100,
	}
}

func waitFor(t *testing.T, what string, cond func() bool) {
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

// harness wires the client's stream dispatch against a fake server-side
// session over an in-memory pipe.
type harness struct {
	node   *streammux.Conn // the client side
	peer   *streammux.Conn // the fake server side
	peerCh chan *streammux.Stream
}

func newHarness(t *testing.T, c *Client) *harness {
	t.Helper()
	a, b := newMsgPipe()
	h := &harness{peerCh: make(chan *streammux.Stream, 8)}
	h.node = streammux.NewConn(a, streammux.Options{
		OnStream: func(s *streammux.Stream) { c.handleStream(s) },
	})
	h.peer = streammux.NewConn(b, streammux.Options{
		OnStream: func(s *streammux.Stream) { h.peerCh <- s },
	})
	t.Cleanup(func() {
		h.node.Close()
		h.peer.Close()
	})
	return h
}

// createRequestStream allocates the server-side stream. Response callbacks
// must be registered (collectResponse) BEFORE sendRequest fires.
func (h *harness) createRequestStream(t *testing.T) *streammux.Stream {
	t.Helper()
	st := h.peer.CreateStream(128)
	if st == nil {
		t.Fatal("CreateStream returned nil")
	}
	return st
}

// sendRequest mimics proxy-http.ts: HEADERS {type:request,...} with END_STREAM
// when there is no body, then optional body DATA + END_STREAM.
func (h *harness) sendRequest(st *streammux.Stream, id, method, url string, hdrs map[string]any, body []byte) {
	headers := map[string]any{"type": "request", "id": id, "method": method, "url": url}
	if hdrs != nil {
		headers["headers"] = hdrs
	}
	if !st.SendHeaders(headers, len(body) == 0) {
		panic("SendHeaders failed")
	}
	if len(body) > 0 {
		st.SendData(body, true)
	}
}

// collectResponse registers response collectors on a stream. Call BEFORE any
// traffic on that stream so the callbacks are set before frames arrive.
func collectResponse(st *streammux.Stream) <-chan response {
	ch := make(chan response, 1)
	var (
		mu   sync.Mutex
		hdr  map[string]any
		body []byte
	)
	fire := func() {
		mu.Lock()
		r := response{Headers: hdr, Body: append([]byte(nil), body...)}
		mu.Unlock()
		select {
		case ch <- r:
		default:
		}
	}
	st.OnHeaders(func(h json.RawMessage, _ bool) {
		var m map[string]any
		_ = json.Unmarshal(h, &m)
		mu.Lock()
		hdr = m
		mu.Unlock()
	})
	st.OnData(func(chunk []byte) {
		mu.Lock()
		body = append(body, chunk...)
		mu.Unlock()
	})
	st.OnEnd(fire)
	st.OnError(func(any) { fire() })
	return ch
}

// response is what the peer side of a request stream collects.
type response struct {
	Headers map[string]any
	Body    []byte
}

// TestMuxRequestGet runs a full GET request through the mux request path.
func TestMuxRequestGet(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Trace") != "abc" {
			w.WriteHeader(400)
			_, _ = w.Write([]byte("missing header"))
			return
		}
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(201)
		_, _ = w.Write([]byte("created-body"))
	}))
	defer target.Close()

	cfg := defaultTestConfig()
	c := New(cfg, nil)
	h := newHarness(t, c)

	st := h.createRequestStream(t)
	respCh := collectResponse(st)
	h.sendRequest(st, "req-1", "GET", target.URL+"/thing", map[string]any{"x-trace": "abc"}, nil)
	resp := <-respCh
	if resp.Headers == nil {
		t.Fatal("no response headers")
	}
	if resp.Headers["type"] != "response" || resp.Headers["statusCode"] != float64(201) || resp.Headers["statusMessage"] != "Created" {
		t.Fatalf("headers = %v", resp.Headers)
	}
	if resp.Headers["id"] != "req-1" {
		t.Fatalf("echoed id = %v, want req-1", resp.Headers["id"])
	}
	respHeaders, _ := resp.Headers["headers"].(map[string]any)
	if respHeaders == nil || respHeaders["content-type"] != "text/plain" {
		t.Fatalf("response headers = %v, want lowercased content-type", resp.Headers["headers"])
	}
	if string(resp.Body) != "created-body" {
		t.Fatalf("body = %q", resp.Body)
	}
	// The client side releases its stream; the peer side keeps it as
	// half_closed_remote (TS mux parity - only the owning side removes it).
	waitFor(t, "client stream released", func() bool {
		return h.node.Stats().TotalStreams == 0
	})
}

// TestMuxRequestPostBody covers body upload and the response path.
func TestMuxRequestPostBody(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		_, _ = w.Write([]byte(strings.ToUpper(string(b))))
	}))
	defer target.Close()

	cfg := defaultTestConfig()
	c := New(cfg, nil)
	h := newHarness(t, c)

	st := h.createRequestStream(t)
	respCh := collectResponse(st)
	h.sendRequest(st, "req-2", "POST", target.URL+"/", map[string]any{"content-type": "text/plain"}, []byte("hello-upstream"))
	resp := <-respCh
	if resp.Headers == nil || resp.Headers["statusCode"] != float64(200) {
		t.Fatalf("headers = %v", resp.Headers)
	}
	if string(resp.Body) != "HELLO-UPSTREAM" {
		t.Fatalf("body = %q", resp.Body)
	}
}

// TestMuxRequestBadURL covers the 400 path.
func TestMuxRequestBadURL(t *testing.T) {
	cfg := defaultTestConfig()
	c := New(cfg, nil)
	h := newHarness(t, c)

	st := h.createRequestStream(t)
	respCh := collectResponse(st)
	h.sendRequest(st, "req-3", "GET", "not-a-url", nil, nil)
	resp := <-respCh
	if resp.Headers == nil || resp.Headers["statusCode"] != float64(400) {
		t.Fatalf("headers = %v, want 400", resp.Headers)
	}
	if !strings.Contains(string(resp.Body), "Invalid request") {
		t.Fatalf("body = %q", resp.Body)
	}
}

// TestMuxRequestRefusedTarget covers the 502 path (connect error).
func TestMuxRequestRefusedTarget(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	closedURL := "http://127.0.0.1:" + strconv.Itoa(l.Addr().(*net.TCPAddr).Port)
	l.Close()

	cfg := defaultTestConfig()
	c := New(cfg, nil)
	h := newHarness(t, c)

	st := h.createRequestStream(t)
	respCh := collectResponse(st)
	h.sendRequest(st, "req-4", "GET", closedURL, nil, nil)
	resp := <-respCh
	if resp.Headers == nil || resp.Headers["statusCode"] != float64(502) {
		t.Fatalf("headers = %v, want 502", resp.Headers)
	}
}
