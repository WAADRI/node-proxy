package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

func timeNow() time.Time { return time.Now() }

// newTestServer boots the full server (panel API + ws + proxies) on random
// ports in a temp cwd (so runtime-overrides.json does not leak).
func newTestServer(t *testing.T) (*Server, *httptest.Server, string) {
	t.Helper()
	dir := t.TempDir()
	oldWd, _ := os.Getwd()
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(oldWd) })

	cfg := Default()
	cfg.Web.Username = "admin"
	cfg.Web.Password = "test-pw"
	cfg.HTTPProxyPort = 0
	cfg.SOCKS5Port = 0
	log := testLog{}
	srv := &Server{Cfg: cfg, Mgr: NewManager(cfg, log), Log: log}
	srv.Settings = NewSettings(srv)
	srv.Mgr.SetMetaLookup(srv.Settings.ClientMetaFor)
	srv.Settings.LoadPersisted()
	srv.Metrics = NewMetrics()
	srv.Mgr.SetErrorHook(func(id string) { srv.Metrics.ObserveError("node", id) })
	srv.ACL = NewACL()
	srv.DomainRouter = &DomainRouter{}
	srv.ProxyPasswords = &[]*ProxyPassword{}
	srv.Users = NewUserStore(cfg.Web.Username, cfg.Web.Password)
	srv.Cache = NewResponseCache(5*time.Minute, 64)
	srv.Bandwidth = NewBandwidthLimiter()
	srv.Audit = NewAuditLog(1000)
	srv.NetTest = NewNetTestManager(srv)

	mux := http.NewServeMux()
	srv.HandlePanelAPI(mux)
	mux.HandleFunc("/ws", srv.HandleClientWS)
	api := httptest.NewServer(mux)
	t.Cleanup(api.Close)
	return srv, api, dir
}

type testLog struct{}

func (testLog) Debugf(string, ...any) {}
func (testLog) Infof(string, ...any)  {}
func (testLog) Warnf(string, ...any)  {}
func (testLog) Errorf(string, ...any) {}

