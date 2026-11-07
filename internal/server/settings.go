package server

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"sync"
	"time"
)

// Settings is the runtime-adjustable whitelist (TS settings.ts): five groups,
// applied live, persisted so they survive restarts, resettable to boot values.
// This is the "配置热重载" surface - no plugin-style extensions, by design.
type Settings struct {
	mu   sync.Mutex
	srv  *Server
	path string // runtime-overrides.json

	base    map[string]map[string]any // boot-time values
	current map[string]map[string]any // live values
	clients map[string]*clientMeta    // per-client panel metadata
}

// RuntimeStore is the on-disk persistence shape (runtime-overrides.json):
// hot settings plus panel-managed rules and accounts.
type RuntimeStore struct {
	Settings       map[string]map[string]any `json:"settings"`
	Clients        map[string]*clientMeta    `json:"clients"`
	ACLRules       []*AclRule                `json:"aclRules,omitempty"`
	DomainRules    []domainRule              `json:"domainRules,omitempty"`
	ProxyPasswords []*ProxyPassword          `json:"proxyPasswords,omitempty"`
	Users          []*PanelUser              `json:"users,omitempty"`
}

type clientMeta struct {
	Tags   []string `json:"tags,omitempty"`
	Group  string   `json:"group,omitempty"`
	Weight int      `json:"weight,omitempty"`
	Alias  string   `json:"alias,omitempty"`
	Notes  string   `json:"notes,omitempty"`
	Region string   `json:"region,omitempty"`
}

// Groups in the panel order (TS GROUPS).
var settingGroups = []string{"routing", "circuit_breaker", "bandwidth", "client", "cache"}

var routingStrategies = []string{"random", "least-loaded", "fastest-response", "weighted"}

// NewSettings builds the runtime settings whitelist for a server.
func NewSettings(srv *Server) *Settings {
	s := &Settings{
		srv:     srv,
		base:    map[string]map[string]any{},
		current: map[string]map[string]any{},
		clients: map[string]*clientMeta{},
	}
	cfg := srv.Cfg
	s.base["routing"] = map[string]any{"strategy": "random"}
	s.base["circuit_breaker"] = map[string]any{
		"error_threshold": 5, "window_ms": 60000, "recovery_timeout_ms": 30000, "half_open_max_attempts": 3,
	}
	s.base["bandwidth"] = map[string]any{"enabled": false, "default_rate": 0, "default_burst": 0, "global_rate": 0, "global_burst": 0}
	// Values are float64 throughout: every code path that reads the current
	// map (applyClientSettings, JSON marshaling) speaks JSON numbers.
	s.base["client"] = map[string]any{
		"request_timeout":     float64(cfg.RequestTimeout.Milliseconds()),
		"tunnel_timeout":      float64(cfg.TunnelTimeout.Milliseconds()),
		"tunnel_idle_timeout": float64(60000),
		"max_concurrent":      float64(cfg.MaxConcurrent),
	}
	s.base["cache"] = map[string]any{"default_ttl": 300000}
	for g, m := range s.base {
		cp := map[string]any{}
		for k, v := range m {
			cp[k] = v
		}
		s.current[g] = cp
	}
	return s
}

// overridesPath resolves the persistence file next to the main config
// (CONFIG_PATH dir or cwd).
func overridesPath() string {
	if p := findConfigFile(); p != "" {
		if i := lastSep(p); i >= 0 {
			return p[:i+1] + "runtime-overrides.json"
		}
	}
	return "runtime-overrides.json"
}

