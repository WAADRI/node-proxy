package client

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"math"
	"math/rand"
	"os"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	"github.com/WAADRI/node-proxy-go/internal/streammux"
	"github.com/WAADRI/node-proxy-go/internal/wstransport"
)

// Client is one node: it owns the reconnect loop and, per connection, the
// StreamMux session plus the JSON control plane (auth / info / heartbeat /
// stats). Behavior mirrors client/client.ts, including the security gates
// added there (nothing is served before auth_ok - issues #118/#129).
type Client struct {
	cfg *Config
	log streammux.Logger

	mu          sync.Mutex
	intentional bool

	// Per-connection state, swapped on every (re)connect.
	session               atomic.Pointer[streammux.Conn]
	authed                atomic.Bool
	reconnectAttempt      atomic.Int64
	maxConcurrentOverride atomic.Int64 // -1 = unset
	clientID              atomic.Value // string
	missedPongs           atomic.Int64

	tunnels        atomic.Int64 // active tunnel count (stats)
	activeRequests atomic.Int64 // active mux request count (stats)
}

// New creates a client; Run drives it until ctx is cancelled.
func New(cfg *Config, log streammux.Logger) *Client {
	c := &Client{cfg: cfg, log: log}
	c.maxConcurrentOverride.Store(-1)
	return c
}

// Run blocks, reconnecting with the TS backoff schedule, until ctx is
// cancelled. Like the TS client it never gives up on auth failures on its
// own; the context is the only exit.
func (c *Client) Run(ctx context.Context) error {
	for {
		if ctx.Err() != nil {
			c.closeIntentional()
			return ctx.Err()
		}
		err := c.dialOnce(ctx)
		if err != nil && c.log != nil {
			c.log.Warnf("connection ended: %v", err)
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		delay := c.backoff()
		if c.log != nil {
			c.log.Infof("reconnecting in %dms (attempt %d)", delay.Milliseconds(), c.reconnectAttempt.Load())
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(delay):
		}
	}
}

func (c *Client) closeIntentional() {
	c.mu.Lock()
	c.intentional = true
	s := c.session.Load()
	c.mu.Unlock()
	if s != nil {
		s.Close()
	}
}

// backoff mirrors scheduleReconnect: delay*1.5^attempt + jitter, capped.
func (c *Client) backoff() time.Duration {
	attempt := c.reconnectAttempt.Load()
	delay := time.Duration(float64(c.cfg.ReconnectDelay) * math.Pow(1.5, float64(attempt)))
	delay += time.Duration(rand.Int63n(int64(c.cfg.ReconnectJitter) + 1))
	if delay > c.cfg.MaxReconnectDelay {
		delay = c.cfg.MaxReconnectDelay
	}
	c.reconnectAttempt.Add(1)
	return delay
}

// maxConcurrent is the effective limit (server override or image default).
func (c *Client) maxConcurrent() int {
	if v := c.maxConcurrentOverride.Load(); v >= 0 {
		return int(v)
	}
	return c.cfg.MaxConcurrentRequests
}

// dialOnce performs one full connect-auth-serve lifecycle.
func (c *Client) dialOnce(ctx context.Context) error {
	c.authed.Store(false)
	c.missedPongs.Store(0)

	if c.log != nil {
		c.log.Infof("connecting to %s ...", c.cfg.ServerURL)
	}
	dialer := websocket.Dialer{
		HandshakeTimeout: 10 * time.Second, // TS wsOptions.handshakeTimeout
		TLSClientConfig:  &tls.Config{InsecureSkipVerify: !c.cfg.TLSRejectUnauthorized},
	}
	wsConn, _, err := dialer.Dial(c.cfg.ServerURL, nil)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}

	var session *streammux.Conn
	session = streammux.NewConn(wstransport.Wrap(wsConn), streammux.Options{
		Logger: c.log,
		OnText: c.handleText,
		OnStream: func(s *streammux.Stream) {
			if !c.authed.Load() {
				// Issue #129 gate: refuse streams before authentication.
				if c.log != nil {
					c.log.Warnf("refusing mux stream %d before authentication", s.ID())
				}
				s.Close()
				return
			}
			c.handleStream(s)
		},
		OnGoaway: func(lastStreamID int64) {
			if c.log != nil {
				c.log.Infof("server sent GOAWAY (lastStreamId=%d)", lastStreamID)
			}
			// The server is going away; drop the session to trigger reconnect.
			if session != nil {
				session.Close()
			}
		},
	})
	c.session.Store(session)

	// Auth must be the first message on the socket (text frame).
	authReq, _ := json.Marshal(struct {
		Type  string `json:"type"`
		Token string `json:"token"`
	}{"auth", c.cfg.AuthToken})
	if !session.SendText(authReq) {
		return fmt.Errorf("session closed before auth could be sent")
	}

	hbStop := make(chan struct{})
	defer close(hbStop)

	// Heartbeat starts sending only after auth_ok (gated on c.authed).
	go c.heartbeatLoop(session, hbStop)

	wait := make(chan error, 2)
	go func() {
		<-session.Done()
		wait <- fmt.Errorf("session closed")
	}()
	go func() {
		<-ctx.Done()
		wait <- ctx.Err()
	}()
	err = <-wait

	// Teardown this connection fully.
	session.Close()
	closeAllUdpAssocs()
	c.authed.Store(false)
	return err
}

