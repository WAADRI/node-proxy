package server

import (
	"context"
	"math/rand"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/WAADRI/node-proxy-go/internal/streammux"
)

// ClientNode is one registered client connection.
type ClientNode struct {
	ID     string
	WS     *ClientSession // set after registration; nil never after add()
	Mux    *streammux.Conn
	Info   map[string]any
	Tags   []string
	IP     string
	Region string
	Weight int
	Alias  string
	Notes  string
	Group  string

	Stats map[string]any // merged from 'stats' messages

	LastPong        time.Time
	RTT             int64
	PendingTunnels  map[string]struct{}
	PendingRequests map[string]struct{}

	mu sync.Mutex
}

// Snapshot returns the panel-visible view of the node (lock-safe).
func (c *ClientNode) Snapshot() map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	tags := append([]string(nil), c.Tags...)
	info := c.Info
	stats := make(map[string]any, len(c.Stats))
	for k, v := range c.Stats {
		stats[k] = v
	}
	return map[string]any{
		"tags":                 tags,
		"info":                 info,
		"stats":                stats,
		"pendingRequestsCount": len(c.PendingRequests),
		"pendingTunnelsCount":  len(c.PendingTunnels),
		"lastPong":             c.LastPong,
		"rtt":                  c.RTT,
	}
}

func (c *ClientNode) effectiveTags() []string {
	// Panel-set tags win (ClientMeta) - not implemented yet; config/env tags.
	return c.Tags
}

// pendingRecord is one in-flight tunnel or request (TS PendingRecord subset).
type pendingRecord struct {
	kind      string // "tunnel" | "request"
	tunnelTyp string // "socks5" | "connect" | ""
	client    *ClientNode
	startTime time.Time

	// tunnel
	socket  deadlineReadWriteCloser
	host    string
	port    int
	ready   bool
	head    []byte // extra bytes read after CONNECT (pipelined request start)
	ip      string // proxy client address (log column)
	sni     string // TLS server_name sniffed from the ClientHello
	logOnce sync.Once

	// request
	onResponse func(headers map[string]any, body []byte)

	deadline time.Time // 0 = none
}

type deadlineReadWriteCloser interface {
	Read([]byte) (int, error)
	Write([]byte) (int, error)
	Close() error
}

// Manager tracks registered clients and in-flight work, mirroring
// client-manager.ts (subset: registry, routing, stats, pending tables).
type Manager struct {
	cfg *Config
	log Logger

	mu              sync.Mutex
	clients         map[string]*ClientNode
	pendingTunnels  map[string]*pendingRecord
	pendingRequests map[string]*pendingRecord
	nextNum         int

	breakerErrs map[string]int
	breakerOpen map[string]time.Time

	breakerThreshold int
	breakerRecovery  time.Duration
	strategy         string
	reqLog           []requestLogEntry
	metaFor          func(string) *clientMeta
	udpAssocs        map[string]*udpAssoc
	onError          func(string)
	dailyTotals      map[string]struct {
		Sent, Recv, Requests int64
	}
	reqLogHook func(requestLogEntry)
	logSeq     int64

	idleTimeout time.Duration // tunnel idle teardown (config client.tunnel_idle_timeout default 60s)
}

// Logger is the server-side logging surface.
type Logger interface {
	Debugf(format string, args ...any)
	Infof(format string, args ...any)
	Warnf(format string, args ...any)
	Errorf(format string, args ...any)
}

func NewManager(cfg *Config, log Logger) *Manager {
	return &Manager{
		cfg:              cfg,
		log:              log,
		clients:          make(map[string]*ClientNode),
		pendingTunnels:   make(map[string]*pendingRecord),
		pendingRequests:  make(map[string]*pendingRecord),
		breakerErrs:      make(map[string]int),
		breakerOpen:      make(map[string]time.Time),
		breakerThreshold: 5,
		breakerRecovery:  30 * time.Second,
		strategy:         "random",
		reqLog:           make([]requestLogEntry, 0, requestLogCap),
		udpAssocs:        make(map[string]*udpAssoc),
		dailyTotals: make(map[string]struct {
			Sent, Recv, Requests int64
		}),
		idleTimeout: 60 * time.Second,
	}
}