func login(t *testing.T, base string) string {
	t.Helper()
	res, err := http.Post(base+"/api/login", "application/json",
		bytes.NewBufferString(`{"username":"admin","password":"test-pw"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var out struct {
		Token string `json:"token"`
	}
	_ = json.NewDecoder(res.Body).Decode(&out)
	if out.Token == "" {
		t.Fatal("no token from login")
	}
	return out.Token
}

func apiCall(t *testing.T, base, token, method, path, body string) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(method, base+path, bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

// TestPanelAPIContract boots the panel API and exercises the routes the Vue
// panel calls: shape parity with web-server.ts plus 401 on missing JWT.
func TestPanelAPIContract(t *testing.T) {
	srv, api, _ := newTestServer(t)
	_ = srv

	// Unauthorized without token.
	res, err := http.Get(api.URL + "/api/status")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status without JWT = %d, want 401", res.StatusCode)
	}

	token := login(t, api.URL)

	// status shape.
	code, out := apiCall(t, api.URL, token, "GET", "/api/status", "")
	if code != 200 {
		t.Fatalf("status code = %d", code)
	}
	if _, ok := out["clients"].([]any); !ok {
		t.Fatalf("status missing clients array: %v", out)
	}
	if _, ok := out["strategy"].(string); !ok {
		t.Fatalf("status missing strategy: %v", out)
	}

	// every GET the panel makes answers 200.
	for _, path := range []string{
		"/api/logs", "/api/config", "/api/settings", "/api/tags",
		"/api/circuit-breaker/status", "/api/bandwidth/stats", "/api/traffic",
		"/api/mux/stats", "/api/users", "/api/proxy-passwords",
		"/api/domain-rules", "/api/plugins", "/api/acl/rules",
		"/api/audit/query", "/api/audit/stats", "/api/update/status",
		"/api/network-test/types",
	} {
		code, _ := apiCall(t, api.URL, token, "GET", path, "")
		if code != 200 {
			t.Errorf("GET %s = %d, want 200", path, code)
		}
	}

	// settings contract.
	code, out = apiCall(t, api.URL, token, "GET", "/api/settings", "")
	settings := out["settings"].(map[string]any)
	for _, g := range settingGroups {
		if _, ok := settings[g]; !ok {
			t.Errorf("settings missing group %s", g)
		}
	}

	// invalid strategy rejected, valid applied.
	code, _ = apiCall(t, api.URL, token, "POST", "/api/settings/routing", `{"strategy":"bogus"}`)
	if code != 400 {
		t.Fatalf("invalid strategy = %d, want 400", code)
	}
	code, _ = apiCall(t, api.URL, token, "POST", "/api/settings/routing", `{"strategy":"least-loaded"}`)
	if code != 200 {
		t.Fatalf("valid strategy = %d, want 200", code)
	}
	if srv.Mgr.Strategy() != "least-loaded" {
		t.Fatalf("strategy not applied live: %s", srv.Mgr.Strategy())
	}

	// client group applies live (max_concurrent -> config + pushed limits).
	code, _ = apiCall(t, api.URL, token, "POST", "/api/settings/client", `{"max_concurrent": 33}`)
	if code != 200 {
		t.Fatalf("client settings = %d, want 200", code)
	}
	if srv.Cfg.MaxConcurrent != 33 {
		t.Fatalf("max_concurrent not applied: %d", srv.Cfg.MaxConcurrent)
	}

	// reset restores boot value.
	code, _ = apiCall(t, api.URL, token, "POST", "/api/settings/client/reset", "")
	if code != 200 {
		t.Fatalf("reset = %d, want 200", code)
	}
	if srv.Cfg.MaxConcurrent != 100 {
		t.Fatalf("reset did not restore max_concurrent: %d", srv.Cfg.MaxConcurrent)
	}

	// unknown group -> 400.
	code, _ = apiCall(t, api.URL, token, "POST", "/api/settings/nope", `{}`)
	if code != 400 {
		t.Fatalf("unknown group = %d, want 400", code)
	}

	// proxy-passwords is real CRUD now.
	code, _ = apiCall(t, api.URL, token, "POST", "/api/proxy-passwords", `{"password":"pw-eu"}`)
	if code != 200 {
		t.Fatalf("proxy-passwords POST = %d, want 200", code)
	}
	code, out = apiCall(t, api.URL, token, "GET", "/api/proxy-passwords", "")
	if code != 200 || len(out["passwords"].([]any)) != 1 {
		t.Fatalf("proxy-passwords list = %v", out)
	}
}

// TestACLDenyAndAllow drives the ACL engine end to end through the API:
// deny rule for a domain blocks the proxy request, allow rules pass.
func TestACLDenyAndAllow(t *testing.T) {
	srv, api, _ := newTestServer(t)
	token := login(t, api.URL)

	// deny everything (wildcard via targetPort 0-65535 on http).
	code, _ := apiCall(t, api.URL, token, "POST", "/api/acl/rules",
		`{"action":"deny","priority":10,"match":{"protocol":"http","targetPort":"0-65535"}}`)
	if code != 200 {
		t.Fatalf("acl POST = %d", code)
	}

	// Simulate the proxy-path check directly (no upstream needed).
	denied := srv.ACL.Check("127.0.0.1", "example.com", "http", 80, nil)
	if denied {
		t.Fatal("ACL deny rule did not match")
	}

	// allow rule with higher priority wins.
	code, _ = apiCall(t, api.URL, token, "POST", "/api/acl/rules",
		`{"action":"allow","priority":20,"match":{"protocol":"http","targetDomain":"example\\.com"}}`)
	if code != 200 {
		t.Fatalf("acl allow POST = %d", code)
	}
	if !srv.ACL.Check("127.0.0.1", "example.com", "http", 80, nil) {
		t.Fatal("allow rule should win by priority")
	}
	if srv.ACL.Check("127.0.0.1", "other.net", "http", 80, nil) {
		t.Fatal("non-matching domain should fall to deny rule")
	}

	// hits recorded.
	_, out := apiCall(t, api.URL, token, "GET", "/api/acl/stats", "")
	if out["success"] != true {
		t.Fatalf("acl stats = %v", out)
	}
}

// TestDomainRoutingAndPasswords covers domain-rule tag resolution and
// per-password routing credentials through the API + engine.
func TestDomainRoutingAndPasswords(t *testing.T) {
	srv, api, _ := newTestServer(t)
	srv.Cfg.Proxy.Enabled = true
	srv.Cfg.Proxy.Username = "legacy"
	srv.Cfg.Proxy.Password = "legacy-pw"
	token := login(t, api.URL)

	// domain rule: *.eu.example -> tag eu
	code, _ := apiCall(t, api.URL, token, "POST", "/api/domain-rules",
		`{"pattern":"*.eu.example","tag":"eu","priority":5}`)
	if code != 200 {
		t.Fatalf("domain POST = %d", code)
	}
	if got := srv.DomainRouter.Match("node1.eu.example"); got != "eu" {
		t.Fatalf("domain match = %q, want eu", got)
	}
	if got := srv.DomainRouter.Match("other.net"); got != "" {
		t.Fatalf("domain match should be empty: %q", got)
	}

	// proxy password routed to tag us.
	code, _ = apiCall(t, api.URL, token, "POST", "/api/proxy-passwords",
		`{"password":"pw-us","tag":"us"}`)
	if code != 200 {
		t.Fatalf("password POST = %d", code)
	}

	// HTTP basic auth with the managed password resolves its route.
	req, _ := http.NewRequest("POST", "http://example", nil)
	req.SetBasicAuth("anyuser", "pw-us")
	tag, _, _, _, ok := srv.routeRequest(req, "host.example", "80", "http")
	if !ok || tag != "us" {
		t.Fatalf("password route = %q ok=%v, want us", tag, ok)
	}

	// domain tag applies when the password has no tag.
	req2, _ := http.NewRequest("POST", "http://example", nil)
	req2.SetBasicAuth("legacy", "legacy-pw")
	tag2, _, _, _, ok2 := srv.routeRequest(req2, "node1.eu.example", "80", "http")
	if !ok2 || tag2 != "eu" {
		t.Fatalf("domain route = %q ok=%v, want eu", tag2, ok2)
	}

	// wrong password rejected.
	req3, _ := http.NewRequest("POST", "http://example", nil)
	req3.SetBasicAuth("legacy", "wrong")
	if _, _, _, _, ok3 := srv.routeRequest(req3, "host.example", "80", "http"); ok3 {
		t.Fatal("bad credentials accepted")
	}
}

// TestUsersAndRoles covers the multi-role panel store and gating.
func TestUsersAndRoles(t *testing.T) {
	srv, api, _ := newTestServer(t)
	admin := login(t, api.URL)

	// create an operator and a viewer.
	code, _ := apiCall(t, api.URL, admin, "POST", "/api/users",
		`{"username":"op","password":"op-pw","role":"operator"}`)
	if code != 200 {
		t.Fatalf("user create = %d", code)
	}
	code, _ = apiCall(t, api.URL, admin, "POST", "/api/users",
		`{"username":"view","password":"view-pw","role":"viewer"}`)
	if code != 200 {
		t.Fatalf("viewer create = %d", code)
	}

	// operator can kick (needs a node first), viewer cannot.
	opRes, _ := http.Post(api.URL+"/api/login", "application/json",
		bytes.NewBufferString(`{"username":"op","password":"op-pw"}`))
	var opTok struct {
		Token string `json:"token"`
	}
	_ = json.NewDecoder(opRes.Body).Decode(&opTok)
	opRes.Body.Close()

	viewRes, _ := http.Post(api.URL+"/api/login", "application/json",
		bytes.NewBufferString(`{"username":"view","password":"view-pw"}`))
	var viewTok struct {
		Token string `json:"token"`
	}
	_ = json.NewDecoder(viewRes.Body).Decode(&viewTok)
	viewRes.Body.Close()

	srv.Mgr.Add(&ClientSession{}, map[string]any{"clientId": "n1", "hostname": "n1"})
	code, _ = apiCall(t, api.URL, opTok.Token, "POST", "/api/client/n1/kick", "")
	if code != 200 {
		t.Fatalf("operator kick = %d, want 200", code)
	}
	srv.Mgr.Add(&ClientSession{}, map[string]any{"clientId": "n2", "hostname": "n2"})
	code, _ = apiCall(t, api.URL, viewTok.Token, "POST", "/api/client/n2/kick", "")
	if code != http.StatusForbidden {
		t.Fatalf("viewer kick = %d, want 403", code)
	}

	// viewer can read status but not settings-groups it cannot edit.
	code, _ = apiCall(t, api.URL, viewTok.Token, "GET", "/api/status", "")
	if code != 200 {
		t.Fatalf("viewer status = %d, want 200", code)
	}
	code, _ = apiCall(t, api.URL, viewTok.Token, "POST", "/api/settings/routing", `{"strategy":"random"}`)
	if code != http.StatusForbidden {
		t.Fatalf("viewer settings POST = %d, want 403", code)
	}

	// deleting the last admin is refused.
	code, _ = apiCall(t, api.URL, admin, "DELETE", "/api/users/admin", "")
	if code != 400 {
		t.Fatalf("delete last admin = %d, want 400", code)
	}
}

// TestSettingsPersistenceAcrossRestart verifies hot settings survive a
// restart (runtime-overrides.json re-applied on boot).
func TestSettingsPersistenceAcrossRestart(t *testing.T) {
	dir := t.TempDir()
	oldWd, _ := os.Getwd()
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(oldWd) })

	boot := func() *Server {
		cfg := Default()
		cfg.Web.Enabled = false
		log := testLog{}
		srv := &Server{Cfg: cfg, Mgr: NewManager(cfg, log), Log: log}
		srv.Settings = NewSettings(srv)
		srv.Mgr.SetMetaLookup(srv.Settings.ClientMetaFor)
		srv.Settings.LoadPersisted()
		return srv
	}

	srv1 := boot()
	if res := srv1.Settings.Apply("routing", map[string]any{"strategy": "weighted"}, false); !res.ok {
		t.Fatalf("apply: %s", res.err)
	}
	if res := srv1.Settings.Apply("client", map[string]any{"max_concurrent": 42}, false); !res.ok {
		t.Fatalf("apply client: %s", res.err)
	}

	srv2 := boot() // "restart": same cwd, fresh state
	if got := srv2.Mgr.Strategy(); got != "weighted" {
		t.Fatalf("strategy after restart = %s, want weighted (persisted)", got)
	}
	if srv2.Cfg.MaxConcurrent != 42 {
		t.Fatalf("max_concurrent after restart = %d, want 42 (persisted)", srv2.Cfg.MaxConcurrent)
	}

	// reset on the new instance restores defaults and persists that too.
	if res := srv2.Settings.Reset("client"); !res.ok {
		t.Fatalf("reset: %s", res.err)
	}
	srv3 := boot()
	if srv3.Cfg.MaxConcurrent != 100 {
		t.Fatalf("reset did not persist: %d", srv3.Cfg.MaxConcurrent)
	}
}

// TestRoutingStrategies covers least-loaded, fastest-response, weighted.
func TestRoutingStrategies(t *testing.T) {
	srv, _, _ := newTestServer(t)
	m := srv.Mgr

	// Three synthetic clients with different load/rtt/weight.
	mk := func(id string, pending int, rtt int64, weight int) *ClientNode {
		c := &ClientNode{
			ID: id, Info: map[string]any{}, Stats: map[string]any{},
			PendingTunnels: map[string]struct{}{}, PendingRequests: map[string]struct{}{},
			RTT: rtt, Weight: weight,
		}
		for i := 0; i < pending; i++ {
			c.PendingTunnels[fmt.Sprintf("t%d", i)] = struct{}{}
		}
		m.mu.Lock()
		m.clients[id] = c
		m.mu.Unlock()
		return c
	}
	a := mk("a", 0, 100, 1)
	b := mk("b", 5, 10, 1)
	c := mk("c", 5, 5, 3)

	m.SetStrategy("least-loaded")
	for i := 0; i < 5; i++ {
		if got := m.Select("", ""); got != a {
			t.Fatalf("least-loaded picked %s, want a (0 pending)", got.ID)
		}
	}

	m.SetStrategy("fastest-response")
	for i := 0; i < 5; i++ {
		if got := m.Select("", ""); got != c {
			t.Fatalf("fastest-response picked %s, want c (rtt 5)", got.ID)
		}
	}

	m.SetStrategy("weighted")
	counts := map[string]int{}
	for i := 0; i < 400; i++ {
		counts[m.Select("", "").ID]++
	}
	if counts["c"] <= counts["a"] || counts["c"] <= counts["b"] {
		t.Fatalf("weighted distribution wrong: %v (c should dominate, weight 3)", counts)
	}

	// tag filter still applies under strategies.
	m.SetStrategy("least-loaded")
	m.mu.Lock()
	m.clients["tagged"] = &ClientNode{ID: "tagged", Info: map[string]any{}, Stats: map[string]any{},
		PendingTunnels: map[string]struct{}{}, PendingRequests: map[string]struct{}{},
		Tags: []string{"eu"}}
	m.mu.Unlock()
	for i := 0; i < 5; i++ {
		if got := m.Select("eu", ""); got.ID != "tagged" {
			t.Fatalf("tag filter picked %s, want tagged", got.ID)
		}
	}

	// breaker-open nodes are skipped.
	m.mu.Lock()
	m.breakerOpen[a.ID] = timeNow().Add(time.Hour)
	m.mu.Unlock()
	m.SetStrategy("least-loaded")
	for i := 0; i < 5; i++ {
		if got := m.Select("", ""); got == a {
			t.Fatal("breaker-open node was selected")
		}
	}
	_ = b
	_ = c
}

// TestClientMetadataRoundTrip verifies panel metadata (tags/weight/...) is
// applied live and survives re-registration.
func TestClientMetadataRoundTrip(t *testing.T) {
	srv, api, _ := newTestServer(t)
	token := login(t, api.URL)

	c := &ClientNode{ID: "node-x", Info: map[string]any{"clientId": "node-x"},
		Stats: map[string]any{}, Tags: []string{},
		PendingTunnels: map[string]struct{}{}, PendingRequests: map[string]struct{}{}}
	srv.Mgr.mu.Lock()
	srv.Mgr.clients["node-x"] = c
	srv.Mgr.mu.Unlock()

	code, _ := apiCall(t, api.URL, token, "POST", "/api/client/node-x/tags", `{"tags":["eu","fast"]}`)
	if code != 200 {
		t.Fatalf("tags POST = %d", code)
	}
	code, _ = apiCall(t, api.URL, token, "POST", "/api/client/node-x/weight", `{"weight":7}`)
	if code != 200 {
		t.Fatalf("weight POST = %d", code)
	}

	if len(c.Tags) != 2 || c.Tags[0] != "eu" || c.Weight != 7 {
		t.Fatalf("metadata not applied live: %+v w=%d", c.Tags, c.Weight)
	}

	// Re-registration re-applies the persisted metadata.
	c2 := &ClientNode{ID: "node-x", Info: map[string]any{"clientId": "node-x"},
		Stats: map[string]any{}, Tags: []string{},
		PendingTunnels: map[string]struct{}{}, PendingRequests: map[string]struct{}{}}
	srv.Mgr.Add(nil, map[string]any{"clientId": "node-x", "hostname": "node-x"})
	_ = c2
	fresh := srv.Mgr.Get("node-x")
	if fresh == nil || len(fresh.Tags) != 2 || fresh.Weight != 7 {
		t.Fatalf("metadata lost on re-registration: %+v", fresh)
	}

	// status reports the metadata.
	_, out := apiCall(t, api.URL, token, "GET", "/api/status", "")
	list := out["clients"].([]any)
	var found map[string]any
	for _, item := range list {
		m := item.(map[string]any)
		if m["id"] == "node-x" {
			found = m
		}
	}
	if found == nil {
		t.Fatal("node-x missing from status")
	}
	tags := found["tags"].([]any)
	if len(tags) != 2 || tags[0] != "eu" || found["weight"] != float64(7) {
		t.Fatalf("status metadata wrong: %v", found)
	}
	_ = net.IPv4len // keep net import if assertions change
}
