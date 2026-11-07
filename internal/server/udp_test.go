package server

import (
	"bytes"
	"context"
	"encoding/binary"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/WAADRI/node-proxy-go/internal/client"
)

// contextWithCancel adapts a stop channel to context.Context.
func contextWithCancel(stop <-chan struct{}) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		<-stop
		cancel()
	}()
	return ctx, cancel
}

// muxForWS exposes the WebSocket+panel mux for in-process client tests.
func (s *Server) muxForWS() http.Handler {
	m := http.NewServeMux()
	s.HandlePanelAPI(m)
	m.HandleFunc("/ws", s.HandleClientWS)
	return m
}

// startSocks5Listener runs the SOCKS5 handler on a random port.
func startSocks5Listener(t *testing.T, srv *Server) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go srv.HandleSOCKS5(conn)
		}
	}()
	t.Cleanup(func() { _ = ln.Close() })
	return ln.Addr().String()
}

// udpEchoServer replies every datagram with a prefix.
func udpEchoServer(t *testing.T) string {
	t.Helper()
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		buf := make([]byte, 2048)
		for {
			n, rinfo, err := conn.ReadFromUDP(buf)
			if n > 0 {
				resp := append([]byte("echo:"), buf[:n]...)
				_, _ = conn.WriteToUDP(resp, rinfo)
			}
			if err != nil {
				return
			}
		}
	}()
	t.Cleanup(func() { _ = conn.Close() })
	return conn.LocalAddr().String()
}

// socks5UDPAssociate performs greeting + UDP ASSOCIATE, returns relay port.
func socks5UDPAssociate(t *testing.T, socksAddr string) *net.UDPAddr {
	t.Helper()
	conn, err := net.Dial("tcp", socksAddr)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })

	// greeting: ver=5, 1 method, no-auth
	if _, err := conn.Write([]byte{0x05, 0x01, 0x00}); err != nil {
		t.Fatal(err)
	}
	greeting := make([]byte, 2)
	if _, err := io.ReadFull(conn, greeting); err != nil {
		t.Fatal(err)
	}
	if greeting[0] != 0x05 || greeting[1] != 0x00 {
		t.Fatalf("greeting reply = %v", greeting)
	}

	// request: cmd=3 (associate), atyp=1, 0.0.0.0:0 (curl-style)
	req := []byte{0x05, 0x03, 0x00, 0x01, 0, 0, 0, 0, 0, 0}
	if _, err := conn.Write(req); err != nil {
		t.Fatal(err)
	}
	reply := make([]byte, 10)
	if _, err := io.ReadFull(conn, reply); err != nil {
		t.Fatal(err)
	}
	if reply[1] != 0x00 {
		t.Fatalf("associate reply code = %d", reply[1])
	}
	port := int(binary.BigEndian.Uint16(reply[8:10]))
	return &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: port}
}

