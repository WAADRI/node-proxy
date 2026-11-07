package server

import (
	"crypto/rand"
	"encoding/hex"
	"regexp"
	"strings"
	"sync"
)

// ---------------------------------------------------------------------------
// Domain routing: pattern (with * wildcards) -> tag, highest priority wins.
// ---------------------------------------------------------------------------

type domainRule struct {
	Pattern  string `json:"pattern"`
	Tag      string `json:"tag"`
	Priority int    `json:"priority"`
}

type compiledDomainRule struct {
	rule domainRule
	re   *regexp.Regexp
}

// DomainRouter resolves a hostname to a routing tag (TS domain-router.ts).
type DomainRouter struct {
	mu    sync.RWMutex
	rules []compiledDomainRule
}

var wildcardEscaper = strings.NewReplacer(`.`, `\.`, `?`, `\?`, `+`, `\+`, `(`, `\(`, `)`, `\)`, `[`, `\[`, `]`, `\]`, `^`, `\^`, `$`, `\$`)

// compileDomainPattern turns "*.example.com" into ^.*\.example\.com$.
func compileDomainPattern(pattern string) *regexp.Regexp {
	var b strings.Builder
	b.WriteString("^")
	parts := strings.Split(pattern, "*")
	for i, p := range parts {
		b.WriteString(wildcardEscaper.Replace(p))
		if i < len(parts)-1 {
			b.WriteString(".*")
		}
	}
	b.WriteString("$")
	re, err := regexp.Compile("(?i)" + b.String())
	if err != nil {
		return nil
	}
	return re
}

// SetRules replaces the rule set, dropping invalid patterns.
func (d *DomainRouter) SetRules(entries []domainRule) {
	d.mu.Lock()
	defer d.mu.Unlock()
	// stable priority desc
	for i := 1; i < len(entries); i++ {
		for j := i; j > 0 && entries[j].Priority > entries[j-1].Priority; j-- {
			entries[j], entries[j-1] = entries[j-1], entries[j]
		}
	}
	out := make([]compiledDomainRule, 0, len(entries))
	for _, r := range entries {
		if re := compileDomainPattern(r.Pattern); re != nil {
			out = append(out, compiledDomainRule{rule: r, re: re})
		}
	}
	d.rules = out
}

func (d *DomainRouter) Rules() []domainRule {
	d.mu.RLock()
	defer d.mu.RUnlock()
	out := make([]domainRule, len(d.rules))
	for i, r := range d.rules {
		out[i] = r.rule
	}
	return out
}

// Match returns the tag for a hostname, or "" (TS match(): strips port,
// case-insensitive regex test, first rule wins).
func (d *DomainRouter) Match(hostname string) string {
	if hostname == "" {
		return ""
	}
	host := strings.ToLower(strings.Split(hostname, ":")[0])
	d.mu.RLock()
	defer d.mu.RUnlock()
	for _, r := range d.rules {
		if r.re.MatchString(host) {
			return r.rule.Tag
		}
	}
	return ""
}

// ---------------------------------------------------------------------------
// Proxy passwords: per-credential routing (tag / forced node / strategy).
// ---------------------------------------------------------------------------

type ProxyPassword struct {
	ID       string `json:"id"`
	Username string `json:"username,omitempty"` // SOCKS5 user; HTTP ignores
	Password string `json:"password"`
	Tag      string `json:"tag,omitempty"`
	ClientID string `json:"clientId,omitempty"`
	Strategy string `json:"strategy,omitempty"`
	Enabled  bool   `json:"enabled"`
}

// MatchProxyPassword finds the enabled password record matching the
// credential (plain compare; bcrypt-hashed records use bcrypt.Compare).
func MatchProxyPassword(passwords []*ProxyPassword, username, password string) (*ProxyPassword, bool) {
	for _, p := range passwords {
		if !p.Enabled {
			continue
		}
		if isBcryptHash(p.Password) {
			if bcryptCompare(p.Password, password) {
				return p, true
			}
			continue
		}
		if p.Username != "" && username != "" && p.Username != username {
			continue
		}
		if constantTimeEquals(p.Password, password) {
			return p, true
		}
	}
	return nil, false
}

func isBcryptHash(s string) bool {
	return len(s) == 60 && strings.HasPrefix(s, "$2a$") || strings.HasPrefix(s, "$2b$") || strings.HasPrefix(s, "$2y$")
}