// Add registers a client (TS add(): a re-registration replaces the entry).
func (m *Manager) Add(ws *ClientSession, info map[string]any) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.nextNum++
	id, _ := info["clientId"].(string)
	if id == "" {
		id = "node-" + strings.ToLower(randSuffix())
	}
	if info["hostname"] == nil {
		info["hostname"] = id
	}
	tags, _ := info["tags"].([]any)
	var tagList []string
	for _, t := range tags {
		if s, ok := t.(string); ok {
			tagList = append(tagList, s)
		}
	}
	region, _ := info["region"].(string)
	ip, _ := info["ip"].(string)

	old, existed := m.clients[id]
	node := &ClientNode{
		ID:              id,
		WS:              ws,
		Info:            info,
		Tags:            tagList,
		IP:              ip,
		Region:          region,
		Stats:           map[string]any{},
		LastPong:        time.Now(),
		PendingTunnels:  map[string]struct{}{},
		PendingRequests: map[string]struct{}{},
	}
	if existed {
		node.Stats = old.Stats
		node.RTT = old.RTT
	}
	m.clients[id] = node
	if m.log != nil && existed {
		m.log.Infof("client re-registered: %s (replacing stale session)", id)
	}
	if m.metaFor != nil {
		if meta := m.metaFor(id); meta != nil {
			node.Tags = meta.Tags
			node.Weight = meta.Weight
			node.Alias = meta.Alias
			node.Notes = meta.Notes
			node.Group = meta.Group
			if meta.Region != "" {
				node.Region = meta.Region
			}
		}
	}
	return id
}

// metaFor is wired by the Server to Settings.ClientMetaFor (panel metadata
// survives re-registrations, TS ClientMeta semantics).
func (m *Manager) SetMetaLookup(fn func(string) *clientMeta) { m.metaFor = fn }

// SetErrorHook wires the metrics error counter (called with the manager lock
// released).
func (m *Manager) SetErrorHook(fn func(string)) { m.onError = fn }

// Remove drops a registration only if this session still owns it (TS
// ownedRegistration guard).
func (m *Manager) Remove(id string, ws *ClientSession) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, ok := m.clients[id]
	if !ok || c.WS != ws {
		return
	}
	delete(m.clients, id)
	// Tear down everything this node still owed (the caller has closed the
	// session; its streams are dead).
	for key := range c.PendingTunnels {
		if p := m.pendingTunnels[key]; p != nil {
			m.failPendingLocked(p, true)
			delete(m.pendingTunnels, key)
		}
	}
	for key := range c.PendingRequests {
		if p := m.pendingRequests[key]; p != nil {
			m.abortRequestLocked(p)
			delete(m.pendingRequests, key)
		}
	}
	if m.log != nil {
		m.log.Infof("client removed: %s", id)
	}
}

func (m *Manager) Get(id string) *ClientNode {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.clients[id]
}

func (m *Manager) All() []*ClientNode {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]*ClientNode, 0, len(m.clients))
	for _, c := range m.clients {
		out = append(out, c)
	}
	return out
}

// RecordPong updates liveness/RTT for an owned registration.
func (m *Manager) RecordPong(id string, ws *ClientSession) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, ok := m.clients[id]
	if !ok || c.WS != ws {
		return false
	}
	c.LastPong = time.Now()
	return true
}

// MergeStats folds a 'stats' message into the node record.
func (m *Manager) MergeStats(id string, stats map[string]any) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if c := m.clients[id]; c != nil {
		for k, v := range stats {
			c.Stats[k] = v
		}
	}
}

// Select picks an eligible client: breaker pass, tag filter, strategy
// (m.strategy or the per-call override from a password route).
func (m *Manager) Select(tag string, forcedID string) *ClientNode {
	return m.SelectRoute(tag, forcedID, "")
}

