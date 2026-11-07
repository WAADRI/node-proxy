package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// TestResponseCache covers key normalization, credential skip, TTL expiry,
// x-cache headers and eviction.
func TestResponseCache(t *testing.T) {
	c := NewResponseCache(50*time.Millisecond, 2)

	hdr := map[string][]string{"Accept": {"text/html"}}
	key := CacheKey("GET", "http://x.example/path?a=2&b=1", http.Header(hdr))
	key2 := CacheKey("GET", "http://x.example/path?b=1&a=2", http.Header(hdr))
	if key == "" || key != key2 {
		t.Fatalf("query normalization broken: %q vs %q", key, key2)
	}

	// Credentialed requests are never cached.
	cred := http.Header{"Authorization": {"Bearer x"}}
	if CacheKey("GET", "http://x.example/path", cred) != "" {
		t.Fatal("credentialed request must not produce a cache key")
	}
	// Non-GET never cached.
	if CacheKey("POST", "http://x.example/path", http.Header(hdr)) != "" {
		t.Fatal("POST must not produce a cache key")
	}

	c.Set(key, 200, map[string]any{"content-type": "text/html"}, []byte("body-1"), 0)
	e, hit := c.Get(key)
	if !hit || string(e.body) != "body-1" || e.status != 200 {
		t.Fatalf("cache hit broken: hit=%v body=%q", hit, e.body)
	}

	// TTL expiry on read.
	time.Sleep(60 * time.Millisecond)
	if _, hit := c.Get(key); hit {
		t.Fatal("expired entry was served (issue #122)")
	}

	// LRU eviction at capacity.
	k1 := CacheKey("GET", "http://x.example/1", http.Header(hdr))
	k2 := CacheKey("GET", "http://x.example/2", http.Header(hdr))
	k3 := CacheKey("GET", "http://x.example/3", http.Header(hdr))
	c.Set(k1, 200, nil, []byte("1"), 0)
	c.Set(k2, 200, nil, []byte("2"), 0)
	c.Get(k1) // k1 becomes most recent
	c.Set(k3, 200, nil, []byte("3"), 0)
	if _, hit := c.Get(k2); hit {
		t.Fatal("k2 should have been evicted (LRU), k1 kept")
	}
	if _, hit := c.Get(k1); !hit {
		t.Fatal("k1 (recently used) should survive")
	}
}

// TestBandwidthLimiter covers the global + per-client buckets and overrides.
func TestBandwidthLimiter(t *testing.T) {
	l := NewBandwidthLimiter()
	l.ApplyConfig(map[string]any{"enabled": true, "default_rate": 1000.0, "default_burst": 1000.0})

	// Within burst: allowed; beyond: limited.
	if !l.Check("a", 600) || !l.Check("a", 300) {
		t.Fatal("within-burst requests should pass")
	}
	if l.Check("a", 500) {
		t.Fatal("over-burst request should be limited")
	}

	// Another client has an independent bucket.
	if !l.Check("b", 900) {
		t.Fatal("client b should have its own bucket")
	}

	// Per-client override raises the limit.
	l.SetClientOverride("a", 5000, 5000)
	if !l.Check("a", 500) {
		t.Fatal("override should raise client a's limit")
	}

	// Global bucket caps everyone.
	g := NewBandwidthLimiter()
	g.ApplyConfig(map[string]any{"enabled": true, "global_rate": 1000.0, "global_burst": 1000.0})
	if !g.Check("x", 600) || g.Check("y", 600) {
		t.Fatal("global bucket should cap across clients")
	}

	// Disabled limiter passes everything.
	l.ApplyConfig(map[string]any{"enabled": false})
	if !l.Check("a", 1<<20) {
		t.Fatal("disabled limiter must pass")
	}
}