func constantTimeEquals(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	var v byte
	for i := 0; i < len(a); i++ {
		v |= a[i] ^ b[i]
	}
	return v == 0
}

// routeFromPassword maps a password record to the routing triple.
func routeFromPassword(p *ProxyPassword) (tag, clientID, strategy string) {
	return p.Tag, p.ClientID, p.Strategy
}

// ---------------------------------------------------------------------------
// Panel users + roles (TS ROLES subset).
// ---------------------------------------------------------------------------

type PanelUser struct {
	Username     string `json:"username"`
	PasswordHash string `json:"passwordHash"` // bcrypt
	Role         string `json:"role"`         // admin | operator | viewer
	Enabled      bool   `json:"enabled"`
}

var rolePermissions = map[string]map[string]bool{
	"admin": allPerms(),
	"operator": {
		"client:list": true, "client:kick": true, "client:tag": true, "client:weight": true,
		"client:bandwidth": true, "client:events": true, "client:alias": true, "client:notes": true,
		"client:region": true, "client:group": true,
		"proxy:config": true, "proxy:stats": true,
		"routing:config": true, "routing:strategy": true,
		"circuit:reset": true, "circuit:view": true,
		"system:config": true, "system:logs": true, "nettest:run": true,
		"metrics:view": true,
	},
	"viewer": {
		"client:list": true, "client:events": true,
		"proxy:stats": true, "circuit:view": true, "system:logs": true, "metrics:view": true,
	},
}

func allPerms() map[string]bool {
	m := map[string]bool{}
	for _, set := range []string{
		"client:list", "client:kick", "client:tag", "client:weight", "client:bandwidth",
		"client:events", "client:alias", "client:notes", "client:region", "client:group",
		"proxy:config", "proxy:stats", "proxy:passwords",
		"routing:config", "routing:strategy",
		"circuit:reset", "circuit:view",
		"system:config", "system:logs", "nettest:run",
		"user:list", "user:create", "user:delete", "user:modify",
		"domain:list", "domain:create", "domain:delete",
		"cache:view",
		"metrics:view",
		"acl:list", "acl:create", "acl:delete",
		"audit:query",
	} {
		m[set] = true
	}
	return m
}

// UserStore holds panel users (persisted in the runtime store; the config
// admin seeds the store on boot).
type UserStore struct {
	mu    sync.RWMutex
	users []*PanelUser
}

func NewUserStore(seedUser, seedPassword string) *UserStore {
	hash, _ := bcryptHash(seedPassword)
	return &UserStore{users: []*PanelUser{{
		Username: seedUser, PasswordHash: hash, Role: "admin", Enabled: true,
	}}}
}

// Authenticate verifies credentials against the store.
func (u *UserStore) Authenticate(username, password string) *PanelUser {
	u.mu.RLock()
	defer u.mu.RUnlock()
	for _, usr := range u.users {
		if usr.Username == username && usr.Enabled && bcryptCompare(usr.PasswordHash, password) {
			return usr
		}
	}
	return nil
}

func (u *UserStore) List() []*PanelUser {
	u.mu.RLock()
	defer u.mu.RUnlock()
	out := make([]*PanelUser, len(u.users))
	copy(out, u.users)
	return out
}

func (u *UserStore) Get(username string) *PanelUser {
	u.mu.RLock()
	defer u.mu.RUnlock()
	for _, usr := range u.users {
		if usr.Username == username {
			return usr
		}
	}
	return nil
}

func (u *UserStore) Put(usr *PanelUser) {
	u.mu.Lock()
	defer u.mu.Unlock()
	for i, existing := range u.users {
		if existing.Username == usr.Username {
			u.users[i] = usr
			return
		}
	}
	u.users = append(u.users, usr)
}

// ReplaceAll swaps the user table (boot-time load from the runtime store).
func (u *UserStore) ReplaceAll(users []*PanelUser) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.users = users
}

func (u *UserStore) Delete(username string) bool {
	u.mu.Lock()
	defer u.mu.Unlock()
	for i, usr := range u.users {
		if usr.Username == username {
			u.users = append(u.users[:i], u.users[i+1:]...)
			return true
		}
	}
	return false
}

// HasPermission checks the role permission map.
func HasPermission(user *PanelUser, perm string) bool {
	if user == nil || !user.Enabled {
		return false
	}
	perms, ok := rolePermissions[user.Role]
	return ok && perms[perm]
}

// route tag helper shared by password and domain routing.
func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// newID is a short random id for rules/passwords.
func newID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