// SelectRoute is Select with an optional per-call strategy override.
func (m *Manager) SelectRoute(tag, forcedID, strategy string) *ClientNode {
	m.mu.Lock()
	defer m.mu.Unlock()
	if forcedID != "" {
		c := m.clients[forcedID]
		if c == nil || !m.breakerAllowsLocked(forcedID) {
			return nil
		}
		return c
	}
	var candidates []*ClientNode
	for _, c := range m.clients {
		if !m.breakerAllowsLocked(c.ID) {
			continue
		}
		if tag != "" {
			match := false
			for _, t := range c.effectiveTags() {
				if strings.EqualFold(t, tag) {
					match = true
					break
				}
			}
			if !match {
				continue
			}
		}
		candidates = append(candidates, c)
	}
	if len(candidates) == 0 {
		return nil
	}
	if strategy == "" {
		strategy = m.strategy
	}
	return m.selectWith(candidates, strategy)
}

// TrackSuccess / TrackError implement a minimal circuit breaker: 5
// consecutive node-level errors open it for 30s (target-level failures such
// as tunnel_error never count - TS semantics, see handleTunnelError).
func (m *Manager) TrackSuccess(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.breakerErrs, id)
}

func (m *Manager) TrackError(id string) {
	totalErrors.Add(1)
	if m.onError != nil {
		m.onError(id)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.breakerOpen[id].After(time.Now()) {
		return
	}
	m.breakerErrs[id]++
	if m.breakerErrs[id] >= m.breakerThreshold {
		m.breakerOpen[id] = time.Now().Add(m.breakerRecovery)
		m.breakerErrs[id] = 0
		if m.log != nil {
			m.log.Warnf("circuit breaker OPEN for %s (%s)", id, m.breakerRecovery)
		}
	}
}

func (m *Manager) breakerAllowsLocked(id string) bool {
	if until, ok := m.breakerOpen[id]; ok {
		if until.After(time.Now()) {
			return false
		}
		delete(m.breakerOpen, id)
	}
	return true
}

// AddPending registers in-flight work and arms the node-level timeout.
// The returned cancel stops the timer.
func (m *Manager) AddPending(key string, p *pendingRecord) (already bool, cancel func()) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, exists := m.pendingTunnels[key]; exists {
		return true, func() {}
	}
	if _, exists := m.pendingRequests[key]; exists {
		return true, func() {}
	}
	if p.kind == "tunnel" {
		m.pendingTunnels[key] = p
		if p.client != nil {
			p.client.PendingTunnels[key] = struct{}{}
		}
	} else {
		m.pendingRequests[key] = p
		if p.client != nil {
			p.client.PendingRequests[key] = struct{}{}
		}
	}
	if !p.deadline.IsZero() {
		timer := time.AfterFunc(time.Until(p.deadline), func() {
			m.pendingTimeout(key, p)
		})
		return false, func() { timer.Stop() }
	}
	return false, func() {}
}

