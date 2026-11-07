package server

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
)

// ---------------------------------------------------------------------------
// Panel user resolution inside requests: the JWT carries the username, the
// live store carries role/enabled - a role change takes effect immediately
// (TS parity: the middleware re-reads the live user).
// ---------------------------------------------------------------------------

type ctxKey string

const userKey ctxKey = "panelUser"

func (s *Server) requirePerm(perm string, next http.HandlerFunc) http.Handler {
	return s.requireJWT(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user := s.userFrom(r)
		if !HasPermission(user, perm) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"error":"Forbidden","message":"Permission denied: ` + perm + `"}`))
			return
		}
		next(w, r)
	}))
}

// userFrom resolves the JWT subject against the live user store.
func (s *Server) userFrom(r *http.Request) *PanelUser {
	if s.Users == nil {
		return &PanelUser{Username: "admin", Role: "admin", Enabled: true}
	}
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	sub := jwtSubject(token)
	if sub == "" {
		return nil
	}
	return s.Users.Get(sub)
}

// jwtSubject extracts the sub claim without full revalidation (requireJWT
// already verified the signature).
func jwtSubject(token string) string {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return ""
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return ""
	}
	var claims struct {
		Sub string `json:"sub"`
	}
	if json.Unmarshal(payload, &claims) != nil {
		return ""
	}
	return claims.Sub
}

// ---------------------------------------------------------------------------
// ACL rules API
// ---------------------------------------------------------------------------

func (s *Server) handleACLRules(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		w.Header().Set("Content-Type", "application/json")
		rules := []*AclRule{}
		if s.ACL != nil {
			rules = s.ACL.Rules()
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"rules": rules})

	case http.MethodPost:
		var rule AclRule
		if err := json.NewDecoder(r.Body).Decode(&rule); err != nil {
			jsonError(w, "Bad request body", http.StatusBadRequest)
			return
		}
		if rule.Action != "allow" && rule.Action != "deny" {
			jsonError(w, "action must be allow or deny", http.StatusBadRequest)
			return
		}
		if rule.ID == "" {
			rule.ID = newID()
		}
		rules := []*AclRule{}
		if s.ACL != nil {
			rules = s.ACL.Rules()
		}
		rules = append(rules, &rule)
		s.ACL.SetRules(rules)
		s.Settings.SaveRuntime()
		s.Log.Infof("ACL rule added: %s %s (priority %d)", rule.ID, rule.Action, rule.Priority)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "rule": rule})

	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleACLRulesSub(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/acl/rules/")
	if id == "" {
		http.Error(w, "Bad request", http.StatusBadRequest)
		return
	}
	if r.Method == http.MethodDelete {
		rules := s.ACL.Rules()
		kept := rules[:0]
		removed := false
		for _, rule := range rules {
			if rule.ID == id {
				removed = true
				continue
			}
			kept = append(kept, rule)
		}
		if !removed {
			jsonError(w, "Rule not found", http.StatusNotFound)
			return
		}
		s.ACL.SetRules(kept)
		s.Settings.SaveRuntime()
		writeOK(w)
		return
	}
	http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
}

func (s *Server) handleACLStats(w http.ResponseWriter, r *http.Request) {
	rules := []*AclRule{}
	if s.ACL != nil {
		rules = s.ACL.Rules()
	}
	hits := map[string]int64{}
	for _, rule := range rules {
		hits[rule.ID] = rule.Hits
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "hits": hits, "enabled": s.ACL.Enabled()})
}

// ---------------------------------------------------------------------------
// Domain rules API
// ---------------------------------------------------------------------------

func (s *Server) handleDomainRules(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		var rules []domainRule
		if s.DomainRouter != nil {
			rules = s.DomainRouter.Rules()
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"rules": rules})

	case http.MethodPost:
		var body domainRule
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Pattern == "" || body.Tag == "" {
			jsonError(w, "pattern and tag required", http.StatusBadRequest)
			return
		}
		if compileDomainPattern(body.Pattern) == nil {
			jsonError(w, "invalid pattern", http.StatusBadRequest)
			return
		}
		rules := append(s.DomainRouter.Rules(), body)
		s.DomainRouter.SetRules(rules)
		s.Settings.SaveRuntime()
		s.Log.Infof("domain rule added: %s -> %s", body.Pattern, body.Tag)
		writeOK(w)

	case http.MethodDelete:
		var body struct {
			Pattern string `json:"pattern"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		rules := s.DomainRouter.Rules()
		kept := rules[:0]
		removed := false
		for _, rule := range rules {
			if rule.Pattern == body.Pattern {
				removed = true
				continue
			}
			kept = append(kept, rule)
		}
		if !removed {
			jsonError(w, "Rule not found", http.StatusNotFound)
			return
		}
		s.DomainRouter.SetRules(kept)
		s.Settings.SaveRuntime()
		writeOK(w)

	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

// ---------------------------------------------------------------------------
// Proxy passwords API (CRUD, TS proxy-passwords parity)
// ---------------------------------------------------------------------------

func (s *Server) handleProxyPasswords(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		w.Header().Set("Content-Type", "application/json")
		entries := []*ProxyPassword{}
		if s.ProxyPasswords != nil {
			entries = *s.ProxyPasswords
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"passwords": entries})

	case http.MethodPost:
		var body ProxyPassword
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Password == "" {
			jsonError(w, "password required", http.StatusBadRequest)
			return
		}
		if body.ID == "" {
			body.ID = newID()
		}
		body.Enabled = true
		*s.ProxyPasswords = append(*s.ProxyPasswords, &body)
		s.Settings.SaveRuntime()
		s.Log.Infof("proxy password added: %s (tag=%s)", body.ID, body.Tag)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "entry": body})

	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleProxyPasswordsSub(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/proxy-passwords/")
	parts := strings.Split(rest, "/")
	id := parts[0]
	sub := ""
	if len(parts) > 1 {
		sub = parts[1]
	}

	list := *s.ProxyPasswords
	var rec *ProxyPassword
	idx := -1
	for i, p := range list {
		if p.ID == id {
			rec, idx = p, i
			break
		}
	}
	if rec == nil {
		jsonError(w, "Not found", http.StatusNotFound)
		return
	}

	switch {
	case r.Method == http.MethodPost && sub == "regenerate":
		pw := newID() + newID()
		rec.Password = pw[:20]
		rec.Enabled = true
		s.Settings.SaveRuntime()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "password": rec.Password})

	case r.Method == http.MethodPost && sub == "":
		var body ProxyPassword
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Tag != "" || body.ClientID != "" || body.Strategy != "" {
			rec.Tag, rec.ClientID, rec.Strategy = body.Tag, body.ClientID, body.Strategy
		}
		if body.Username != "" {
			rec.Username = body.Username
		}
		s.Settings.SaveRuntime()
		writeOK(w)

	case r.Method == http.MethodDelete && sub == "":
		*s.ProxyPasswords = append(list[:idx], list[idx+1:]...)
		s.Settings.SaveRuntime()
		writeOK(w)

	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

