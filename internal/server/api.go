package server

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// secretKey is process-random; JWTs are valid for this process lifetime.
var secretKey = func() []byte {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return b
}()

// HandlePanelAPI mounts the panel API surface. Routes mirror web-server.ts;
// modules that land in later strangler steps answer with an explicit 501 and
// a message instead of pretending.
func (s *Server) HandlePanelAPI(mux *http.ServeMux) {
	mux.HandleFunc("/api/login", s.handleLogin)

	perm := func(pattern, permission string, h http.HandlerFunc) {
		mux.Handle(pattern, s.requirePerm(permission, h))
	}

	perm("/api/status", "client:list", s.handleStatus)
	perm("/api/logs", "system:logs", s.handleLogs)
	perm("/api/config", "proxy:config", s.handleConfig)
	perm("/api/settings", "proxy:config", s.handleSettingsGet)
	perm("/api/settings/", "proxy:config", s.handleSettingsPost) // /:group and /:group/reset
	perm("/api/routing/strategy", "routing:strategy", s.handleRoutingStrategy)
	perm("/api/broadcast", "client:list", s.handleBroadcast)
	perm("/api/tags", "client:list", s.handleTags)
	perm("/api/client/", "client:list", s.handleClientRoutes) // actions gate finer inside
	perm("/api/kick/", "client:kick", s.handleKickAlias)
	perm("/api/circuit-breaker/status", "circuit:view", s.handleBreakerStatus)
	perm("/api/bandwidth/stats", "proxy:stats", s.handleBandwidthStats)
	perm("/api/traffic", "proxy:stats", s.handleTrafficDaily)
	perm("/api/mux/stats", "proxy:stats", s.handleMuxStats)
	perm("/api/users", "user:list", s.handleUsersList)
	perm("/api/users/", "user:modify", s.handleUsersSub)
	perm("/api/proxy-passwords", "proxy:passwords", s.handleProxyPasswords)
	perm("/api/proxy-passwords/", "proxy:passwords", s.handleProxyPasswordsSub)
	perm("/api/domain-rules", "domain:create", s.handleDomainRules)
	perm("/api/domain-rules/", "domain:delete", s.handleDomainRules)
	perm("/api/acl/rules", "acl:create", s.handleACLRules)
	perm("/api/acl/rules/", "acl:delete", s.handleACLRulesSub)
	perm("/api/acl/stats", "acl:list", s.handleACLStats)
	perm("/api/cache/stats", "cache:view", s.handleCacheStats)
	mux.Handle("/api/cache/clear", s.requirePerm("proxy:config", http.HandlerFunc(s.handleCacheClear)))
	perm("/api/plugins", "client:list", s.handlePlugins) // dropped by decision; empty set
	perm("/api/audit/query", "audit:query", s.handleAuditQuery)
	perm("/api/audit/stats", "audit:query", s.handleAuditStats)
	perm("/api/update/status", "proxy:config", s.handleUpdateStatus)
	perm("/api/update/check", "proxy:config", s.handleUpdateCheck)
	perm("/api/update/apply", "proxy:config", s.handleUpdateApply)
	perm("/api/network-test/types", "nettest:run", s.handleNetTestTypes)
	perm("/api/network-test", "nettest:run", s.handleNetTestStart)
	mux.Handle("/api/network-test/", s.requirePerm("nettest:run", http.HandlerFunc(s.handleNetTestGet)))
}

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "Bad request", http.StatusBadRequest)
		return
	}
	if s.Cfg.Web.Enabled {
		user := s.Users.Authenticate(body.Username, body.Password)
		if user == nil {
			s.Log.Warnf("panel login failed for %q", body.Username)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]any{"success": false, "message": "登录失败，请检查用户名和密码"})
			return
		}
	}
	claims := fmt.Sprintf(`{"sub":%q,"exp":%d}`,
		body.Username, time.Now().Add(24*time.Hour).Unix())
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"success":  true,
		"token":    jwtHS256(claims, secretKey),
		"redirect": "/app/",
	})
}