// pendingTimeout is the NODE-level failure path (the node never answered in
// time - target-level failures are reported by the node itself).
func (m *Manager) pendingTimeout(key string, p *pendingRecord) {
	m.mu.Lock()
	if p.kind == "tunnel" {
		if m.pendingTunnels[key] != p {
			m.mu.Unlock()
			return
		}
		delete(m.pendingTunnels, key)
	} else {
		if m.pendingRequests[key] != p {
			m.mu.Unlock()
			return
		}
		delete(m.pendingRequests, key)
	}
	if p.client != nil {
		if p.kind == "tunnel" {
			delete(p.client.PendingTunnels, key)
		} else {
			delete(p.client.PendingRequests, key)
		}
		m.TrackError(p.client.ID)
	}
	socket := p.socket
	kind := p.kind
	m.mu.Unlock()

	if kind == "tunnel" && socket != nil {
		if p.tunnelTyp == "socks5" {
			_, _ = socket.Write([]byte{0x05, 0x03, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
		} else {
			_, _ = socket.Write([]byte("HTTP/1.1 504 Gateway Timeout\r\n\r\n"))
		}
		_ = socket.Close()
	} else if kind == "request" && p.onResponse != nil {
		p.onResponse(map[string]any{"statusCode": 504, "statusMessage": "Gateway Timeout"}, []byte("Proxy request timeout"))
	}
	if p.client != nil && m.log != nil {
		m.log.Warnf("pending %s %s timed out on node %s", p.kind, key, p.client.ID)
	}
}

// PopTunnel removes and returns a pending tunnel (the handler owns it now).
func (m *Manager) PopTunnel(key string) *pendingRecord {
	m.mu.Lock()
	defer m.mu.Unlock()
	p := m.pendingTunnels[key]
	if p == nil {
		return nil
	}
	delete(m.pendingTunnels, key)
	if p.client != nil {
		delete(p.client.PendingTunnels, key)
	}
	return p
}

// PeekTunnel checks ownership without removing (dispatch order matters).
func (m *Manager) PeekTunnel(key string) *pendingRecord {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.pendingTunnels[key]
}

func (m *Manager) PeekRequest(key string) *pendingRecord {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.pendingRequests[key]
}

// FinishRequest removes a completed request and clears the timer ownership.
func (m *Manager) FinishRequest(key string) *pendingRecord {
	m.mu.Lock()
	defer m.mu.Unlock()
	p := m.pendingRequests[key]
	if p == nil {
		return nil
	}
	delete(m.pendingRequests, key)
	if p.client != nil {
		delete(p.client.PendingRequests, key)
	}
	return p
}

// failPendingLocked closes the socket of a pending record without replying
// success (used when the node connection dies mid-flight).
func (m *Manager) failPendingLocked(p *pendingRecord, nodeFailure bool) {
	if p.socket != nil {
		if nodeFailure && !p.ready {
			if p.tunnelTyp == "socks5" {
				_, _ = p.socket.Write([]byte{0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
			} else {
				_, _ = p.socket.Write([]byte("HTTP/1.1 502 Bad Gateway\r\n\r\n"))
			}
		}
		_ = p.socket.Close()
	}
}

func (m *Manager) abortRequestLocked(p *pendingRecord) {
	if p.onResponse != nil {
		fn := p.onResponse
		p.onResponse = nil
		go fn(map[string]any{"statusCode": 502, "statusMessage": "Bad Gateway"}, []byte("node disconnected"))
	}
}

// Counters for the panel (TS clientManager.stats shape, subset).
var (
	totalRequests atomic.Int64
	totalTunnels  atomic.Int64
	totalBytesUp  atomic.Int64
	totalBytesDn  atomic.Int64
	totalErrors   atomic.Int64
	startTime     = time.Now()
)

func randSuffix() string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, 8)
	for i := range b {
		b[i] = chars[rand.Intn(len(chars))]
	}
	return string(b)
}

// ---------------------------------------------------------------------------
// Routing strategies + request log (panel-facing extras)
// ---------------------------------------------------------------------------

// SetStrategy switches the routing strategy live (settings group 'routing').
func (m *Manager) SetStrategy(strategy string) {
	m.mu.Lock()
	m.strategy = strategy
	m.mu.Unlock()
	if m.log != nil {
		m.log.Infof("routing strategy set to %s", strategy)
	}
}

// Strategy reports the current routing strategy.
func (m *Manager) Strategy() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.strategy
}

// BreakerConfig is the live circuit-breaker configuration.
type BreakerConfig struct {
	ErrorThreshold      int
	WindowMS            int
	RecoveryTimeoutMS   int
	HalfOpenMaxAttempts int
}

// UpdateBreakerConfig applies new breaker thresholds (settings group
// 'circuit_breaker').
func (m *Manager) UpdateBreakerConfig(vals map[string]any) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if v, ok := vals["error_threshold"].(float64); ok {
		m.breakerThreshold = int(v)
	}
	if v, ok := vals["recovery_timeout_ms"].(float64); ok {
		m.breakerRecovery = time.Duration(v) * time.Millisecond
	}
	// window_ms / half_open_max_attempts shape the sliding-window breaker;
	// the minimal consecutive-error breaker notes them for parity.
	if m.log != nil {
		m.log.Infof("circuit breaker config updated")
	}
}