// handleText is the JSON control-plane dispatcher (TS handleMessage). Before
// auth_ok only the auth handshake is accepted - everything else is ignored
// (issue #118).
func (c *Client) handleText(data []byte) {
	var msg struct {
		Type string `json:"type"`
		// auth_error / error
		Message string `json:"message"`
		// limits
		MaxConcurrentRequests any `json:"maxConcurrentRequests"`
		// info_ok
		ClientID string `json:"clientId"`
	}
	if err := json.Unmarshal(data, &msg); err != nil {
		if c.log != nil {
			c.log.Warnf("invalid text message: %v", err)
		}
		return
	}

	switch msg.Type {
	case "auth_ok":
		if c.authed.Swap(true) {
			return
		}
		if c.log != nil {
			c.log.Info("authentication successful")
		}
		if info, err := json.Marshal(struct {
			Type string         `json:"type"`
			Info map[string]any `json:"info"`
		}{"info", c.systemInfo()}); err == nil {
			c.sendText(info)
		}
	case "auth_error":
		if c.log != nil {
			c.log.Errorf("authentication failed: %s", orDefault(msg.Message, "invalid token"))
		}
		// TS does not exit; the normal close path backs off and retries.
		if s := c.session.Load(); s != nil {
			s.Close()
		}
	case "limits":
		// Validate before applying (TS guards NaN / absurd values).
		lim, ok := toInt(msg.MaxConcurrentRequests)
		if !ok || lim < 1 || lim > 100000 {
			if c.log != nil {
				c.log.Warnf("ignoring invalid concurrency limit from server: %v", msg.MaxConcurrentRequests)
			}
			return
		}
		if old := c.maxConcurrentOverride.Swap(int64(lim)); old != int64(lim) {
			if c.log != nil {
				c.log.Infof("concurrency limit set to %d by the server (image default %d)", lim, c.cfg.MaxConcurrentRequests)
			}
		}
	case "info_ok":
		if msg.ClientID != "" {
			c.clientID.Store(msg.ClientID)
			if c.log != nil {
				c.log.Infof("registered with ID: %s", msg.ClientID)
			}
		}
	case "error":
		if c.log != nil {
			c.log.Warnf("server error: %s", msg.Message)
		}
	case "broadcast":
		if c.log != nil {
			var extra struct {
				Message string `json:"message"`
			}
			_ = json.Unmarshal(data, &extra)
			c.log.Infof("[broadcast] %s", extra.Message)
		}
	case "udp_data":
		c.handleUdpData(data)
	case "net_test":
		c.handleNetTest(data)
	default:
		// request / tunnel_open / tunnel_data / udp_data are the legacy JSON
		// protocol; this client speaks them over mux only (supportsMux=true
		// makes the server use the mux paths).
		if c.log != nil {
			c.log.Debugf("ignoring text message type %q", msg.Type)
		}
	}
}

