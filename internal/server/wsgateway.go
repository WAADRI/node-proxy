package server

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	"github.com/WAADRI/node-proxy-go/internal/streammux"
	"github.com/WAADRI/node-proxy-go/internal/wstransport"
)

// ClientSession is one connected client node: the WebSocket, its mux session
// and the JSON control-plane state (TS ws-server 'connection' handler).
type ClientSession struct {
	srv *Server
	ws  *websocket.Conn

	mu       sync.Mutex
	authed   bool
	clientID string
	closed   bool

	// mux is atomic: the streammux read loop starts inside NewConn, before
	// HandleClientWS gets to store the pointer, and callbacks read it.
	mux atomic.Pointer[streammux.Conn]
}

// Server wires the whole data plane together.
type Server struct {
	Cfg            *Config
	Mgr            *Manager
	Log            Logger
	Settings       *Settings
	Metrics        *Metrics
	ACL            *ACL
	DomainRouter   *DomainRouter
	ProxyPasswords *[]*ProxyPassword
	Users          *UserStore
	Cache          *ResponseCache
	Bandwidth      *BandwidthLimiter
	Audit          *AuditLog
	NetTest        *NetTestManager
	// GitHubAPIBase is injectable for tests ("https://api.github.com" when empty).
	GitHubAPIBase string
}

// upgrader caps message size like TS (16 MiB = 1024 x mux max frame).
var upgrader = websocket.Upgrader{
	ReadBufferSize:  32 * 1024,
	WriteBufferSize: 32 * 1024,
}

// HandleClientWS is the /ws upgrade endpoint.
func (s *Server) HandleClientWS(w http.ResponseWriter, r *http.Request) {
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	sess := &ClientSession{srv: s, ws: ws}

	clientIP := clientIPFromRequest(r, s.Cfg.TrustedProxyHops)

	sess.mux.Store(streammux.NewConn(wstransport.Wrap(ws), streammux.Options{
		OnStream: func(st *streammux.Stream) {
			sess.mu.Lock()
			authed := sess.authed
			sess.mu.Unlock()
			if !authed {
				st.Reset(1) // TS resets pre-auth streams with code 1
				return
			}
			s.dispatchClientStream(st)
		},
		OnText: func(data []byte) {
			sess.handleText(data, clientIP)
		},
	}))

	// Server-side liveness: mux ping every 30s updates the node RTT (TS
	// pingInterval). A node whose heartbeats stop gets reaped below.
	go sess.pingLoop()
}

// pingLoop mirrors the TS 30s mux ping; a missed node is dropped when its
// heartbeats stop (health check simplified to pong freshness).
func (sess *ClientSession) pingLoop() {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for range t.C {
		sess.mu.Lock()
		closed, id := sess.closed, sess.clientID
		mux := sess.mux.Load()
		sess.mu.Unlock()
		if closed || mux == nil {
			return
		}
		mux.Ping(func(rtt int64) {
			sess.srv.Mgr.mu.Lock()
			if c := sess.srv.Mgr.clients[id]; c != nil {
				c.RTT = rtt
			}
			sess.srv.Mgr.mu.Unlock()
		})
		// Health: no pong/heartbeat for 2 intervals -> drop the node.
		sess.mu.Lock()
		cid := sess.clientID
		sess.mu.Unlock()
		if cid != "" {
			sess.srv.Mgr.mu.Lock()
			c := sess.srv.Mgr.clients[cid]
			stale := c != nil && time.Since(c.LastPong) > 65*time.Second
			sess.srv.Mgr.mu.Unlock()
			if stale {
				sess.srv.Log.Warnf("client %s unhealthy (no heartbeat), dropping", cid)
				sess.Close()
				return
			}
		}
	}
}

// Close tears the session down and releases everything it owed.
func (sess *ClientSession) Close() {
	sess.mu.Lock()
	if sess.closed {
		sess.mu.Unlock()
		return
	}
	sess.closed = true
	id := sess.clientID
	sess.mu.Unlock()

	if id != "" {
		sess.srv.Mgr.Remove(id, sess)
	}
	if mux := sess.mux.Load(); mux != nil {
		mux.Close()
	}
	if sess.ws != nil {
		_ = sess.ws.Close()
	}
}