// BreakerStatus reports per-node breaker state for the panel.
func (m *Manager) BreakerStatus() map[string]any {
	m.mu.Lock()
	defer m.mu.Unlock()
	nodes := map[string]any{}
	for id := range m.clients {
		if until, ok := m.breakerOpen[id]; ok && until.After(time.Now()) {
			nodes[id] = map[string]any{"open": true, "recoverAt": until.UnixMilli()}
			continue
		}
		nodes[id] = map[string]any{"open": false, "consecutiveErrors": m.breakerErrs[id]}
	}
	return nodes
}

// ResetBreaker clears the breaker state for one node (panel button).
func (m *Manager) ResetBreaker(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.breakerErrs, id)
	delete(m.breakerOpen, id)
}

// selectWith mirrors router.ts strategies over breaker-passing candidates.
func (m *Manager) selectWith(candidates []*ClientNode, strategy string) *ClientNode {
	if len(candidates) == 0 {
		return nil
	}
	switch strategy {
	case "least-loaded":
		best := candidates[0]
		minLoad := int64(1 << 62)
		for _, c := range candidates {
			load := c.pendingLoad()
			if load < minLoad {
				minLoad = load
				best = c
			}
		}
		return best
	case "fastest-response":
		best := candidates[0]
		bestRTT := int64(1 << 62)
		for _, c := range candidates {
			rtt := c.RTT
			if rtt < bestRTT {
				bestRTT = rtt
				best = c
			}
		}
		return best
	case "weighted":
		total := 0
		for _, c := range candidates {
			w := c.Weight
			if w <= 0 {
				w = 1
			}
			total += w
		}
		r := rand.Intn(total)
		for _, c := range candidates {
			w := c.Weight
			if w <= 0 {
				w = 1
			}
			r -= w
			if r < 0 {
				return c
			}
		}
		return candidates[len(candidates)-1]
	default:
		return candidates[rand.Intn(len(candidates))]
	}
}

// pendingLoad is the node's own occupancy report (TS clientLoad).
func (c *ClientNode) pendingLoad() int64 {
	return int64(len(c.PendingTunnels) + len(c.PendingRequests))
}

// requestLog is a bounded newest-appended ring of proxy request records.
type requestLogEntry struct {
	Seq      int64  `json:"seq"` // monotonic id; the panel dedupes/merges on it
	Ts       int64  `json:"ts"`  // epoch ms (the panel renders row.ts)
	IP       string `json:"ip,omitempty"`
	Method   string `json:"method"`
	URL      string `json:"url"`
	SNI      string `json:"sni,omitempty"`
	Status   int    `json:"status"`
	MS       int64  `json:"ms"` // panel column name (same value as Duration)
	Duration int64  `json:"duration"`
	ClientID string `json:"clientId,omitempty"`
	Bytes    int    `json:"bytes,omitempty"`
}

// logTunnel records one finished tunnel (TS recordTunnelLog): method carries
// the listener (SOCKS5 vs CONNECT), status stays 0, sni from the ClientHello.
func (m *Manager) logTunnel(p *pendingRecord) {
	p.logOnce.Do(func() {
		end := time.Now()
		m.logRequest(requestLogEntry{
			Ts:       end.UnixMilli(),
			IP:       p.ip,
			Method:   tunnelMethodName(p.tunnelTyp),
			URL:      p.host + ":" + strconv.Itoa(p.port),
			SNI:      p.sni,
			Status:   0,
			MS:       end.Sub(p.startTime).Milliseconds(),
			ClientID: tunnelClientID(p),
		})
	})
}

func tunnelMethodName(typ string) string {
	if typ == "socks5" {
		return "SOCKS5"
	}
	return "CONNECT"
}

func tunnelClientID(p *pendingRecord) string {
	if p.client != nil {
		return p.client.ID
	}
	return ""
}

const requestLogCap = 500

func (m *Manager) logRequest(e requestLogEntry) {
	m.mu.Lock()
	m.logSeq++
	e.Seq = m.logSeq
	if len(m.reqLog) >= requestLogCap {
		m.reqLog = m.reqLog[1:]
	}
	m.reqLog = append(m.reqLog, e)
	fn := m.reqLogHook
	m.mu.Unlock()
	if fn != nil {
		fn(e)
	}
}

