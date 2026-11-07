package server

import (
	"net"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// AclRule mirrors the TS AclRule shape: first matching enabled rule wins,
// its action decides; no matching rule (or no rules at all) allows.
type AclRule struct {
	ID          string   `json:"id"`
	Action      string   `json:"action"` // "allow" | "deny"
	Priority    int      `json:"priority"`
	Description string   `json:"description"`
	Match       AclMatch `json:"match"`
	Enabled     bool     `json:"enabled"`
	Hits        int64    `json:"hits"`
}

// AclMatch carries the rule conditions; empty condition = wildcard.
type AclMatch struct {
	SourceIP     string `json:"sourceIp,omitempty"`     // CIDR or comma-separated CIDRs
	TargetDomain string `json:"targetDomain,omitempty"` // regex
	TargetIP     string `json:"targetIp,omitempty"`     // CIDR list
	TargetPort   string `json:"targetPort,omitempty"`   // "80", "80-90", "53,80"
	Protocol     string `json:"protocol,omitempty"`     // http|https|connect|socks5|udp|any
	ClientTag    string `json:"clientTag,omitempty"`    // comma-separated tags
	TimeStart    string `json:"timeStart,omitempty"`    // "HH:MM"
	TimeEnd      string `json:"timeEnd,omitempty"`
}

type compiledRule struct {
	rule        *AclRule
	sourceNets  []*net.IPNet
	domainRe    *regexp.Regexp
	targetNets  []*net.IPNet
	ports       []portRange
	timeStartHM int
	timeEndHM   int
	hasTime     bool
}

type portRange struct {
	lo, hi int
}

// ACL is the rule engine (TS acl.ts subset: priority order, first match
// decides, cache omitted - Go evaluation is cheap).
type ACL struct {
	mu       sync.RWMutex
	rules    []*AclRule
	compiled []*compiledRule
	enabled  bool
}

func NewACL() *ACL { return &ACL{enabled: true} }

// SetRules replaces the rule set (persisted via the runtime store).
func (a *ACL) SetRules(rules []*AclRule) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.rules = rules
	a.compiled = compileRules(rules)
}

func (a *ACL) Rules() []*AclRule {
	a.mu.RLock()
	defer a.mu.RUnlock()
	out := make([]*AclRule, len(a.rules))
	copy(out, a.rules)
	return out
}

func (a *ACL) SetEnabled(v bool) { a.mu.Lock(); a.enabled = v; a.mu.Unlock() }
func (a *ACL) Enabled() bool     { a.mu.RLock(); defer a.mu.RUnlock(); return a.enabled }

// Check evaluates the chain. protocol is http|https|connect|socks5|udp.
func (a *ACL) Check(sourceIP, targetHost, protocol string, targetPort int, clientTags []string) bool {
	a.mu.RLock()
	defer a.mu.RUnlock()
	if !a.enabled || len(a.compiled) == 0 {
		return true
	}
	var targetIP net.IP
	if targetHost != "" {
		targetIP = net.ParseIP(targetHost)
	}
	now := time.Now()
	nowHM := now.Hour()*100 + now.Minute()

	for _, cr := range a.compiled {
		m := &cr.rule.Match
		if m.SourceIP != "" {
			if sourceIP == "" || !inAnyCIDR(sourceIP, cr.sourceNets) {
				continue
			}
		}
		if m.TargetDomain != "" {
			if targetHost == "" || cr.domainRe == nil || !cr.domainRe.MatchString(strings.ToLower(targetHost)) {
				continue
			}
		}
		if m.TargetIP != "" {
			if targetIP == nil || !inAnyCIDR(targetIP.String(), cr.targetNets) {
				continue
			}
		}
		if m.TargetPort != "" && targetPort > 0 {
			if !portInRange(targetPort, cr.ports) {
				continue
			}
		}
		if m.Protocol != "" && !strings.EqualFold(m.Protocol, "any") {
			if !strings.EqualFold(protocol, m.Protocol) {
				continue
			}
		}
		if m.ClientTag != "" {
			matched := false
			for _, want := range strings.Split(m.ClientTag, ",") {
				want = strings.TrimSpace(want)
				for _, have := range clientTags {
					if strings.EqualFold(want, have) {
						matched = true
						break
					}
				}
				if matched {
					break
				}
			}
			if !matched {
				continue
			}
		}
		if cr.hasTime {
			if nowHM < cr.timeStartHM || nowHM > cr.timeEndHM {
				continue
			}
		}
		// All specified conditions matched.
		cr.rule.Hits++
		return cr.rule.Action == "allow"
	}
	return true
}