// LoadPersisted re-applies saved overrides on boot (hot settings survive
// restarts) and loads client metadata.
func (st *Settings) LoadPersisted() {
	st.path = overridesPath()
	data, err := os.ReadFile(st.path)
	if err != nil {
		return
	}
	var disk RuntimeStore
	if json.Unmarshal(data, &disk) != nil {
		st.srv.Log.Warnf("runtime-overrides.json unreadable, ignoring: %s", st.path)
		return
	}
	for g, vals := range disk.Settings {
		if _, ok := st.current[g]; !ok {
			continue
		}
		if res := st.Apply(g, vals, true); !res.ok {
			st.srv.Log.Warnf("persisted setting %s rejected: %s", g, res.err)
		}
	}
	for id, meta := range disk.Clients {
		if meta != nil {
			st.clients[id] = meta
		}
	}
	if st.srv.ACL != nil && disk.ACLRules != nil {
		st.srv.ACL.SetRules(disk.ACLRules)
	}
	if st.srv.DomainRouter != nil && disk.DomainRules != nil {
		st.srv.DomainRouter.SetRules(disk.DomainRules)
	}
	if st.srv.ProxyPasswords != nil && disk.ProxyPasswords != nil {
		*st.srv.ProxyPasswords = disk.ProxyPasswords
	}
	if st.srv.Users != nil && len(disk.Users) > 0 {
		st.srv.Users.ReplaceAll(disk.Users)
	}
}

func (st *Settings) persist() {
	disk := RuntimeStore{Settings: st.current, Clients: st.clients}
	if st.srv.ACL != nil {
		disk.ACLRules = st.srv.ACL.Rules()
	}
	if st.srv.DomainRouter != nil {
		disk.DomainRules = st.srv.DomainRouter.Rules()
	}
	if st.srv.ProxyPasswords != nil {
		disk.ProxyPasswords = *st.srv.ProxyPasswords
	}
	if st.srv.Users != nil {
		disk.Users = st.srv.Users.List()
	}
	data, err := json.MarshalIndent(disk, "", "  ")
	if err == nil {
		_ = os.WriteFile(st.path, data, 0o600)
	}
}

type applyResult struct {
	ok  bool
	err string
}

// Apply validates and applies one group of values live.
func (st *Settings) Apply(group string, values map[string]any, silent bool) applyResult {
	st.mu.Lock()
	defer st.mu.Unlock()
	known := false
	for _, g := range settingGroups {
		if g == group {
			known = true
			break
		}
	}
	if !known {
		return applyResult{false, "Unknown settings group: " + group}
	}
	cur := st.current[group]

	switch group {
	case "routing":
		strategy, _ := values["strategy"].(string)
		strategy = trimSpace(strategy)
		valid := false
		for _, s := range routingStrategies {
			if s == strategy {
				valid = true
				break
			}
		}
		if !valid {
			return applyResult{false, "Invalid strategy. Choose one of: " + joinStrategies()}
		}
		cur["strategy"] = strategy
		st.srv.Mgr.SetStrategy(strategy)

	case "circuit_breaker":
		nums, err := st.numFields(values, cur, []string{"error_threshold", "window_ms", "recovery_timeout_ms", "half_open_max_attempts"}, 1)
		if err != "" {
			return applyResult{false, err}
		}
		for k, v := range nums {
			cur[k] = v
		}
		st.srv.Mgr.UpdateBreakerConfig(nums)

	case "bandwidth":
		patch, err := st.numFields(values, cur, []string{"default_rate", "default_burst", "global_rate", "global_burst"}, 0)
		if err != "" {
			return applyResult{false, err}
		}
		if en, ok := values["enabled"]; ok {
			patch["enabled"] = asBool(en)
		}
		for k, v := range patch {
			cur[k] = v
		}
		if st.srv.Bandwidth != nil {
			st.srv.Bandwidth.ApplyConfig(cur)
		}

	case "client":
		patch, err := st.numFields(values, cur, []string{"request_timeout", "tunnel_timeout", "tunnel_idle_timeout", "max_concurrent"}, 1)
		if err != "" {
			return applyResult{false, err}
		}
		if len(patch) == 0 {
			return applyResult{false, "No valid numeric fields provided"}
		}
		for k, v := range patch {
			cur[k] = v
		}
		st.applyClientSettings(cur)

	case "cache":
		nums, err := st.numFields(values, cur, []string{"default_ttl"}, 0)
		if err != "" {
			return applyResult{false, err}
		}
		if nums["default_ttl"] == nil {
			return applyResult{false, "default_ttl is required"}
		}
		for k, v := range nums {
			cur[k] = v
		}
		if st.srv.Cache != nil {
			if ttl, ok := nums["default_ttl"].(float64); ok {
				st.srv.Cache.SetDefaultTTL(ttl)
			}
		}
	}

	if !silent {
		st.srv.Log.Infof("runtime settings updated: %s", group)
	}
	st.persist()
	return applyResult{true, ""}
}