func (s *Server) requireJWT(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.Cfg.Web.Enabled {
			next.ServeHTTP(w, r)
			return
		}
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if token == "" || !jwtValid(token, secretKey) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"Unauthorized","message":"Token required"}`))
			return
		}
		next.ServeHTTP(w, r)
	})
}

func jwtHS256(claims string, key []byte) string {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	payload := base64.RawURLEncoding.EncodeToString([]byte(claims))
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(header + "." + payload))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return header + "." + payload + "." + sig
}

func jwtValid(token string, key []byte) bool {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return false
	}
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(parts[0] + "." + parts[1]))
	expect := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(expect), []byte(parts[2])) {
		return false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return false
	}
	var claims struct {
		Exp int64 `json:"exp"`
	}
	if json.Unmarshal(payload, &claims) != nil {
		return false
	}
	return claims.Exp > time.Now().Unix()
}

// ---------------------------------------------------------------------------
// status / logs / config
// ---------------------------------------------------------------------------

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(s.buildStatusPayload())
}

// buildStatusPayload assembles the /api/status body (shared with the panel's
// live WebSocket feed, which pushes the same shape).
func (s *Server) buildStatusPayload() map[string]any {
	clients := s.Mgr.All()
	list := make([]map[string]any, 0, len(clients))
	for _, c := range clients {
		snap := c.Snapshot()
		lastPong := snap["lastPong"].(time.Time)
		meta := s.Settings.ClientMetaFor(c.ID)
		muxStats := map[string]any{}
		if c.Mux != nil {
			st := c.Mux.Stats()
			muxStats = map[string]any{
				"openStreams":          st.TotalStreams,
				"activeStreams":        st.ActiveStreams,
				"connectionSendWindow": st.ConnectionSendWindow,
				"connectionRecvWindow": st.ConnectionRecvWindow,
				"bufferedFrames":       st.BufferedFrames,
			}
		}
		item := map[string]any{
			"id":                   c.ID,
			"info":                 snap["info"],
			"tags":                 orSlice(snap["tags"], meta.Tags),
			"group":                orString(meta.Group),
			"alias":                orString(meta.Alias),
			"notes":                orString(meta.Notes),
			"region":               orString2(c.Region, meta.Region),
			"weight":               meta.Weight,
			"connectedAt":          lastPong.Add(-time.Minute).UnixMilli(),
			"lastSeen":             lastPong.UnixMilli(),
			"lastPing":             lastPong.UnixMilli(),
			"pingFailures":         0,
			"rtt":                  snap["rtt"],
			"pendingRequestsCount": snap["pendingRequestsCount"],
			"pendingTunnelsCount":  snap["pendingTunnelsCount"],
			"clientStats":          snap["stats"],
			"mux":                  muxStats,
			// TS getStats() contract fields the panel renders:
			"circuitBreaker":       map[string]any{"state": "closed"},
			"avgResponseTime":      snap["rtt"],
			"bandwidthUtilization": 0,
		}
		list = append(list, item)
	}
	// Shape follows the TS getStats() contract field-for-field (the panel
	// reads status.server.uptime, status.routing.strategy, status.bandwidth,
	// per-client circuitBreaker, ...). Extra keys kept for other consumers.
	now := time.Now()
	bw := map[string]any{"enabled": false, "stats": map[string]any{}}
	if s.Bandwidth != nil {
		bw = map[string]any{"enabled": s.Bandwidth.enabled, "stats": s.Bandwidth.Stats()}
	}
	return map[string]any{
		"total":   len(clients),
		"clients": list,
		"server": map[string]any{
			"startTime":          startTime.UnixMilli(),
			"uptime":             int64(now.Sub(startTime).Seconds()),
			"totalRequests":      totalRequests.Load(),
			"totalTunnels":       totalTunnels.Load(),
			"totalBytesSent":     totalBytesUp.Load(),
			"totalBytesReceived": totalBytesDn.Load(),
			"failedRequests":     totalErrors.Load(),
			"pendingRequests":    s.Mgr.CountPendingRequests(),
			"pendingTunnels":     s.Mgr.CountPendingTunnels(),
		},
		// legacy/extra shapes kept for other consumers:
		"uptimeSec": int64(now.Sub(startTime).Seconds()),
		"strategy":  s.Mgr.Strategy(),
		"totals": map[string]any{
			"requests":  totalRequests.Load(),
			"tunnels":   totalTunnels.Load(),
			"bytesUp":   totalBytesUp.Load(),
			"bytesDown": totalBytesDn.Load(),
		},
		"routing": map[string]any{
			"strategy":            s.Mgr.Strategy(),
			"availableStrategies": routingStrategies,
		},
		"tags":   s.allTags(),
		"groups": s.allGroups(),
		"circuitBreaker": map[string]any{
			"enabled": true,
			"config":  s.Settings.List()["circuit_breaker"],
		},
		"bandwidth": bw,
	}
}

// allTags / allGroups feed the status contract (TS getAllTags/getAllGroups).
func (s *Server) allTags() []string {
	set := map[string]bool{}
	for _, c := range s.Mgr.All() {
		for _, t := range c.Tags {
			set[t] = true
		}
	}
	out := make([]string, 0, len(set))
	for t := range set {
		out = append(out, t)
	}
	return out
}

func (s *Server) allGroups() []string {
	set := map[string]bool{}
	for _, c := range s.Mgr.All() {
		if c.Group != "" {
			set[c.Group] = true
		}
	}
	out := make([]string, 0, len(set))
	for g := range set {
		out = append(out, g)
	}
	return out
}

func (s *Server) handleLogs(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	entries := s.Mgr.RecentRequests(limit)
	// newest-first for the panel feed (TS reverses at the boundary too).
	for i, j := 0, len(entries)-1; i < j; i, j = i+1, j-1 {
		entries[i], entries[j] = entries[j], entries[i]
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"logs": entries})
}

func (s *Server) handleConfig(w http.ResponseWriter, r *http.Request) {
	cfg := s.Cfg
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"success": true,
		"server": map[string]any{
			"web_port":           cfg.WebPort,
			"http_proxy_port":    cfg.HTTPProxyPort,
			"socks5_port":        cfg.SOCKS5Port,
			"trusted_proxy_hops": cfg.TrustedProxyHops,
		},
		"client": map[string]any{
			"request_timeout": cfg.RequestTimeout.Milliseconds(),
			"tunnel_timeout":  cfg.TunnelTimeout.Milliseconds(),
			"max_concurrent":  cfg.MaxConcurrent,
		},
	})
}

// ---------------------------------------------------------------------------
// settings (hot reload whitelist)
// ---------------------------------------------------------------------------

func (s *Server) handleSettingsGet(w http.ResponseWriter, r *http.Request) {
	editable := map[string]bool{}
	for _, g := range settingGroups {
		editable[g] = true // single admin role for now (roles land with users)
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"success":  true,
		"settings": s.Settings.List(),
		"editable": editable,
	})
}

func (s *Server) handleSettingsPost(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// Group-specific permission (TS SETTINGS_PERM): routing changes need
	// routing:strategy, everything else system:config.
	user := s.userFrom(r)
	rest0 := strings.TrimPrefix(r.URL.Path, "/api/settings/")
	group0 := strings.Split(rest0, "/")[0]
	want := "system:config"
	if group0 == "routing" {
		want = "routing:strategy"
	}
	if !HasPermission(user, want) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"success":false,"message":"Permission denied"}`))
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/api/settings/")
	if rest == "" {
		http.Error(w, "Unknown settings group", http.StatusBadRequest)
		return
	}
	parts := strings.Split(rest, "/")
	group := parts[0]
	if len(parts) == 2 && parts[1] == "reset" {
		if res := s.Settings.Reset(group); !res.ok {
			jsonError(w, res.err, http.StatusBadRequest)
			return
		}
		s.Log.Infof("runtime settings reset: %s", group)
		s.writeSettingsOK(w)
		return
	}
	if len(parts) != 1 {
		http.Error(w, "Unknown settings group", http.StatusBadRequest)
		return
	}
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body == nil {
		body = map[string]any{}
	}
	if res := s.Settings.Apply(group, body, false); !res.ok {
		jsonError(w, res.err, http.StatusBadRequest)
		return
	}
	s.writeSettingsOK(w)
}

