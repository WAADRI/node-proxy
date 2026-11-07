package server

import (
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
)

// Metrics produces the Prometheus exposition with the exact metric names of
// the TS server (metrics.ts), so existing Grafana dashboards keep working.
// Hand-rolled text format - no client library dependency.
//
// Note: /metrics is public, matching the TS server (registered before its
// auth middleware) so Grafana scrapes keep working.
type Metrics struct {
	mu sync.Mutex

	requests  map[seriesKey]*counter
	bytes     map[seriesKey]*counter
	tunnels   map[seriesKey]*counter
	errors    map[seriesKey]*counter
	reqDur    map[string]*histogram // by type
	tunnelDur *histogram
	respSize  map[string]*summary // by type
}

type seriesKey struct {
	a, b string
}

type counter struct {
	v float64
}

var requestDurationBuckets = []float64{5, 10, 25, 50, 100, 250, 500, 1000, 3000, 5000, 10000, 30000}
var tunnelDurationBuckets = []float64{100, 500, 1000, 5000, 15000, 30000, 60000, 300000}

type histogram struct {
	buckets []float64
	counts  []uint64
	sum     float64
	count   uint64
}

func newHistogram(buckets []float64) *histogram {
	return &histogram{buckets: buckets, counts: make([]uint64, len(buckets))}
}

func (h *histogram) observe(v float64) {
	for i, b := range h.buckets {
		if v <= b {
			h.counts[i]++
		}
	}
	h.sum += v
	h.count++
}

// summary keeps a bounded sample ring and computes quantiles on scrape.
type summary struct {
	samples []float64
	next    int
	full    bool
}

const summaryCap = 1024

func (s *summary) observe(v float64) {
	if len(s.samples) < summaryCap {
		s.samples = append(s.samples, v)
	} else {
		s.samples[s.next] = v
		s.full = true
	}
	s.next = (s.next + 1) % summaryCap
}

func (s *summary) quantile(q float64) float64 {
	if len(s.samples) == 0 {
		return 0
	}
	sorted := append([]float64(nil), s.samples...)
	sort.Float64s(sorted)
	idx := int(q * float64(len(sorted)-1))
	return sorted[idx]
}

// NewMetrics wires an empty metrics registry.
func NewMetrics() *Metrics {
	return &Metrics{
		requests:  map[seriesKey]*counter{},
		bytes:     map[seriesKey]*counter{},
		tunnels:   map[seriesKey]*counter{},
		errors:    map[seriesKey]*counter{},
		reqDur:    map[string]*histogram{},
		tunnelDur: newHistogram(tunnelDurationBuckets),
		respSize:  map[string]*summary{},
	}
}

func (m *Metrics) counterIn(map_ map[seriesKey]*counter, a, b string, v float64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	k := seriesKey{a, b}
	c := map_[k]
	if c == nil {
		c = &counter{}
		map_[k] = c
	}
	c.v += v
}

func (m *Metrics) ObserveRequest(typ, status string, durationMS, sizeBytes float64) {
	m.counterIn(m.requests, typ, status, 1)
	m.mu.Lock()
	h := m.reqDur[typ]
	if h == nil {
		h = newHistogram(requestDurationBuckets)
		m.reqDur[typ] = h
	}
	h.observe(durationMS)
	s := m.respSize[typ]
	if s == nil {
		s = &summary{}
		m.respSize[typ] = s
	}
	s.observe(sizeBytes)
	m.mu.Unlock()
}

func (m *Metrics) ObserveBytes(direction, clientID string, n float64) {
	m.counterIn(m.bytes, direction, clientID, n)
}

func (m *Metrics) ObserveTunnel(status string) {
	m.counterIn(m.tunnels, status, "", 1)
}

func (m *Metrics) ObserveError(typ, clientID string) {
	m.counterIn(m.errors, typ, clientID, 1)
}

func (m *Metrics) ObserveTunnelDuration(durationMS float64) {
	m.mu.Lock()
	m.tunnelDur.observe(durationMS)
	m.mu.Unlock()
}