// applyClientSettings pushes the client-group values into the live config
// and out to every connected node (TS pushConcurrencyLimit).
func (st *Settings) applyClientSettings(cur map[string]any) {
	cfg := st.srv.Cfg
	if v, ok := cur["request_timeout"].(float64); ok {
		cfg.RequestTimeout = msToDuration(v)
	}
	if v, ok := cur["tunnel_timeout"].(float64); ok {
		cfg.TunnelTimeout = msToDuration(v)
	}
	if v, ok := cur["max_concurrent"].(float64); ok {
		cfg.MaxConcurrent = int(v)
	}
	st.srv.pushConcurrencyLimit()
}

// Reset restores a group to its boot-time value.
func (st *Settings) Reset(group string) applyResult {
	st.mu.Lock()
	defer st.mu.Unlock()
	base, ok := st.base[group]
	if !ok {
		return applyResult{false, "Unknown settings group: " + group}
	}
	cp := map[string]any{}
	for k, v := range base {
		cp[k] = v
	}
	st.current[group] = cp
	if group == "routing" {
		st.srv.Mgr.SetStrategy(cp["strategy"].(string))
	}
	if group == "circuit_breaker" {
		nums := map[string]any{}
		for _, k := range []string{"error_threshold", "window_ms", "recovery_timeout_ms", "half_open_max_attempts"} {
			nums[k] = cp[k]
		}
		st.srv.Mgr.UpdateBreakerConfig(nums)
	}
	if group == "client" {
		st.applyClientSettings(cp)
	}
	st.persist()
	return applyResult{true, ""}
}

// List returns the live values of every group.
func (st *Settings) List() map[string]map[string]any {
	st.mu.Lock()
	defer st.mu.Unlock()
	out := map[string]map[string]any{}
	for g, m := range st.current {
		cp := map[string]any{}
		for k, v := range m {
			cp[k] = v
		}
		out[g] = cp
	}
	return out
}

// ClientMetaFor returns (and lazily creates) panel metadata for a client id.
func (st *Settings) ClientMetaFor(id string) *clientMeta {
	st.mu.Lock()
	defer st.mu.Unlock()
	m := st.clients[id]
	if m == nil {
		m = &clientMeta{}
		st.clients[id] = m
	}
	return m
}

func (st *Settings) SaveClientMeta() {
	st.mu.Lock()
	defer st.mu.Unlock()
	st.persist()
}

// SaveRuntime persists panel-managed rules/accounts (called by the API layer
// after mutating them).
func (st *Settings) SaveRuntime() { st.SaveClientMeta() }

func (st *Settings) numFields(values, cur map[string]any, fields []string, minValue float64) (map[string]any, string) {
	out := map[string]any{}
	for _, f := range fields {
		raw, present := values[f]
		if !present || raw == nil {
			continue
		}
		n, ok := toFloat(raw)
		if !ok || n < minValue {
			return nil, fmt.Sprintf("Invalid %s: must be a number >= %v", f, minValue)
		}
		out[f] = n
	}
	return out, ""
}

func toFloat(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case int:
		return float64(n), true
	case string:
		f, err := strconv.ParseFloat(trimSpace(n), 64)
		return f, err == nil
	default:
		return 0, false
	}
}

func asBool(v any) bool {
	switch b := v.(type) {
	case bool:
		return b
	case string:
		return b == "true" || b == "1"
	default:
		return false
	}
}

func trimSpace(s string) string {
	start, end := 0, len(s)
	for start < end && (s[start] == ' ' || s[start] == '\t') {
		start++
	}
	for end > start && (s[end-1] == ' ' || s[end-1] == '\t') {
		end--
	}
	return s[start:end]
}

func msToDuration(v float64) time.Duration { return time.Duration(v) * time.Millisecond }

func joinStrategies() string {
	out := ""
	for i, s := range routingStrategies {
		if i > 0 {
			out += ", "
		}
		out += s
	}
	return out
}