// clientTextMsg is the JSON control-plane message shape (text frames).
type clientTextMsg struct {
	Type string `json:"type"`
	// auth
	Token string `json:"token"`
	// info
	Info map[string]any `json:"info"`
	// stats
	Stats map[string]any `json:"stats"`
	// legacy response / tunnel_*
	ID            string         `json:"id"`
	StatusCode    int            `json:"statusCode"`
	StatusMessage string         `json:"statusMessage"`
	Headers       map[string]any `json:"headers"`
	Body          string         `json:"body"`
	Data          string         `json:"data"`
	Message       string         `json:"message"`
	Code          string         `json:"code"`
	Error         string         `json:"error"`
	MaxConcurrent int            `json:"maxConcurrentRequests"`
	// udp_data_response
	AssocID string      `json:"assocId"`
	Src     *udpSrcAddr `json:"src"`
	Rinfo   *udpSrcAddr `json:"rinfo"`
	// net_test_*
	TaskID string `json:"taskId"`
}

type udpSrcAddr struct {
	Address string `json:"address"`
	Port    int    `json:"port"`
}

// handleText is the JSON control plane (auth / info / heartbeat / stats /
// legacy response + tunnel_* handlers).
func (sess *ClientSession) handleText(data []byte, clientIP string) {
	s := sess.srv
	var msg clientTextMsg
	if err := json.Unmarshal(data, &msg); err != nil {
		s.Log.Warnf("invalid JSON from client: %v", err)
		return
	}

	sess.mu.Lock()
	authed := sess.authed
	sess.mu.Unlock()

	if !authed {
		if msg.Type == "auth" {
			if msg.Token == s.Cfg.AuthToken {
				sess.mu.Lock()
				sess.authed = true
				sess.mu.Unlock()
				sess.sendText([]byte(`{"type":"auth_ok"}`))
				lim, _ := json.Marshal(struct {
					Type                  string `json:"type"`
					MaxConcurrentRequests int    `json:"maxConcurrentRequests"`
				}{"limits", s.Cfg.MaxConcurrent})
				sess.sendText(lim)
			} else {
				s.Log.Warnf("client auth failed from %s", clientIP)
				sess.sendText([]byte(`{"type":"auth_error","message":"Invalid token"}`))
				_ = sess.ws.Close()
			}
		}
		return
	}

	switch msg.Type {
	case "info":
		info := msg.Info
		if info == nil {
			info = map[string]any{}
		}
		info["ip"] = clientIP
		id := s.Mgr.Add(sess, info)
		sess.mu.Lock()
		sess.clientID = id
		supportsMux, _ := info["supportsMux"].(bool)
		sess.mu.Unlock()
		s.Mgr.mu.Lock()
		if c := s.Mgr.clients[id]; c != nil {
			if supportsMux {
				c.Mux = sess.mux.Load()
			}
		}
		s.Mgr.mu.Unlock()
		ok, _ := json.Marshal(struct {
			Type     string `json:"type"`
			ClientID string `json:"clientId"`
		}{"info_ok", id})
		sess.sendText(ok)
		s.Log.Infof("client registered: %s (mux=%v, ip=%s)", id, supportsMux, clientIP)

	case "heartbeat", "pong":
		sess.mu.Lock()
		id := sess.clientID
		sess.mu.Unlock()
		if id == "" {
			break
		}
		if !s.Mgr.RecordPong(id, sess) {
			// Unregistered session (dropped by a stale close): close so the
			// node reconnects and re-registers - only 'info' can register.
			s.Log.Warnf("heartbeat from unregistered session %s - closing", id)
			sess.Close()
		}

	case "stats":
		sess.mu.Lock()
		id := sess.clientID
		sess.mu.Unlock()
		if id != "" && len(msg.Stats) > 0 {
			s.Mgr.MergeStats(id, msg.Stats)
		}

	case "response":
		s.handleLegacyResponse(&msg)

	case "tunnel_ready":
		s.handleLegacyTunnelReady(sess, &msg)

	case "tunnel_data":
		p := s.Mgr.PopTunnel(msg.ID)
		if p == nil || p.socket == nil {
			break
		}
		raw, err := base64.StdEncoding.DecodeString(msg.Data)
		if err == nil {
			_, _ = p.socket.Write(raw)
			totalBytesDn.Add(int64(len(raw)))
		}

	case "tunnel_close":
		p := s.Mgr.PopTunnel(msg.ID)
		if p != nil && p.socket != nil {
			_ = p.socket.Close()
		}

	case "tunnel_error":
		p := s.Mgr.PopTunnel(msg.ID)
		if p == nil {
			break
		}
		established := p.ready
		s.Log.Warnf("tunnel %s failed on node %s: %s (%s) established=%v",
			msg.ID, p.client.ID, msg.Message, msg.Code, established)
		if p.socket != nil && !established {
			if p.tunnelTyp == "socks5" {
				_, _ = p.socket.Write([]byte{0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
			} else {
				_, _ = p.socket.Write([]byte("HTTP/1.1 502 Bad Gateway\r\n\r\n"))
			}
		}
		if p.socket != nil {
			_ = p.socket.Close()
		}

	case "udp_data_response":
		s.onUdpDataResponse(&msg)
	case "net_test_progress":
		if s.NetTest != nil {
			// TS clients spread the report fields flat into the message
			// ({type,taskId,index,target,ok,ms,...}); Go clients may nest
			// them under "result". Accept both.
			var flat map[string]any
			_ = json.Unmarshal(data, &flat)
			delete(flat, "type")
			delete(flat, "taskId")
			result, _ := flat["result"].(map[string]any)
			if result == nil {
				result = flat
			}
			index := 0
			if v, ok := flat["index"].(float64); ok {
				index = int(v)
			}
			target, _ := flat["target"].(string)
			s.NetTest.HandleProgress(msg.TaskID, sess.clientID, index, target, result)
		}
	case "net_test_done":
		if s.NetTest != nil {
			s.NetTest.HandleDone(msg.TaskID, sess.clientID, msg.Error)
		}
	default:
		s.Log.Debugf("unknown client message type %q", msg.Type)
	}
}

func (sess *ClientSession) sendText(data []byte) bool {
	sess.mu.Lock()
	closed := sess.closed
	sess.mu.Unlock()
	if closed {
		return false
	}
	mux := sess.mux.Load()
	if mux == nil {
		return false
	}
	return mux.SendText(data)
}

// handleLegacyResponse completes a legacy JSON request (v1/v2 clients).
func (s *Server) handleLegacyResponse(msg *clientTextMsg) {
	p := s.Mgr.FinishRequest(msg.ID)
	if p == nil {
		return
	}
	var body []byte
	if msg.Body != "" {
		body, _ = base64.StdEncoding.DecodeString(msg.Body)
	}
	hdrs := msg.Headers
	for _, k := range []string{"transfer-encoding", "connection", "proxy-connection"} {
		delete(hdrs, k)
	}
	if msg.StatusCode >= 500 || msg.Error != "" {
		if p.client != nil {
			s.Mgr.TrackError(p.client.ID)
		}
	} else if p.client != nil {
		s.Mgr.TrackSuccess(p.client.ID)
	}
	if p.onResponse != nil {
		fn := p.onResponse
		p.onResponse = nil
		fn(map[string]any{
			"statusCode":    msg.StatusCode,
			"statusMessage": msg.StatusMessage,
			"headers":       hdrs,
		}, body)
	}
}

// handleLegacyTunnelReady completes a legacy JSON tunnel (v1/v2 clients).
func (s *Server) handleLegacyTunnelReady(sess *ClientSession, msg *clientTextMsg) {
	p := s.Mgr.PopTunnel(msg.ID)
	if p == nil || p.ready {
		return
	}
	p.ready = true
	if p.client != nil {
		s.Mgr.TrackSuccess(p.client.ID)
	}
	if p.socket != nil {
		if p.tunnelTyp == "socks5" {
			_, _ = p.socket.Write([]byte{0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
		} else {
			_, _ = p.socket.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n"))
			if len(p.head) > 0 {
				_, _ = p.socket.Write(p.head)
			}
		}
	}
	// Socket -> client (base64 over JSON - the legacy tax).
	if p.socket != nil && p.client != nil {
		id := msg.ID
		clientNode := p.client
		go func() {
			buf := make([]byte, 32*1024)
			for {
				n, err := p.socket.Read(buf)
				if n > 0 {
					payload, _ := json.Marshal(struct {
						Type string `json:"type"`
						ID   string `json:"id"`
						Data string `json:"data"`
					}{"tunnel_data", id, base64.StdEncoding.EncodeToString(buf[:n])})
					if !clientNode.WS.sendText(payload) {
						return
					}
					totalBytesUp.Add(int64(n))
				}
				if err != nil {
					closeMsg, _ := json.Marshal(struct {
						Type string `json:"type"`
						ID   string `json:"id"`
					}{"tunnel_close", id})
					_ = clientNode.WS.sendText(closeMsg)
					sess.srv.Mgr.PopTunnel(id)
					return
				}
			}
		}()
	}
}

// ---------------------------------------------------------------------------
// Mux stream dispatch (TS dispatchClientStream)
// ---------------------------------------------------------------------------

// streamHeaders is the parsed HEADERS of a client-initiated mux stream.
type streamHeaders struct {
	Type          string         `json:"type"`
	ID            any            `json:"id"`
	StatusCode    int            `json:"statusCode"`
	StatusMessage string         `json:"statusMessage"`
	Headers       map[string]any `json:"headers"`
	Message       string         `json:"message"`
	Code          string         `json:"code"`
}

// msgID resolves the id a client frame names its stream by (TS
// streamMsgId): the string form of headers.id, else the numeric stream id.
func msgID(h *streamHeaders, streamID uint32) string {
	if s, ok := h.ID.(string); ok && s != "" {
		return s
	}
	return itoa(streamID)
}

func itoa(v uint32) string {
	if v == 0 {
		return "0"
	}
	var b [10]byte
	i := len(b)
	for v > 0 {
		i--
		b[i] = byte('0' + v%10)
		v /= 10
	}
	return string(b[i:])
}

// dispatchClientStream routes one client-initiated stream (TS
// dispatchClientStream): tunnel_* frames go to pending tunnels, response to
// pending requests; anything else is an orphan and gets reset so the node
// releases it (the 2026-10-13 resurrection incident).
func (s *Server) dispatchClientStream(st *streammux.Stream) {
	var h streamHeaders
	raw, ok := st.Headers().(json.RawMessage)
	if ok {
		_ = json.Unmarshal(raw, &h)
	}
	id := msgID(&h, st.ID())

	switch h.Type {
	case "tunnel_ready":
		s.completeTunnelReady(st, id)
	case "tunnel_data":
		if p := s.Mgr.PeekTunnel(id); p != nil && p.ready && p.socket != nil {
			// Payload arrives via stream OnData registered at ready time.
			return
		}
		// Orphan or not-ready: let the recorder below handle.
		s.retireOrphan(st, h.Type)
	case "tunnel_close":
		if p := s.Mgr.PopTunnel(id); p != nil && p.socket != nil {
			_ = p.socket.Close()
		}
	case "tunnel_error":
		s.handleTunnelError(st, &h, id)
	case "response":
		s.handleMuxResponse(st, &h, id)
	default:
		s.retireOrphan(st, "unexpected")
	}
}

// completeTunnelReady is the mux path of handleTunnelReady: reply to the
// proxy client, then pipe socket <-> stream.
func (s *Server) completeTunnelReady(st *streammux.Stream, id string) {
	p := s.Mgr.PopTunnel(id)
	if p == nil {
		// Ownership first: an orphan tunnel_ready must not resurrect a stream
		// (TS dispatch ownership guard).
		st.Reset("no_pending_owner")
		return
	}
	if p.ready {
		return // idempotence guard: duplicate HEADERS delivery
	}
	p.ready = true
	if p.client != nil {
		s.Mgr.TrackSuccess(p.client.ID)
	}
	if s.Metrics != nil {
		s.Metrics.ObserveTunnel("ok")
		if !p.startTime.IsZero() {
			s.Metrics.ObserveTunnelDuration(time.Since(p.startTime).Seconds() * 1000)
		}
	}

	if p.socket != nil {
		if p.tunnelTyp == "socks5" {
			_, _ = p.socket.Write([]byte{0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
		} else {
			_, _ = p.socket.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n"))
			if len(p.head) > 0 {
				_, _ = p.socket.Write(p.head)
			}
		}
	}

	// Socket -> stream.
	if p.socket != nil {
		go func() {
			buf := make([]byte, 32*1024)
			for {
				n, err := p.socket.Read(buf)
				if n > 0 {
					if !st.SendData(buf[:n], false) {
						return
					}
					totalBytesUp.Add(int64(n))
				}
				if err != nil {
					st.Close()
					return
				}
			}
		}()
	}

	// Stream -> socket.
	st.OnData(func(chunk []byte) {
		if p.socket != nil {
			_, _ = p.socket.Write(chunk)
			totalBytesDn.Add(int64(len(chunk)))
		}
	})
	if s.Metrics != nil && p.client != nil {
		clientID := p.client.ID
		st.OnData(func(chunk []byte) { s.Metrics.ObserveBytes("down", clientID, float64(len(chunk))) })
	}
	st.OnEnd(func() {
		if p.socket != nil {
			_ = p.socket.Close() // TS ends its half; we own both halves here
		}
	})
	st.OnError(func(reason any) {
		if p.socket != nil {
			_ = p.socket.Close()
		}
	})
}

// handleTunnelError: the node answered (target-level failure), which is NOT
// node health (TS comment). Reply failure only if success never went out.
func (s *Server) handleTunnelError(st *streammux.Stream, h *streamHeaders, id string) {
	p := s.Mgr.PopTunnel(id)
	if p == nil {
		st.Reset("no_pending_owner")
		return
	}
	established := p.ready
	s.Log.Warnf("tunnel %s failed on node %s: %s (%s) established=%v", id, p.client.ID, h.Message, h.Code, established)
	if s.Metrics != nil {
		s.Metrics.ObserveTunnel("failed")
	}
	if p.socket != nil && !established {
		if p.tunnelTyp == "socks5" {
			_, _ = p.socket.Write([]byte{0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
		} else {
			_, _ = p.socket.Write([]byte("HTTP/1.1 502 Bad Gateway\r\n\r\n"))
		}
	}
	if p.socket != nil {
		_ = p.socket.Close()
	}
}

// handleMuxResponse completes an HTTP request over the mux.
func (s *Server) handleMuxResponse(st *streammux.Stream, h *streamHeaders, id string) {
	p := s.Mgr.FinishRequest(id)
	if p == nil {
		st.Reset("no_pending_owner")
		return
	}
	if p.client != nil {
		if h.StatusCode >= 500 {
			s.Mgr.TrackError(p.client.ID)
		} else {
			s.Mgr.TrackSuccess(p.client.ID)
		}
	}
	var mu sync.Mutex
	var body []byte
	done := false
	finish := func() {
		mu.Lock()
		if done {
			mu.Unlock()
			return
		}
		done = true
		payload := append([]byte(nil), body...)
		fn := p.onResponse
		p.onResponse = nil
		mu.Unlock()
		if fn != nil {
			hdrs := h.Headers
			if hdrs == nil {
				hdrs = map[string]any{}
			}
			// statusCode as float64: the HTTP handler reads map values as
			// JSON numbers; an int here silently failed the type assertion
			// and every response defaulted to 502 (found live, of course).
			fn(map[string]any{
				"statusCode":    float64(h.StatusCode),
				"statusMessage": h.StatusMessage,
				"headers":       hdrs,
			}, payload)
		}
	}
	st.OnData(func(chunk []byte) {
		mu.Lock()
		body = append(body, chunk...)
		mu.Unlock()
	})
	st.OnEnd(finish)
	st.OnError(func(any) { finish() })
}

func (s *Server) retireOrphan(st *streammux.Stream, kind string) {
	if s.Log != nil {
		s.Log.Debugf("retiring mux stream %d (%s): no pending owner", st.ID(), kind)
	}
	st.Reset("no_pending_owner")
}

// clientIPFromRequest starts from the raw peer; X-Forwarded-For is honored
// only up to the declared trusted hops (issue #117 semantics).
func clientIPFromRequest(r *http.Request, trustedHops int) string {
	ip := stripV6Mapped(r.RemoteAddr)
	if trustedHops <= 0 {
		return ip
	}
	xff := r.Header.Get("X-Forwarded-For")
	if xff == "" {
		return ip
	}
	parts := strings.Split(xff, ",")
	// rightmost trusted hops entry
	idx := len(parts) - trustedHops
	if idx < 0 {
		idx = 0
	}
	return stripV6Mapped(strings.TrimSpace(parts[idx]))
}

func stripV6Mapped(s string) string {
	if i := strings.LastIndex(s, ":"); i >= 0 && strings.Count(s, ":") >= 2 {
		s = s[i+1:]
	}
	if j := strings.LastIndex(s, "]"); j >= 0 {
		_ = j
	}
	return strings.TrimSpace(s)
}

// domainTagFor resolves the domain-rule tag for a target host ("" when none).
func (s *Server) domainTagFor(host string) string {
	if s.DomainRouter == nil {
		return ""
	}
	return s.DomainRouter.Match(host)
}

// pushConcurrencyLimit sends the current per-node limit to every connected,
// authenticated client (TS pushConcurrencyLimit): nodes apply it live and
// report the effective value in stats.
func (s *Server) pushConcurrencyLimit() {
	payload, _ := json.Marshal(struct {
		Type                  string `json:"type"`
		MaxConcurrentRequests int    `json:"maxConcurrentRequests"`
	}{"limits", s.Cfg.MaxConcurrent})
	for _, c := range s.Mgr.All() {
		if c.WS != nil {
			c.WS.sendText(payload)
		}
	}
}