func (c *Client) sendText(data []byte) bool {
	if s := c.session.Load(); s != nil {
		return s.SendText(data)
	}
	return false
}

// heartbeatLoop mirrors startHeartbeat: JSON heartbeat + stats every interval,
// mux-level PING for liveness; 3 missed PONGs force a reconnect.
func (c *Client) heartbeatLoop(session *streammux.Conn, stop <-chan struct{}) {
	if c.cfg.HeartbeatInterval <= 0 {
		return
	}
	t := time.NewTicker(c.cfg.HeartbeatInterval)
	defer t.Stop()
	start := time.Now()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			if !c.authed.Load() {
				continue
			}
			// Mux-level liveness (works over any transport; the TS client
			// uses ws-level pings, the server answers both).
			c.missedPongs.Add(1)
			session.Ping(func(int64) { c.missedPongs.Store(0) })
			if c.missedPongs.Load() >= 3 {
				if c.log != nil {
					c.log.Warnf("no pong from server for %d heartbeats, forcing reconnect", c.missedPongs.Load())
				}
				session.Close()
				return
			}
			c.sendText([]byte(`{"type":"heartbeat"}`))
			stats, _ := json.Marshal(struct {
				Type  string         `json:"type"`
				Stats map[string]any `json:"stats"`
			}{"stats", map[string]any{
				"uptime":                time.Since(start).Seconds(),
				"memoryUsage":           heapAllocBytes(),
				"activeRequests":        c.activeRequests.Load(),
				"activeTunnels":         c.tunnels.Load(),
				"maxConcurrentRequests": c.maxConcurrent(),
			}})
			c.sendText(stats)
		}
	}
}

// systemInfo mirrors getSystemInfo(); fields the panel reads stay identical.
func (c *Client) systemInfo() map[string]any {
	host, _ := os.Hostname()
	info := map[string]any{
		"hostname":    host,
		"platform":    runtime.GOOS,
		"arch":        runtime.GOARCH,
		"cpuCount":    runtime.NumCPU(),
		"version":     Version,
		"clientId":    c.cfg.ClientID,
		"supportsMux": true,
		"pid":         os.Getpid(),
	}
	if c.cfg.Region != "" {
		info["region"] = c.cfg.Region
	}
	if c.cfg.Tags != "" {
		var tags []string
		for _, tg := range strings.Split(c.cfg.Tags, ",") {
			if tg = strings.TrimSpace(tg); tg != "" {
				tags = append(tags, tg)
			}
		}
		info["tags"] = tags
	}
	return info
}

func heapAllocBytes() uint64 {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return m.HeapAlloc
}

// ---------------------------------------------------------------------------
// Stream dispatch (TS handleMuxStream)
// ---------------------------------------------------------------------------

func (c *Client) handleStream(s *streammux.Stream) {
	switch hv := s.Headers().(type) {
	case streammux.TunnelOpen:
		c.handleTunnel(s, hv.Host, hv.Port)
	case json.RawMessage:
		// HEADERS-initiated streams carry a JSON object: request or tunnel.
		var probe struct {
			Type   string `json:"type"`
			Method string `json:"method"`
			Host   string `json:"host"`
			Port   int    `json:"port"`
		}
		if err := json.Unmarshal(hv, &probe); err != nil {
			s.Close()
			return
		}
		if probe.Type == "request" || probe.Method != "" {
			c.handleMuxRequest(s, hv)
			return
		}
		if probe.Type == "tunnel_open" || (probe.Host != "" && probe.Port != 0) {
			c.handleTunnel(s, probe.Host, probe.Port)
			return
		}
		// Unknown stream type - just close it (TS parity).
		s.Close()
	default:
		s.Close()
	}
}

func jsonString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

func orDefault(v, def string) string {
	if v == "" {
		return def
	}
	return v
}

func toInt(v any) (int, bool) {
	switch n := v.(type) {
	case float64:
		if n != math.Trunc(n) {
			return 0, false
		}
		return int(n), true
	case string:
		var i int
		_, err := fmt.Sscanf(n, "%d", &i)
		return i, err == nil
	default:
		return 0, false
	}
}
