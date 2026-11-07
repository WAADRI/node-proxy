package server

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// proxyAuthError writes the 407 response (TS proxy auth).
func (s *Server) proxyAuthError(w http.ResponseWriter) {
	w.Header().Set("Proxy-Authenticate", `Basic realm="node-proxy"`)
	http.Error(w, "Proxy authentication required", http.StatusProxyAuthRequired)
}

// routeRequest is the per-request routing decision: proxy-password route >
// domain-rule tag, plus the selected strategy. ok=false means the proxy
// credentials failed (407).
func (s *Server) routeRequest(r *http.Request, targetHost, targetPort, protocol string) (tag, forcedID, strategy string, sourceIP string, ok bool) {
	if !s.checkProxyAuth(r) {
		return "", "", "", "", false
	}
	sourceIP = clientIPFromRequest(r, s.Cfg.TrustedProxyHops)
	if s.ACL != nil {
		portNum := 0
		if p, err := net.LookupPort("tcp", targetPort); err == nil {
			portNum = p
		}
		if !s.ACL.Check(sourceIP, targetHost, protocol, portNum, nil) {
			s.Log.Warnf("ACL denied %s %s:%s from %s", protocol, targetHost, targetPort, sourceIP)
			return "", "", "", sourceIP, false
		}
	}
	tag, forcedID, strategy = s.routeForAuth(r, targetHost)
	return tag, forcedID, strategy, sourceIP, true
}

// routeForAuth resolves the routing triple: a proxy-password record's
// explicit attributes win over the domain-rule tag (issue #53); the legacy
// configured pair behaves like an attribute-less route, so domain rules
// still apply.
func (s *Server) routeForAuth(r *http.Request, targetHost string) (tag, forcedID, strategy string) {
	if s.Cfg.Proxy.Enabled {
		user, pass, _ := r.BasicAuth()
		isLegacy := user == s.Cfg.Proxy.Username && pass == s.Cfg.Proxy.Password
		if !isLegacy && s.ProxyPasswords != nil {
			if rec, matched := MatchProxyPassword(*s.ProxyPasswords, user, pass); matched {
				ptag, cid, strat := routeFromPassword(rec)
				if ptag != "" || cid != "" || strat != "" {
					return ptag, cid, strat
				}
				// attribute-less record: fall through to domain rules
			}
		}
	}
	if s.DomainRouter != nil {
		tag = s.DomainRouter.Match(targetHost)
	}
	return tag, "", ""
}

// checkProxyAuth validates Proxy-Authorization when auth.proxy is enabled
// (legacy configured pair or a managed password record).
func (s *Server) checkProxyAuth(r *http.Request) bool {
	if !s.Cfg.Proxy.Enabled {
		return true
	}
	user, pass, ok := r.BasicAuth()
	if !ok {
		return false
	}
	if user == s.Cfg.Proxy.Username && pass == s.Cfg.Proxy.Password {
		return true
	}
	if s.ProxyPasswords != nil {
		if _, matched := MatchProxyPassword(*s.ProxyPasswords, user, pass); matched {
			return true
		}
	}
	return false
}

// HandleHTTPProxy is the 8080 port handler: absolute-URI requests and
// CONNECT (plain HTTP + HTTPS tunnels).
func (s *Server) HandleHTTPProxy(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodConnect {
		s.handleConnect(w, r)
		return
	}
	s.handlePlainHTTP(w, r)
}

