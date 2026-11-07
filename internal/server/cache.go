package server

import (
	"container/list"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

// ResponseCache is the proxy GET cache (TS cache.ts): keyed by method +
// normalized URL + Accept, credentialed requests never cached, TTL checked on
// read (issue #122), LRU by access order, entries capped.
type ResponseCache struct {
	mu         sync.Mutex
	enabled    bool
	defaultTTL time.Duration
	maxEntries int
	entries    map[string]*cacheEntry
	lru        *list.List // front = most recent
	hits       int64
	misses     int64
}

type cacheEntry struct {
	key       string
	status    int
	headers   map[string]any
	body      []byte
	createdAt time.Time
	ttl       time.Duration
	hits      int64
	elem      *list.Element
}

func NewResponseCache(defaultTTL time.Duration, maxEntries int) *ResponseCache {
	if maxEntries <= 0 {
		maxEntries = 256
	}
	return &ResponseCache{
		enabled:    true,
		defaultTTL: defaultTTL,
		maxEntries: maxEntries,
		entries:    map[string]*cacheEntry{},
		lru:        list.New(),
	}
}

// CacheKey builds the cache key (TS makeKey): GET only, skip credentialed
// requests (Cookie / Authorization), normalized URL with sorted query params,
// Accept folded in for content negotiation. Returns "" when uncachable.
func CacheKey(method, rawURL string, header httpHeader) string {
	if method != "GET" {
		return ""
	}
	for _, name := range []string{"Authorization", "Cookie"} {
		if header.Get(name) != "" {
			return ""
		}
	}
	u, err := url.Parse(rawURL)
	if err != nil || u.Host == "" {
		return ""
	}
	q := u.Query()
	keys := make([]string, 0, len(q))
	for k := range q {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var sorted strings.Builder
	for i, k := range keys {
		if i > 0 {
			sorted.WriteString("&")
		}
		sorted.WriteString(k)
		sorted.WriteString("=")
		sorted.WriteString(q.Get(k))
	}
	scheme := "http"
	if u.Scheme == "https" {
		scheme = "https"
	}
	return "GET:" + scheme + "://" + u.Host + u.Path + "?" + sorted.String() + ":" + header.Get("Accept")
}

// httpHeader is the minimal header surface CacheKey needs (satisfied by
// http.Header; keeps the cache package-free of handler types).
type httpHeader interface {
	Get(name string) string
}

// Get returns a live entry or nil (expired entries are dropped on sight).
func (c *ResponseCache) Get(key string) (*cacheEntry, bool) {
	if !c.enabled || key == "" {
		return nil, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	e := c.entries[key]
	if e == nil {
		c.misses++
		return nil, false
	}
	ttl := e.ttl
	if ttl <= 0 {
		ttl = c.defaultTTL
	}
	if ttl > 0 && time.Since(e.createdAt) > ttl {
		delete(c.entries, key)
		c.lru.Remove(e.elem)
		c.misses++
		return nil, false
	}
	e.hits++
	c.hits++
	c.lru.MoveToFront(e.elem)
	return e, true
}

// Set stores a response, evicting LRU entries beyond capacity.
func (c *ResponseCache) Set(key string, status int, headers map[string]any, body []byte, ttl time.Duration) {
	if !c.enabled || key == "" || status >= 400 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if old := c.entries[key]; old != nil {
		c.lru.Remove(old.elem)
		delete(c.entries, key)
	}
	e := &cacheEntry{
		key: key, status: status, headers: headers,
		body:      append([]byte(nil), body...),
		createdAt: time.Now(), ttl: ttl,
	}
	e.elem = c.lru.PushFront(e)
	c.entries[key] = e
	for len(c.entries) > c.maxEntries {
		oldest := c.lru.Back()
		if oldest == nil {
			break
		}
		oe := oldest.Value.(*cacheEntry)
		c.lru.Remove(oldest)
		delete(c.entries, oe.key)
	}
}

// Clear drops every entry.
func (c *ResponseCache) Clear() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries = map[string]*cacheEntry{}
	c.lru.Init()
}

// SetDefaultTTL applies the settings group 'cache' live.
func (c *ResponseCache) SetDefaultTTL(ms float64) {
	c.mu.Lock()
	c.defaultTTL = time.Duration(ms) * time.Millisecond
	c.mu.Unlock()
}

// Stats for the panel.
func (c *ResponseCache) Stats() map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	return map[string]any{
		"enabled":     c.enabled,
		"entries":     len(c.entries),
		"hits":        c.hits,
		"misses":      c.misses,
		"default_ttl": c.defaultTTL.Milliseconds(),
		"max_entries": c.maxEntries,
	}
}