// TestUDPRelayLoopback drives the full SOCKS5 UDP ASSOCIATE path against the
// in-process Go server with an in-process Go client as the relay node.
func TestUDPRelayLoopback(t *testing.T) {
	srv, _, _ := newTestServer(t)
	srv.Cfg.AuthToken = "udp-test-token"
	socksAddr := startSocks5Listener(t, srv)

	// Go client as the relay node.
	clientBase := httptest.NewServer(srv.muxForWS())
	clientURL := "ws" + strings.TrimPrefix(clientBase.URL, "http") + "/ws"
	cfg := &client.Config{
		ServerURL:             clientURL,
		AuthToken:             "udp-test-token",
		ClientID:              "udp-relay-node",
		TLSRejectUnauthorized: true,
		ReconnectDelay:        50 * time.Millisecond,
		MaxReconnectDelay:     100 * time.Millisecond,
		ReconnectJitter:       10 * time.Millisecond,
		HeartbeatInterval:     0,
		TunnelTimeout:         2 * time.Second,
		RequestTimeout:        5 * time.Second,
		MaxConcurrentRequests: 100,
	}
	node := client.New(cfg, nil)
	stop := make(chan struct{})
	go func() {
		ctx, cancel := contextWithCancel(stop)
		_ = node.Run(ctx)
		cancel()
	}()
	t.Cleanup(func() { close(stop) })

	// Wait for registration.
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) && len(srv.Mgr.All()) == 0 {
		time.Sleep(10 * time.Millisecond)
	}
	if len(srv.Mgr.All()) == 0 {
		t.Fatal("relay node never registered")
	}

	echoAddr := udpEchoServer(t)
	_, echoPortStr, _ := net.SplitHostPort(echoAddr)
	echoPort, _ := strconv.Atoi(echoPortStr)

	relay := socks5UDPAssociate(t, socksAddr)

	// Send one datagram through the relay: SOCKS5 UDP header + payload.
	sock, err := net.DialUDP("udp4", nil, relay)
	if err != nil {
		t.Fatal(err)
	}
	defer sock.Close()
	payload := []byte("hello-udp-relay")
	dg := []byte{0x00, 0x00, 0x00, 0x01, 127, 0, 0, 1}
	dg = binary.BigEndian.AppendUint16(dg, uint16(echoPort))
	dg = append(dg, payload...)
	if _, err := sock.Write(dg); err != nil {
		t.Fatal(err)
	}

	sock.SetReadDeadline(time.Now().Add(10 * time.Second))
	buf := make([]byte, 2048)
	n, err := sock.Read(buf)
	if err != nil {
		t.Fatalf("no UDP response through relay: %v", err)
	}
	// Response: RSV(3) + ATYP/addr/port(10 for v4) + payload.
	if n < 10+20 {
		t.Fatalf("short response: %d bytes", n)
	}
	got := buf[10:n]
	if !bytes.Equal(got, []byte("echo:"+string(payload))) {
		t.Fatalf("payload = %q, want echo of %q", got, "echo:"+string(payload))
	}
	if buf[2] != 0x00 {
		t.Fatalf("FRAG != 0 in response")
	}
}

// TestMetricsExposition drives HTTP traffic through the server and asserts
// the TS-compatible Prometheus series appear.
func TestMetricsExposition(t *testing.T) {
	srv, _, _ := newTestServer(t)
	srv.Cfg.AuthToken = "metrics-token"

	// Generate a bit of state.
	srv.Metrics.ObserveTunnel("ok")
	srv.Metrics.ObserveError("test", "some-node")
	srv.Metrics.ObserveRequest("http", "200", 12, 1024)

	handler := srv.Metrics.Handler(srv)
	req := httptest.NewRequest("GET", "/metrics", nil)
	rec := httptest.NewRecorder()
	handler(rec, req)
	body := rec.Body.String()

	for _, series := range []string{
		"# TYPE node_proxy_requests_total counter",
		"# TYPE node_proxy_bytes_total counter",
		"# TYPE node_proxy_tunnels_total counter",
		"# TYPE node_proxy_errors_total counter",
		"# TYPE node_proxy_active_clients gauge",
		"# TYPE node_proxy_active_requests gauge",
		"# TYPE node_proxy_active_tunnels gauge",
		"# TYPE node_proxy_client_load gauge",
		"# TYPE node_proxy_circuit_breaker_state gauge",
		"# TYPE node_proxy_request_duration_ms histogram",
		"# TYPE node_proxy_tunnel_duration_ms histogram",
		"# TYPE node_proxy_response_size_bytes summary",
		`node_proxy_tunnels_total{status="ok"} 1`,
		`node_proxy_errors_total{type="test", client_id="some-node"} 1`,
		`node_proxy_request_duration_ms_bucket{type="http",le="25"}`,
		`node_proxy_response_size_bytes{type="http",quantile="0.5"}`,
	} {
		if !strings.Contains(body, series) {
			t.Errorf("metrics missing %q", series)
		}
	}
}