// Escape a label value per the exposition format.
func escLabel(v string) string {
	r := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`)
	return r.Replace(v)
}

// Handler serves GET /metrics.
func (m *Metrics) Handler(srv *Server) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b strings.Builder

		// Counters.
		m.mu.Lock()
		writeCounter := func(name, help string, mm map[seriesKey]*counter, la, lb string) {
			fmt.Fprintf(&b, "# HELP %s %s\n# TYPE %s counter\n", name, help, name)
			keys := make([]seriesKey, 0, len(mm))
			for k := range mm {
				keys = append(keys, k)
			}
			sort.Slice(keys, func(i, j int) bool { return keys[i].a+keys[i].b < keys[j].a+keys[j].b })
			for _, k := range keys {
				labels := ""
				if la != "" {
					labels = fmt.Sprintf(`{%s="%s"`, la, escLabel(k.a))
					if lb != "" {
						labels += fmt.Sprintf(`, %s="%s"`, lb, escLabel(k.b))
					}
					labels += "}"
				}
				fmt.Fprintf(&b, "%s%s %v\n", name, labels, mm[k].v)
			}
		}
		writeCounter("node_proxy_requests_total", "Total number of proxy requests", m.requests, "type", "status")
		writeCounter("node_proxy_bytes_total", "Total bytes transferred", m.bytes, "direction", "client_id")
		writeCounter("node_proxy_tunnels_total", "Total number of TCP tunnels", m.tunnels, "status", "")
		writeCounter("node_proxy_errors_total", "Total number of errors", m.errors, "type", "client_id")

		// Gauges computed live from the manager.
		fmt.Fprintf(&b, "# HELP node_proxy_active_clients Number of currently connected clients\n# TYPE node_proxy_active_clients gauge\n")
		clients := srv.Mgr.All()
		fmt.Fprintf(&b, "node_proxy_active_clients %d\n", len(clients))

		pendingReq, pendingTun := 0, 0
		for _, c := range clients {
			pendingReq += int(c.pendingLoad() - int64(len(c.PendingTunnels)))
			pendingTun += len(c.PendingTunnels)
		}
		fmt.Fprintf(&b, "# HELP node_proxy_active_requests Number of currently pending requests\n# TYPE node_proxy_active_requests gauge\n")
		fmt.Fprintf(&b, "node_proxy_active_requests %d\n", srv.Mgr.CountPendingRequests())

		fmt.Fprintf(&b, "# HELP node_proxy_active_tunnels Number of currently active tunnels\n# TYPE node_proxy_active_tunnels gauge\n")
		fmt.Fprintf(&b, "node_proxy_active_tunnels %d\n", srv.Mgr.CountPendingTunnels())

		fmt.Fprintf(&b, "# HELP node_proxy_client_load Per-client load (pending requests)\n# TYPE node_proxy_client_load gauge\n")
		for _, c := range clients {
			host, _ := c.Info["hostname"].(string)
			fmt.Fprintf(&b, "node_proxy_client_load{client_id=\"%s\", hostname=\"%s\"} %d\n",
				escLabel(c.ID), escLabel(host), c.pendingLoad())
		}

		fmt.Fprintf(&b, "# HELP node_proxy_client_bandwidth_bytes_per_sec Per-client bandwidth limit\n# TYPE node_proxy_client_bandwidth_bytes_per_sec gauge\n")
		bwEnabled, _ := srv.Settings.List()["bandwidth"]["enabled"].(bool)
		for _, c := range clients {
			rate := 0.0
			if bwEnabled {
				if v, ok := srv.Settings.List()["bandwidth"]["default_rate"].(float64); ok {
					rate = v
				}
			}
			fmt.Fprintf(&b, "node_proxy_client_bandwidth_bytes_per_sec{client_id=\"%s\"} %v\n", escLabel(c.ID), rate)
		}

		fmt.Fprintf(&b, "# HELP node_proxy_circuit_breaker_state Circuit breaker state (0=closed, 1=open, 2=half_open)\n# TYPE node_proxy_circuit_breaker_state gauge\n")
		breakers := srv.Mgr.BreakerStatus()
		ids := make([]string, 0, len(breakers))
		for id := range breakers {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		for _, id := range ids {
			state := 0.0
			if node, ok := breakers[id].(map[string]any); ok {
				if open, _ := node["open"].(bool); open {
					state = 1
				}
			}
			fmt.Fprintf(&b, "node_proxy_circuit_breaker_state{client_id=\"%s\"} %v\n", escLabel(id), state)
		}

		// Histograms.
		fmt.Fprintf(&b, "# HELP node_proxy_request_duration_ms Request duration in milliseconds\n# TYPE node_proxy_request_duration_ms histogram\n")
		types := make([]string, 0, len(m.reqDur))
		for t := range m.reqDur {
			types = append(types, t)
		}
		sort.Strings(types)
		for _, t := range types {
			writeHistogram(&b, "node_proxy_request_duration_ms", t, m.reqDur[t], requestDurationBuckets)
		}
		fmt.Fprintf(&b, "# HELP node_proxy_tunnel_duration_ms Tunnel duration in milliseconds\n# TYPE node_proxy_tunnel_duration_ms histogram\n")
		writeHistogram(&b, "node_proxy_tunnel_duration_ms", "", m.tunnelDur, tunnelDurationBuckets)

		// Summaries.
		fmt.Fprintf(&b, "# HELP node_proxy_response_size_bytes Response size in bytes\n# TYPE node_proxy_response_size_bytes summary\n")
		for _, t := range types {
			s := m.respSize[t]
			if s == nil {
				continue
			}
			fmt.Fprintf(&b, "node_proxy_response_size_bytes{type=\"%s\",quantile=\"0.5\"} %v\n", escLabel(t), s.quantile(0.5))
			fmt.Fprintf(&b, "node_proxy_response_size_bytes{type=\"%s\",quantile=\"0.9\"} %v\n", escLabel(t), s.quantile(0.9))
			fmt.Fprintf(&b, "node_proxy_response_size_bytes{type=\"%s\",quantile=\"0.99\"} %v\n", escLabel(t), s.quantile(0.99))
			fmt.Fprintf(&b, "node_proxy_response_size_bytes_sum{type=\"%s\"} %v\n", escLabel(t), sumOf(s.samples))
			fmt.Fprintf(&b, "node_proxy_response_size_bytes_count{type=\"%s\"} %d\n", escLabel(t), len(s.samples))
		}
		m.mu.Unlock()

		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		_, _ = w.Write([]byte(b.String()))
	}
}

func writeHistogram(b *strings.Builder, name, typ string, h *histogram, buckets []float64) {
	// Labels merge into one braces block: {type="x",le="y"} - separate brace
	// groups are invalid exposition format.
	labels := ""
	if typ != "" {
		labels = fmt.Sprintf("type=%q,", escLabel(typ))
	}
	for i, bucket := range buckets {
		fmt.Fprintf(b, "%s_bucket{%sle=\"%v\"} %d\n", name, labels, bucket, h.counts[i])
	}
	fmt.Fprintf(b, "%s_bucket{%sle=\"+Inf\"} %d\n", name, labels, h.count)
	fmt.Fprintf(b, "%s_sum{%s} %v\n", name, labels, h.sum)
	fmt.Fprintf(b, "%s_count{%s} %d\n", name, labels, h.count)
}

func sumOf(xs []float64) float64 {
	s := 0.0
	for _, v := range xs {
		s += v
	}
	return s
}
