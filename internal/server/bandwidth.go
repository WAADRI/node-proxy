package server

import (
	"sync"
	"time"
)

// TokenBucket is a byte-rate limiter with burst, refill clamped against
// clock steps backwards (TS #122).
type TokenBucket struct {
	rate       float64 // bytes per second
	burst      float64
	tokens     float64
	lastRefill time.Time
}

func NewTokenBucket(rate, burst float64) *TokenBucket {
	if burst <= 0 {
		burst = rate
	}
	return &TokenBucket{rate: rate, burst: burst, tokens: burst, lastRefill: time.Now()}
}

func (b *TokenBucket) refill() {
	elapsed := time.Since(b.lastRefill).Seconds()
	if elapsed < 0 {
		elapsed = 0
	}
	b.tokens += elapsed * b.rate
	if b.tokens > b.burst {
		b.tokens = b.burst
	}
	b.lastRefill = time.Now()
}

func (b *TokenBucket) tryConsume(bytes float64) bool {
	b.refill()
	if b.tokens >= bytes {
		b.tokens -= bytes
		return true
	}
	return false
}

// BandwidthLimiter gates proxy traffic: global bucket first, then the
// per-client bucket (TS bandwidth.ts check()).
type BandwidthLimiter struct {
	mu       sync.Mutex
	enabled  bool
	defRate  float64
	defBurst float64
	gRate    float64
	gBurst   float64

	global    *TokenBucket
	buckets   map[string]*TokenBucket
	overrides map[string][2]float64 // clientId -> {rate, burst}
}

func NewBandwidthLimiter() *BandwidthLimiter {
	return &BandwidthLimiter{
		buckets:   map[string]*TokenBucket{},
		overrides: map[string][2]float64{},
	}
}

// ApplyConfig applies the settings group 'bandwidth' live (recreating the
// global bucket so rate changes take effect immediately).
func (l *BandwidthLimiter) ApplyConfig(vals map[string]any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	get := func(k string, cur float64) float64 {
		if v, ok := vals[k].(float64); ok {
			return v
		}
		return cur
	}
	if en, ok := vals["enabled"]; ok {
		l.enabled = asBool(en)
	}
	l.defRate = get("default_rate", l.defRate)
	l.defBurst = get("default_burst", l.defBurst)
	l.gRate = get("global_rate", l.gRate)
	l.gBurst = get("global_burst", l.gBurst)
	if l.gRate > 0 {
		l.global = NewTokenBucket(l.gRate, l.gBurst)
	} else {
		l.global = nil
	}
}

// SetClientOverride applies a per-node bandwidth override (panel action).
func (l *BandwidthLimiter) SetClientOverride(clientID string, rate, burst float64) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if rate <= 0 && burst <= 0 {
		delete(l.overrides, clientID)
		delete(l.buckets, clientID)
		return
	}
	l.overrides[clientID] = [2]float64{rate, burst}
	delete(l.buckets, clientID) // recreated with the new limits on next use
}

// Check consumes bytes against the global and per-client buckets. Zero or
// negative rates mean "no limit" for that scope (TS treats 0 as unlimited
// via bucket creation only when rate > 0).
func (l *BandwidthLimiter) Check(clientID string, bytes float64) bool {
	if !l.enabled {
		return true
	}
	l.mu.Lock()
	defer l.mu.Unlock()

	if l.global != nil && !l.global.tryConsume(bytes) {
		return false
	}

	rate, burst := l.defRate, l.defBurst
	if o, ok := l.overrides[clientID]; ok {
		if o[0] > 0 {
			rate = o[0]
		}
		if o[1] > 0 {
			burst = o[1]
		}
	}
	if rate <= 0 {
		return true
	}
	b := l.buckets[clientID]
	if b == nil {
		b = NewTokenBucket(rate, burst)
		l.buckets[clientID] = b
	}
	return b.tryConsume(bytes)
}

// Stats for the panel.
func (l *BandwidthLimiter) Stats() map[string]any {
	l.mu.Lock()
	defer l.mu.Unlock()
	return map[string]any{
		"enabled":       l.enabled,
		"default_rate":  l.defRate,
		"default_burst": l.defBurst,
		"global_rate":   l.gRate,
		"global_burst":  l.gBurst,
		"clients":       len(l.buckets),
	}
}