func compileRules(rules []*AclRule) []*compiledRule {
	sorted := append([]*AclRule(nil), rules...)
	// stable sort by priority desc (higher priority first)
	for i := 1; i < len(sorted); i++ {
		for j := i; j > 0 && sorted[j].Priority > sorted[j-1].Priority; j-- {
			sorted[j], sorted[j-1] = sorted[j-1], sorted[j]
		}
	}
	out := make([]*compiledRule, 0, len(sorted))
	for _, r := range sorted {
		cr := &compiledRule{rule: r}
		if r.Match.SourceIP != "" {
			cr.sourceNets = parseCIDRs(r.Match.SourceIP)
		}
		if r.Match.TargetDomain != "" {
			if re, err := regexp.Compile("(?i)" + r.Match.TargetDomain); err == nil {
				cr.domainRe = re
			}
		}
		if r.Match.TargetIP != "" {
			cr.targetNets = parseCIDRs(r.Match.TargetIP)
		}
		if r.Match.TargetPort != "" {
			cr.ports = parsePorts(r.Match.TargetPort)
		}
		if r.Match.TimeStart != "" && r.Match.TimeEnd != "" {
			if sh, ok1 := parseHM(r.Match.TimeStart); ok1 {
				if eh, ok2 := parseHM(r.Match.TimeEnd); ok2 {
					cr.timeStartHM, cr.timeEndHM = sh, eh
					cr.hasTime = true
				}
			}
		}
		out = append(out, cr)
	}
	return out
}

func parseCIDRs(list string) []*net.IPNet {
	var out []*net.IPNet
	for _, part := range strings.Split(list, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if !strings.Contains(part, "/") {
			if ip := net.ParseIP(part); ip != nil {
				bits := 32
				if ip.To4() == nil {
					bits = 128
				}
				part = part + "/" + strconv.Itoa(bits)
			}
		}
		if _, ipnet, err := net.ParseCIDR(part); err == nil {
			out = append(out, ipnet)
		}
	}
	return out
}

func inAnyCIDR(ip string, nets []*net.IPNet) bool {
	p := net.ParseIP(ip)
	if p == nil {
		return false
	}
	for _, n := range nets {
		if n.Contains(p) {
			return true
		}
	}
	return false
}

func parsePorts(list string) []portRange {
	var out []portRange
	for _, part := range strings.Split(list, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if lo, hi, ok := strings.Cut(part, "-"); ok {
			a, e1 := strconv.Atoi(strings.TrimSpace(lo))
			b, e2 := strconv.Atoi(strings.TrimSpace(hi))
			if e1 == nil && e2 == nil && a <= b {
				out = append(out, portRange{a, b})
			}
			continue
		}
		if p, err := strconv.Atoi(part); err == nil {
			out = append(out, portRange{p, p})
		}
	}
	return out
}

func portInRange(port int, ranges []portRange) bool {
	for _, r := range ranges {
		if port >= r.lo && port <= r.hi {
			return true
		}
	}
	return false
}

func parseHM(s string) (int, bool) {
	hh, mm, _ := strings.Cut(s, ":")
	h, e1 := strconv.Atoi(strings.TrimSpace(hh))
	m, e2 := strconv.Atoi(strings.TrimSpace(mm))
	if e1 != nil || e2 != nil || h < 0 || h > 23 || m < 0 || m > 59 {
		return 0, false
	}
	return h*100 + m, true
}