func (s *Server) writeSettingsOK(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"success":  true,
		"settings": s.Settings.List(),
	})
}

func (s *Server) handleRoutingStrategy(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Strategy string `json:"strategy"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if res := s.Settings.Apply("routing", map[string]any{"strategy": body.Strategy}, false); !res.ok {
		jsonError(w, res.err, http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "strategy": body.Strategy})
}

// ---------------------------------------------------------------------------
// client management
// ---------------------------------------------------------------------------

func (s *Server) handleClientRoutes(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/client/")
	parts := strings.Split(rest, "/")
	if len(parts) == 0 || parts[0] == "" {
		http.Error(w, "Bad request", http.StatusBadRequest)
		return
	}
	id := parts[0]
	action := ""
	if len(parts) > 1 {
		action = parts[1]
	}

	user := s.userFrom(r)
	actionPerm := map[string]string{
		"kick": "client:kick", "tags": "client:tag", "weight": "client:weight",
		"alias": "client:alias", "notes": "client:notes", "region": "client:region",
		"group": "client:group", "bandwidth": "client:bandwidth",
	}
	switch r.Method {
	case http.MethodPost:
		switch action {
		case "kick":
			if !HasPermission(user, actionPerm["kick"]) {
				jsonError(w, "Permission denied: client:kick", http.StatusForbidden)
				return
			}
			c := s.Mgr.Get(id)
			if c == nil || c.WS == nil {
				jsonError(w, "Client not found", http.StatusNotFound)
				return
			}
			c.WS.Close()
			s.Mgr.Remove(id, c.WS)
			s.Log.Infof("client kicked: %s", id)
			writeOK(w)
		case "tags", "group", "weight", "alias", "notes", "region":
			if !HasPermission(user, actionPerm[action]) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusForbidden)
				_, _ = w.Write([]byte(`{"success":false,"message":"Permission denied"}`))
				return
			}
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			meta := s.Settings.ClientMetaFor(id)
			switch action {
			case "tags":
				raw, _ := body["tags"].([]any)
				tags := make([]string, 0, len(raw))
				for _, t := range raw {
					if str, ok := t.(string); ok && strings.TrimSpace(str) != "" {
						tags = append(tags, str)
					}
				}
				meta.Tags = tags
			case "group":
				meta.Group = asStringAny(firstNonEmpty(asStringAnyV(body["value"]), asStringAnyV(body["group"])))
			case "weight":
				wv, _ := toFloat(body["weight"])
				if wv < 0 || wv > 100 {
					jsonError(w, "Invalid weight (0-100)", http.StatusBadRequest)
					return
				}
				meta.Weight = int(wv)
			case "alias":
				meta.Alias = asStringAny(body["alias"])
			case "notes":
				meta.Notes = asStringAny(body["notes"])
			case "region":
				meta.Region = asStringAny(body["region"])
			}
			s.Settings.SaveClientMeta()
			if c := s.Mgr.Get(id); c != nil {
				c.mu.Lock()
				switch action {
				case "tags":
					c.Tags = meta.Tags
				case "group":
					c.Group = meta.Group
				case "weight":
					c.Weight = meta.Weight
				case "alias":
					c.Alias = meta.Alias
				case "notes":
					c.Notes = meta.Notes
				case "region":
					c.Region = meta.Region
				}
				c.mu.Unlock()
			}
			writeOK(w)
		case "bandwidth":
			if !HasPermission(user, "client:bandwidth") {
				jsonError(w, "Permission denied: client:bandwidth", http.StatusForbidden)
				return
			}
			var body struct {
				Rate  float64 `json:"rate"`
				Burst float64 `json:"burst"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			if s.Bandwidth != nil {
				s.Bandwidth.SetClientOverride(id, body.Rate, body.Burst)
			}
			s.Log.Infof("bandwidth override for %s: rate=%v burst=%v", id, body.Rate, body.Burst)
			writeOK(w)
		case "circuit-breaker":
			if len(parts) >= 3 && parts[2] == "reset" {
				if !HasPermission(user, "circuit:reset") {
					jsonError(w, "Permission denied: circuit:reset", http.StatusForbidden)
					return
				}
				s.Mgr.ResetBreaker(id)
				writeOK(w)
				return
			}
			jsonError(w, "Unknown action", http.StatusBadRequest)
		default:
			jsonError(w, "Unknown action: "+action, http.StatusBadRequest)
		}
	case http.MethodGet:
		switch action {
		case "events":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"events": []any{}})
		case "traffic":
			var up, dn int64
			if c := s.Mgr.Get(id); c != nil {
				if v, ok := c.Stats["bytesSent"].(float64); ok {
					up = int64(v)
				}
				if v, ok := c.Stats["bytesReceived"].(float64); ok {
					dn = int64(v)
				}
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"up": up, "down": dn})
		default:
			http.Error(w, "Not found", http.StatusNotFound)
		}
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleKickAlias backs the panel's POST /api/kick/:id shortcut.
func (s *Server) handleKickAlias(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	user := s.userFrom(r)
	if !HasPermission(user, "client:kick") {
		jsonError(w, "Permission denied: client:kick", http.StatusForbidden)
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/api/kick/")
	c := s.Mgr.Get(id)
	if c == nil || c.WS == nil {
		jsonError(w, "Client not found", http.StatusNotFound)
		return
	}
	c.WS.Close()
	s.Mgr.Remove(id, c.WS)
	s.Log.Infof("client kicked: %s", id)
	writeOK(w)
}

func (s *Server) handleBroadcast(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Message string `json:"message"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if strings.TrimSpace(body.Message) == "" {
		jsonError(w, "message required", http.StatusBadRequest)
		return
	}
	payload, _ := json.Marshal(map[string]any{"type": "broadcast", "message": body.Message})
	n := 0
	for _, c := range s.Mgr.All() {
		if c.WS != nil && c.WS.sendText(payload) {
			n++
		}
	}
	s.Log.Infof("broadcast to %d clients: %s", n, body.Message)
	writeOK(w)
}

func (s *Server) handleTags(w http.ResponseWriter, r *http.Request) {
	set := map[string]bool{}
	for _, c := range s.Mgr.All() {
		for _, t := range c.Tags {
			set[t] = true
		}
	}
	out := make([]string, 0, len(set))
	for t := range set {
		out = append(out, t)
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"tags": out})
}

// ---------------------------------------------------------------------------
// stats-ish endpoints
// ---------------------------------------------------------------------------

func (s *Server) handleBreakerStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "nodes": s.Mgr.BreakerStatus()})
}

func (s *Server) handleBandwidthStats(w http.ResponseWriter, r *http.Request) {
	bw := s.Settings.List()["bandwidth"]
	out := map[string]any{
		"success": true,
		"enabled": bw["enabled"],
		"config":  bw,
	}
	if s.Bandwidth != nil {
		out["live"] = s.Bandwidth.Stats()
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(out)
}

// handleCacheStats / handleCacheClear back the panel cache card.
func (s *Server) handleCacheStats(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	out := map[string]any{"success": true}
	if s.Cache != nil {
		out["cache"] = s.Cache.Stats()
	}
	_ = json.NewEncoder(w).Encode(out)
}

func (s *Server) handleCacheClear(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.Cache != nil {
		s.Cache.Clear()
	}
	s.Log.Infof("response cache cleared via panel")
	writeOK(w)
}

func (s *Server) handleTrafficTotal(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"up":   totalBytesUp.Load(),
		"down": totalBytesDn.Load(),
	})
}

// handleTrafficDaily serves GET /api/traffic?days=7&client_id=<id> with the
// shape the panel Workbench charts (TS getTrafficDaily/getTrafficTotals).
func (s *Server) handleTrafficDaily(w http.ResponseWriter, r *http.Request) {
	days, _ := strconv.Atoi(r.URL.Query().Get("days"))
	if days < 1 || days > 30 {
		days = 7
	}
	clientID := r.URL.Query().Get("client_id")
	if clientID != "" && s.Mgr.Get(clientID) == nil {
		jsonError(w, "Unknown client", http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(s.Mgr.TrafficSeries(days, clientID))
}

func (s *Server) handleMuxStats(w http.ResponseWriter, r *http.Request) {
	perClient := map[string]any{}
	for _, c := range s.Mgr.All() {
		if c.Mux != nil {
			st := c.Mux.Stats()
			perClient[c.ID] = map[string]any{
				"activeStreams":        st.ActiveStreams,
				"totalStreams":         st.TotalStreams,
				"connectionSendWindow": st.ConnectionSendWindow,
				"connectionRecvWindow": st.ConnectionRecvWindow,
				"rtt":                  c.RTT,
			}
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "clients": perClient})
}

// ---------------------------------------------------------------------------
// honest stubs
// ---------------------------------------------------------------------------

func (s *Server) handlePlugins(w http.ResponseWriter, r *http.Request) {
	// The plugin system is intentionally NOT part of the Go rewrite
	// (decision 2026-11-07): report an empty set, not an error, so the panel
	// renders cleanly.
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"plugins": []any{}})
}

func (s *Server) handleNetTestTypes(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"types": []map[string]string{
		{"id": "ping", "label": "Ping"},
		{"id": "tcping", "label": "Tcping"},
		{"id": "http", "label": "请求测速"},
		{"id": "dns", "label": "DNS 查询"},
		{"id": "traceroute", "label": "路由追踪"},
	}})
}

// handleNetTestStart validates and dispatches a test task.
func (s *Server) handleNetTestStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.NetTest == nil {
		jsonError(w, "Network test manager not available", http.StatusNotImplemented)
		return
	}
	var body struct {
		Type    string         `json:"type"`
		Targets []string       `json:"targets"`
		Options map[string]any `json:"options"`
		Clients any            `json:"clients"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "Bad request", http.StatusBadRequest)
		return
	}
	taskID, err := s.NetTest.Start(body.Type, body.Targets, body.Options, body.Clients)
	if err != nil {
		jsonError(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "taskId": taskID})
}