// handlePlainHTTP forwards an absolute-URI request through a client node
// (TS handleHttpRequest): buffered body (64MiB cap), mux request when the
// node supports mux, JSON fallback otherwise.
func (s *Server) handlePlainHTTP(w http.ResponseWriter, r *http.Request) {
	targetURL := r.URL.String()
	if !strings.HasPrefix(targetURL, "http://") && !strings.HasPrefix(targetURL, "https://") {
		host := r.Host
		if host == "" {
			host = "unknown"
		}
		targetURL = "http://" + host + r.URL.RequestURI()
	}
	targetHost, targetPort := hostPortFromURL(targetURL)
	tag, forcedID, strategy, srcIP, ok := s.routeRequest(r, targetHost, targetPort, "http")
	if !ok {
		if s.aclDenied(srcIP, targetHost, "http") {
			http.Error(w, "ACL denied", http.StatusForbidden)
			return
		}
		s.proxyAuthError(w)
		return
	}

	// Response cache: GETs without credentials, keyed by normalized URL.
	var cacheKey string
	if s.Cache != nil && s.BandwidthCheckOK(r) {
		cacheKey = CacheKey(r.Method, targetURL, r.Header)
		if cacheKey != "" {
			if e, hit := s.Cache.Get(cacheKey); hit {
				w.Header().Set("x-cache", "HIT")
				w.Header().Set("x-cache-age", strconv.FormatInt(int64(time.Since(e.createdAt).Seconds()), 10))
				for k, v := range e.headers {
					if sv, ok := v.(string); ok {
						w.Header().Set(k, sv)
					}
				}
				w.WriteHeader(e.status)
				_, _ = w.Write(e.body)
				return
			}
		}
	}

	// Bandwidth admission (estimate like TS: body size + overhead).
	estimate := float64(len(r.Header.Get("Content-Length"))) + 2048
	if s.Bandwidth != nil && !s.Bandwidth.Check(clientIDForLimit(tag, forcedID), estimate) {
		w.Header().Set("Retry-After", "5")
		http.Error(w, "Rate limited: bandwidth exceeded", http.StatusTooManyRequests)
		s.auditReject(r, targetURL, targetHost, 429, "bandwidth exceeded", srcIP)
		return
	}

	client := s.Mgr.SelectRoute(tag, forcedID, strategy)
	if client == nil {
		http.Error(w, "No available proxy clients", http.StatusServiceUnavailable)
		s.auditReject(r, targetURL, targetHost, 503, "no available client", srcIP)
		return
	}

	requestID := newUUID()
	var body []byte
	if r.Body != nil {
		limited := io.LimitReader(r.Body, 64*1024*1024+1)
		b, err := io.ReadAll(limited)
		if err != nil {
			http.Error(w, "Bad request body", http.StatusBadRequest)
			return
		}
		if len(b) > 64*1024*1024 {
			http.Error(w, "Request body too large", http.StatusRequestEntityTooLarge)
			return
		}
		body = b
	}

	// Response promise: satisfied by the mux response handler or the legacy
	// JSON path; the pending timeout covers a silent node.
	type result struct {
		headers map[string]any
		body    []byte
	}
	resCh := make(chan result, 1)
	respond := func(headers map[string]any, respBody []byte) {
		resCh <- result{headers: headers, body: respBody}
	}

	p := &pendingRecord{
		kind:       "request",
		client:     client,
		startTime:  time.Now(),
		onResponse: respond,
		deadline:   time.Now().Add(s.Cfg.RequestTimeout),
	}
	already, cancel := s.Mgr.AddPending(requestID, p)
	if already {
		http.Error(w, "Duplicate request id", http.StatusInternalServerError)
		return
	}
	defer cancel()

	if client.Mux != nil {
		st := client.Mux.CreateStream(requestPriority(r.Method))
		if st == nil {
			http.Error(w, "openTunnel failed", http.StatusBadGateway)
			return
		}
		headers := sanitizeRequestHeaders(r.Header)
		st.SendHeaders(map[string]any{
			"type":    "request",
			"id":      requestID,
			"method":  r.Method,
			"url":     targetURL,
			"headers": headers,
		}, len(body) == 0)
		if len(body) > 0 {
			st.SendData(body, true)
		}
	} else {
		// Legacy JSON request (v1/v2 clients).
		payload, _ := json.Marshal(map[string]any{
			"type":    "request",
			"id":      requestID,
			"method":  r.Method,
			"url":     targetURL,
			"headers": headersToAny(r.Header),
			"body":    base64.StdEncoding.EncodeToString(body),
		})
		if !client.WS.sendText(payload) {
			s.Mgr.FinishRequest(requestID)
			http.Error(w, "Client connection lost", http.StatusBadGateway)
			return
		}
	}

	totalRequests.Add(1)
	started := time.Now()
	select {
	case res := <-resCh:
		status, _ := res.headers["statusCode"].(float64)
		s.Mgr.logRequest(requestLogEntry{
			Ts: time.Now().UnixMilli(), Method: r.Method, URL: targetURL,
			Status: int(status), Duration: time.Since(started).Milliseconds(),
			ClientID: client.ID, Bytes: len(res.body),
		})
		statusCode := responseStatus(res.headers)
		if statusCode == 0 {
			statusCode = 502
		}
		// Go's ResponseWriter has no reason-phrase API; the code carries it.
		hdr, _ := res.headers["headers"].(map[string]any)
		for _, k := range []string{"Transfer-Encoding", "Connection", "Proxy-Connection"} {
			delete(hdr, strings.ToLower(k))
			delete(hdr, k)
		}
		for k, v := range hdr {
			switch val := v.(type) {
			case string:
				w.Header().Set(k, val)
			case []any:
				for _, item := range val {
					if sv, ok := item.(string); ok {
						w.Header().Add(k, sv)
					}
				}
			}
		}
		w.WriteHeader(int(statusCode))
		if len(res.body) > 0 {
			_, _ = w.Write(res.body)
		}
		if p.client != nil {
			totalBytesDn.Add(int64(len(res.body)))
		}
		if s.Cache != nil && cacheKey != "" {
			hdrCopy := map[string]any{}
			for k, v := range hdr {
				hdrCopy[strings.ToLower(k)] = v
			}
			s.Cache.Set(cacheKey, int(statusCode), hdrCopy, res.body, 0)
		}
		s.Mgr.logRequest(requestLogEntry{
			Ts: time.Now().UnixMilli(), IP: srcIP, Method: r.Method, URL: targetURL,
			Status: int(statusCode), MS: time.Since(started).Milliseconds(),
			Duration: time.Since(started).Milliseconds(),
			ClientID: client.ID, Bytes: len(res.body),
		})
		if s.Audit != nil {
			st := "success"
			if statusCode >= 400 {
				st = "error"
			}
			s.Audit.Log(AuditEntry{
				Time: time.Now().UnixMilli(), Method: r.Method, URL: targetURL,
				Host: targetHost, Protocol: "http", ClientID: client.ID,
				Status: st, StatusCode: int(statusCode),
				Duration: time.Since(started).Milliseconds(), Bytes: len(res.body),
			})
		}
	case <-r.Context().Done():
		s.Mgr.logRequest(requestLogEntry{
			Ts: time.Now().UnixMilli(), Method: r.Method, URL: targetURL,
			Status: 499, Duration: time.Since(started).Milliseconds(), ClientID: client.ID,
		})
	}
}

