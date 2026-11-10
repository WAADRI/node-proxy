package server

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/WAADRI/node-proxy-go/internal/client"
	"github.com/WAADRI/node-proxy-go/internal/streammux"
)

type countedTransport struct {
	inner client.WSTransport
	bytes int64
	mu    sync.Mutex
}

func (c *countedTransport) ReadMessage() ([]byte, bool, error) { return c.inner.ReadMessage() }
func (c *countedTransport) WriteMessage(data []byte) error {
	c.mu.Lock()
	c.bytes += int64(len(data))
	c.mu.Unlock()
	return c.inner.WriteMessage(data)
}
func (c *countedTransport) WriteTextMessage(data []byte) error {
	c.mu.Lock()
	c.bytes += int64(len(data))
	c.mu.Unlock()
	return c.inner.WriteTextMessage(data)
}
func (c *countedTransport) Close() error { return c.inner.Close() }
func (c *countedTransport) written() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.bytes
}

func TestLiveCompressionBandwidth(t *testing.T) {
	const payloadSize = 2 << 20

	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		for {
			conn, aerr := echo.Accept()
			if aerr != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				buf := make([]byte, 64*1024)
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
	echoPort := echo.Addr().(*net.TCPAddr).Port

	transfer := func(compress bool) int64 {
		cfg := Default()
		cfg.Web.Enabled = false
		cfg.CompressEnabled = compress
		srv := &Server{Cfg: cfg, Mgr: NewManager(cfg, nil)}
		srv.Settings = NewSettings(srv)
		srv.ClientWSOptions = func(o *streammux.Options) {
			o.Compression = &streammux.CompressionConfig{Enabled: compress}
		}

		mux := http.NewServeMux()
		mux.HandleFunc("/ws", srv.HandleClientWS)
		api := httptest.NewServer(mux)
		defer api.Close()

		var counter *countedTransport
		nodeCfg := &client.Config{
			ServerURL: "ws" + api.URL[len("http"):] + "/ws",
			AuthToken: cfg.AuthToken, ClientID: "bw-node",
			TLSRejectUnauthorized: true,
			ReconnectDelay:        50 * time.Millisecond, MaxReconnectDelay: 100 * time.Millisecond,
			ReconnectJitter: 10 * time.Millisecond, HeartbeatInterval: 0,
			TunnelTimeout: 10 * time.Second, RequestTimeout: 20 * time.Second,
			MaxConcurrentRequests: 100,
			CompressEnabled:       compress,
			WSTransportWrap: func(tr client.WSTransport) client.WSTransport {
				counter = &countedTransport{inner: tr}
				return counter
			},
		}
		node := client.New(nodeCfg, nil)
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan struct{})
		go func() { _ = node.Run(ctx); close(done) }()
		defer func() { cancel(); <-done }()

		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) && len(srv.Mgr.All()) == 0 {
			time.Sleep(20 * time.Millisecond)
		}
		if len(srv.Mgr.All()) == 0 {
			t.Fatal("node never registered")
		}

		nodeSess := srv.Mgr.All()[0].Mux
		if nodeSess == nil {
			t.Fatal("node has no mux")
		}

		proxySide, derr := net.Dial("tcp", echo.Addr().String())
		if derr != nil {
			t.Fatal(derr)
		}
		defer proxySide.Close()

		if openNodeTunnel(srv, proxySide, srv.Mgr.All()[0], "127.0.0.1", echoPort, "connect", nil) == "" {
			t.Fatal("openNodeTunnel failed")
		}

		payload := []byte(strings.Repeat("compressible relay payload line\n", payloadSize/33))
		go func() {
			proxySide.SetWriteDeadline(time.Now().Add(30 * time.Second))
			_, _ = proxySide.Write(payload)
		}()

		var readTotal int64
		buf := make([]byte, 64*1024)
		proxySide.SetReadDeadline(time.Now().Add(30 * time.Second))
		for readTotal < int64(len(payload)) {
			n, rerr := proxySide.Read(buf)
			if n > 0 {
				readTotal += int64(n)
			}
			if rerr != nil {
				break
			}
		}
		// Allow small overrun: the tunnel may deliver trailing window bytes.
		if readTotal < int64(len(payload)) {
			t.Fatalf("echo round trip short: %d/%d", readTotal, len(payload))
		}
		return counter.written()
	}

	withOff := transfer(false)
	withOn := transfer(true)

	t.Logf("node-side wire: compression off = %d B, on = %d B (payload %d B)", withOff, withOn, payloadSize)
	if withOn >= withOff {
		t.Fatalf("compression did not reduce wire bytes: off=%d on=%d", withOff, withOn)
	}
	ratio := float64(withOn) / float64(withOff)
	if ratio > 0.7 {
		t.Fatalf("ratio %.2f - compression ineffective", ratio)
	}
}