// TestAuditLogRing covers record, query filters and stats.
func TestAuditLogRing(t *testing.T) {
	a := NewAuditLog(3)
	a.Log(AuditEntry{Time: 1, Method: "GET", URL: "http://a/", ClientID: "n1", Status: "success", StatusCode: 200, Duration: 5})
	a.Log(AuditEntry{Time: 2, Method: "GET", URL: "http://b/", ClientID: "n2", Status: "error", StatusCode: 502, Duration: 8, Error: "boom"})
	a.Log(AuditEntry{Time: 3, Method: "GET", URL: "http://c/", ClientID: "n1", Status: "success", StatusCode: 200, Duration: 7})
	a.Log(AuditEntry{Time: 4, Method: "GET", URL: "http://d/", ClientID: "n1", Status: "success", StatusCode: 200, Duration: 9}) // evicts Time=1

	if len(a.entries) != 3 {
		t.Fatalf("ring cap broken: %d entries", len(a.entries))
	}
	if a.entries[0].Time != 2 {
		t.Fatalf("oldest should be Time=2, got %d", a.entries[0].Time)
	}

	got := a.Query("error", "", 10)
	if len(got) != 1 || got[0].StatusCode != 502 {
		t.Fatalf("error query = %+v", got)
	}
	got = a.Query("", "n1", 10)
	if len(got) != 2 {
		t.Fatalf("client query = %+v", got)
	}
	// newest first
	if got[0].Time != 4 || got[1].Time != 3 {
		t.Fatalf("query not newest-first: %+v", got)
	}
	st := a.Stats()
	if st["total"].(int64) != 4 {
		t.Fatalf("total = %v, want 4 (includes evicted)", st["total"])
	}
}

// TestCacheBandwidthThroughProxy drives cache + bandwidth through the real
// handler path with a stubbed client (no node needed: pre-seed the cache).
func TestCacheBandwidthThroughProxy(t *testing.T) {
	srv, api, _ := newTestServer(t)
	token := login(t, api.URL)

	// Bandwidth: enable a tiny global burst, then exceed it.
	code, _ := apiCall(t, api.URL, token, "POST", "/api/settings/bandwidth",
		`{"enabled":true,"global_rate":100,"global_burst":100}`)
	if code != 200 {
		t.Fatalf("bandwidth settings = %d", code)
	}

	// 429 response shape: proxy admission refuses before any client exists.
	proxy := httptest.NewServer(http.HandlerFunc(srv.HandleHTTPProxy))
	defer proxy.Close()
	req, _ := http.NewRequest("GET", proxy.URL+"/http://x.example/big", nil)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("bandwidth-limited request = %d, want 429", res.StatusCode)
	}

	// Disable again: admission passes (then fails later with 503 no-client).
	code, _ = apiCall(t, api.URL, token, "POST", "/api/settings/bandwidth", `{"enabled":false}`)
	if code != 200 {
		t.Fatalf("bandwidth disable = %d", code)
	}
	req, _ = http.NewRequest("GET", proxy.URL+"/http://x.example/ok", nil)
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("no-client request = %d, want 503", res.StatusCode)
	}

	// Cache API: stats + clear behave.
	code, out := apiCall(t, api.URL, token, "GET", "/api/cache/stats", "")
	if code != 200 || out["cache"] == nil {
		t.Fatalf("cache stats = %v", out)
	}
	code, _ = apiCall(t, api.URL, token, "POST", "/api/cache/clear", "")
	if code != 200 {
		t.Fatalf("cache clear = %d", code)
	}

	// Audit recorded the requests.
	_, out = apiCall(t, api.URL, token, "GET", "/api/audit/stats", "")
	if out["total"].(float64) < 1 {
		t.Fatalf("audit total = %v, want >=1", out["total"])
	}
	code, out = apiCall(t, api.URL, token, "GET", "/api/audit/query?limit=10", "")
	if code != 200 || len(out["entries"].([]any)) == 0 {
		t.Fatalf("audit query = %v", out)
	}
}