// OnRequestLog registers a live-feed hook (the panel WebSocket broadcast).
func (m *Manager) OnRequestLog(fn func(requestLogEntry)) {
	m.mu.Lock()
	m.reqLogHook = fn
	m.mu.Unlock()
}

// RecentRequests returns up to limit entries, oldest first (the API layer
// reverses for newest-first rendering, mirroring TS).
func (m *Manager) RecentRequests(limit int) []requestLogEntry {
	m.mu.Lock()
	defer m.mu.Unlock()
	if limit <= 0 || limit > len(m.reqLog) {
		limit = len(m.reqLog)
	}
	out := make([]requestLogEntry, limit)
	copy(out, m.reqLog[len(m.reqLog)-limit:])
	return out
}

// trafficSample records one periodic sample; per-day deltas accumulate into
// dailyTotals so the panel chart shows real series (in-memory; restarts
// reset history - the storage module will persist when it lands).
func (m *Manager) StartTrafficSampler(ctx context.Context) {
	t := time.NewTicker(30 * time.Second)
	go func() {
		var lastUp, lastDn, lastReq int64
		for {
			select {
			case <-ctx.Done():
				t.Stop()
				return
			case <-t.C:
				m.mu.Lock()
				up := totalBytesUp.Load()
				dn := totalBytesDn.Load()
				req := totalRequests.Load()
				dUp, dDn, dReq := up-lastUp, dn-lastDn, req-lastReq
				if dUp < 0 {
					dUp = 0
				}
				if dDn < 0 {
					dDn = 0
				}
				if dReq < 0 {
					dReq = 0
				}
				lastUp, lastDn, lastReq = up, dn, req
				day := time.Now().Format("2006-01-02")
				cur := m.dailyTotals[day]
				cur.Sent += dUp
				cur.Recv += dDn
				cur.Requests += dReq
				m.dailyTotals[day] = cur
				m.mu.Unlock()
			}
		}
	}()
}

// TrafficSeries builds the /api/traffic payload: daily buckets for the last
// N days (current day live), today's numbers and grand totals.
func (m *Manager) TrafficSeries(days int, clientID string) map[string]any {
	type dayPoint struct {
		Date          string `json:"date"`
		BytesSent     int64  `json:"bytesSent"`
		BytesReceived int64  `json:"bytesReceived"`
		Requests      int64  `json:"requests,omitempty"`
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	daily := make([]dayPoint, 0, days)
	today := dayPoint{}
	now := time.Now()
	for i := days - 1; i >= 0; i-- {
		date := now.AddDate(0, 0, -i).Format("2006-01-02")
		p := dayPoint{Date: date}
		if agg, ok := m.dailyTotals[date]; ok {
			p.BytesSent, p.BytesReceived, p.Requests = agg.Sent, agg.Recv, agg.Requests
		}
		if i == 0 {
			today = p
		}
		daily = append(daily, p)
	}
	totals := map[string]any{
		"bytesSent":     totalBytesUp.Load(),
		"bytesReceived": totalBytesDn.Load(),
		"requests":      totalRequests.Load(),
	}
	_ = clientID
	return map[string]any{
		"days":     days,
		"clientId": nilIfEmpty(clientID),
		"today":    map[string]any{"bytesSent": today.BytesSent, "bytesReceived": today.BytesReceived},
		"daily":    daily,
		"totals":   totals,
	}
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// UDP association registry (TS clientManager.udpAssociations).
func (m *Manager) AddUDPAssoc(a *udpAssoc) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.udpAssocs[a.id] = a
}

func (m *Manager) GetUDPAssoc(id string) *udpAssoc {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.udpAssocs[id]
}

func (m *Manager) RemoveUDPAssoc(id string) {
	m.mu.Lock()
	a := m.udpAssocs[id]
	delete(m.udpAssocs, id)
	m.mu.Unlock()
	if a != nil {
		_ = a.udp.Close()
	}
}

// CountPendingRequests / CountPendingTunnels for the metrics gauges.
func (m *Manager) CountPendingRequests() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.pendingRequests)
}

func (m *Manager) CountPendingTunnels() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.pendingTunnels)
}