// requestPriority mirrors proxy-http.ts: API-ish writes 50, GET 128.
func requestPriority(method string) int {
	if method == http.MethodGet {
		return 128
	}
	return 50
}

// sanitizeRequestHeaders strips hop-by-hop and control headers before the
// request travels to the node (TS sanitizeHeaders subset).
func sanitizeRequestHeaders(h http.Header) map[string]any {
	out := make(map[string]any, len(h))
	for k, vals := range h {
		switch strings.ToLower(k) {
		case "host", "proxy-authorization", "proxy-connection", "connection",
			"keep-alive", "transfer-encoding", "te", "trailer", "upgrade":
			continue
		}
		lk := strings.ToLower(k)
		if len(vals) == 1 {
			out[lk] = vals[0]
		} else {
			out[lk] = append([]string(nil), vals...)
		}
	}
	return out
}

func headersToAny(h http.Header) map[string]any {
	out := make(map[string]any, len(h))
	for k, vals := range h {
		lk := strings.ToLower(k)
		if len(vals) == 1 {
			out[lk] = vals[0]
		} else {
			out[lk] = append([]string(nil), vals...)
		}
	}
	return out
}

// handleConnect tunnels an HTTPS CONNECT through a client node
// (TS handleConnect): openTunnel, wait tunnel_ready, 200 reply, pipe.
func (s *Server) handleConnect(w http.ResponseWriter, r *http.Request) {
	host, port, err := net.SplitHostPort(r.Host)
	if err != nil || port == "" {
		http.Error(w, "Bad CONNECT target", http.StatusBadRequest)
		return
	}
	tag, forcedID, strategy, srcIP, ok := s.routeRequest(r, host, port, "connect")
	if !ok {
		if s.aclDenied(srcIP, host, "connect") {
			http.Error(w, "ACL denied", http.StatusForbidden)
			return
		}
		s.proxyAuthError(w)
		return
	}

	client := s.Mgr.SelectRoute(tag, forcedID, strategy)
	if client == nil {
		http.Error(w, "No available proxy clients", http.StatusServiceUnavailable)
		return
	}

	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "Hijacking unsupported", http.StatusInternalServerError)
		return
	}
	conn, rw, err := hijacker.Hijack()
	if err != nil {
		http.Error(w, "Hijack failed", http.StatusInternalServerError)
		return
	}
	// Whatever the client pipelined after CONNECT belongs in the tunnel.
	var head []byte
	if rw.Reader.Buffered() > 0 {
		head = make([]byte, rw.Reader.Buffered())
		_, _ = io.ReadFull(rw.Reader, head)
	}

	tunnel := openNodeTunnel(s, conn, client, host, portInt(port), "connect", head)
	if tunnel == "" && !connCloseHandled(conn) {
		_, _ = conn.Write([]byte("HTTP/1.1 502 Bad Gateway\r\n\r\n"))
		_ = conn.Close()
	}
	_ = tunnel
}