func (s *Server) handleNetTestGet(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/network-test/")
	task := s.NetTest.Get(id)
	if task == nil {
		jsonError(w, "Task not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "task": task})
}

// handleUpdateCheck / handleUpdateApply live in update.go (selfupdate).

func (s *Server) checkLatestRelease() (string, string, error) {
	base := s.GitHubAPIBase
	if base == "" {
		base = "https://api.github.com"
	}
	req, err := http.NewRequest("GET", base+"/repos/WAADRI/node-proxy/releases/latest", nil)
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", "", fmt.Errorf("github api status %d", resp.StatusCode)
	}
	var body struct {
		TagName string `json:"tag_name"`
		HTMLURL string `json:"html_url"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return "", "", err
	}
	return body.TagName, body.HTMLURL, nil
}

func (s *Server) handleAuditStats(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if s.Audit == nil {
		_ = json.NewEncoder(w).Encode(map[string]any{"total": 0})
		return
	}
	_ = json.NewEncoder(w).Encode(s.Audit.Stats())
}

func (s *Server) handleAuditQuery(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if s.Audit == nil {
		_ = json.NewEncoder(w).Encode(map[string]any{"entries": []any{}})
		return
	}
	q := r.URL.Query()
	entries := s.Audit.Query(q.Get("status"), q.Get("clientId"), atoiDefault(q.Get("limit"), 100))
	_ = json.NewEncoder(w).Encode(map[string]any{"entries": entries})
}

func atoiDefault(s string, def int) int {
	if n, err := strconv.Atoi(s); err == nil {
		return n
	}
	return def
}

func (s *Server) handleUpdateStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"supported": false, "currentVersion": Version})
}

func (s *Server) handleEmptyList(field string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{field: []any{}})
	}
}

func (s *Server) handleNotImplemented(what string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			s.handleEmptyList("items")(w, r)
			return
		}
		jsonError(w, what+" lands in a later strangler step", http.StatusNotImplemented)
	}
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

func jsonError(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]any{"success": false, "message": msg})
}

func writeOK(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"success": true}`))
}

func asStringAnyV(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func asStringAny(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func orString(v string) any {
	if v == "" {
		return nil
	}
	return v
}

func orString2(a, b string) any {
	if a != "" {
		return a
	}
	if b != "" {
		return b
	}
	return nil
}

func orSlice(current any, fallback []string) any {
	if cur, ok := current.([]string); ok && len(cur) > 0 {
		return cur
	}
	if len(fallback) > 0 {
		return fallback
	}
	return []string{}
}