// ---------------------------------------------------------------------------
// Panel users API (TS users parity, subset)
// ---------------------------------------------------------------------------

func (s *Server) handleUsersList(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		out := []map[string]any{}
		for _, u := range s.Users.List() {
			out = append(out, map[string]any{
				"username": u.Username,
				"role":     u.Role,
				"enabled":  u.Enabled,
			})
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"users": out})

	case http.MethodPost:
		var body struct {
			Username string `json:"username"`
			Password string `json:"password"`
			Role     string `json:"role"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Username == "" || body.Password == "" {
			jsonError(w, "username and password required", http.StatusBadRequest)
			return
		}
		if _, ok := rolePermissions[body.Role]; !ok {
			jsonError(w, "role must be admin, operator or viewer", http.StatusBadRequest)
			return
		}
		if s.Users.Get(body.Username) != nil {
			jsonError(w, "User exists", http.StatusConflict)
			return
		}
		hash, err := bcryptHash(body.Password)
		if err != nil {
			jsonError(w, "hash failed", http.StatusInternalServerError)
			return
		}
		s.Users.Put(&PanelUser{Username: body.Username, PasswordHash: hash, Role: body.Role, Enabled: true})
		s.Settings.SaveRuntime()
		s.Log.Infof("panel user created: %s (%s)", body.Username, body.Role)
		writeOK(w)

	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleUsersSub(w http.ResponseWriter, r *http.Request) {
	username := strings.TrimPrefix(r.URL.Path, "/api/users/")
	if username == "" {
		http.Error(w, "Bad request", http.StatusBadRequest)
		return
	}
	caller := s.userFrom(r)
	if caller != nil && caller.Username == username && (r.Method == http.MethodDelete || r.Method == http.MethodPatch) {
		jsonError(w, "cannot modify your own account here", http.StatusBadRequest)
		return
	}
	target := s.Users.Get(username)
	if target == nil {
		jsonError(w, "User not found", http.StatusNotFound)
		return
	}

	switch r.Method {
	case http.MethodDelete:
		// Keep at least one enabled admin.
		if target.Role == "admin" {
			enabledAdmins := 0
			for _, u := range s.Users.List() {
				if u.Role == "admin" && u.Enabled && u.Username != username {
					enabledAdmins++
				}
			}
			if enabledAdmins == 0 {
				jsonError(w, "cannot delete the last admin", http.StatusBadRequest)
				return
			}
		}
		s.Users.Delete(username)
		s.Settings.SaveRuntime()
		s.Log.Infof("panel user deleted: %s", username)
		writeOK(w)

	case http.MethodPatch:
		var body struct {
			Password *string `json:"password"`
			Role     *string `json:"role"`
			Enabled  *bool   `json:"enabled"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Password != nil && *body.Password != "" {
			hash, err := bcryptHash(*body.Password)
			if err != nil {
				jsonError(w, "hash failed", http.StatusInternalServerError)
				return
			}
			target.PasswordHash = hash
		}
		if body.Role != nil {
			if _, ok := rolePermissions[*body.Role]; !ok {
				jsonError(w, "invalid role", http.StatusBadRequest)
				return
			}
			target.Role = *body.Role
		}
		if body.Enabled != nil {
			target.Enabled = *body.Enabled
		}
		s.Settings.SaveRuntime()
		writeOK(w)

	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}