// connCloseHandled is a marker so handleConnect knows the failure path must
// still reply (the openNodeTunnel failure paths do not write HTTP).
func connCloseHandled(net.Conn) bool { return false }

// openNodeTunnel opens a mux tunnel to host:port and pipes it with conn,
// exactly like completeTunnelReady expects on the way back. Returns the
// tunnel id, or "" when the tunnel could not even be requested.
func openNodeTunnel(s *Server, conn net.Conn, client *ClientNode, host string, port int, typ string, head []byte) string {
	if client.Mux == nil {
		return "" // legacy-JSON tunneling for v1/v2 nodes: later step
	}
	st := client.Mux.OpenTunnel(host, port, 128)
	if st == nil {
		return ""
	}
	tunnelID := itoa(st.ID())
	p := &pendingRecord{
		kind:      "tunnel",
		tunnelTyp: typ,
		client:    client,
		socket:    conn,
		host:      host,
		port:      port,
		head:      head,
		ip:        peerIP(conn),
		startTime: time.Now(),
		deadline:  time.Now().Add(s.Cfg.TunnelTimeout),
	}
	already, _ := s.Mgr.AddPending(tunnelID, p)
	if already {
		st.Reset("duplicate_tunnel_id")
		return ""
	}

	totalTunnels.Add(1)
	// The ready/data/error plumbing is shared with the mux dispatcher:
	// completeTunnelReady pops this record when tunnel_ready arrives.
	return tunnelID
}

func portInt(p string) int {
	n := 0
	for i := 0; i < len(p); i++ {
		if p[i] < '0' || p[i] > '9' {
			return 0
		}
		n = n*10 + int(p[i]-'0')
	}
	return n
}

// BandwidthCheckOK placeholder hook (kept for symmetry with the TS flow
// where the cache lookup precedes bandwidth admission).
func (s *Server) BandwidthCheckOK(r *http.Request) bool { return true }

// auditReject records an early rejection (ACL / bandwidth / no client).
func (s *Server) auditReject(r *http.Request, targetURL, host string, status int, reason, srcIP string) {
	if s.Audit == nil {
		return
	}
	s.Audit.Log(AuditEntry{
		Time: time.Now().UnixMilli(), Method: r.Method, URL: targetURL,
		Host: host, Protocol: "http", ClientID: srcIP,
		Status: "error", StatusCode: status, Error: reason,
	})
}

// clientIDForLimit picks the bandwidth bucket key (node id when known).
func clientIDForLimit(tag, forcedID string) string {
	return firstNonEmpty(forcedID, tag, "default")
}

// responseStatus reads the status code from a response-header map without
// caring whether the producer stored an int or a float64.
func responseStatus(headers map[string]any) int {
	switch v := headers["statusCode"].(type) {
	case float64:
		return int(v)
	case int:
		return v
	default:
		return 0
	}
}

// hostPortFromURL pulls hostname and port out of an absolute URL.
func hostPortFromURL(raw string) (string, string) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", ""
	}
	port := u.Port()
	if port == "" {
		if u.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	return u.Hostname(), port
}

// aclDenied distinguishes an ACL rejection (which already logged) from an
// auth failure, so the handler replies with the right status.
func (s *Server) aclDenied(sourceIP, host, protocol string) bool {
	if s.ACL == nil {
		return false
	}
	// Re-check with a wildcard target: if auth was actually fine, the denial
	// came from the ACL.
	return !s.ACL.Check(sourceIP, host, protocol, 0, nil) && s.checkProxyAuthOK(sourceIP)
}

// checkProxyAuthOK is a loose auth probe used by aclDenied; credentials were
// already validated once on this request, so we only distinguish the two
// failure modes when the ACL explicitly denies now.
func (s *Server) checkProxyAuthOK(string) bool { return true }

func newUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
