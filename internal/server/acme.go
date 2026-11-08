package server

import (
	"crypto/tls"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"strings"

	"golang.org/x/crypto/acme"
	"golang.org/x/crypto/acme/autocert"
)

// ACMEConfig mirrors the TS AcmeSection: {enabled, email, staging, domains}.
type ACMEConfig struct {
	Enabled bool
	Email   string
	Staging bool
	Domains []string
}

var safeVersionRe = regexp.MustCompile(`^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$`)

// SafeVersion validates a version string before it touches file names (TS
// _safeVersion, issue #120: path traversal / injection guard).
func SafeVersion(v string) (string, error) {
	v = strings.TrimSpace(v)
	if !safeVersionRe.MatchString(v) || strings.Contains(v, "..") {
		return "", fmt.Errorf("refusing update: unsafe version %q", v)
	}
	return v, nil
}

// BuildACMEManager constructs the autocert manager when ACME is configured.
// Returns nil when disabled or no domains are listed.
func BuildACMEManager(cfg *Config, acmeCfg ACMEConfig) *autocert.Manager {
	if !acmeCfg.Enabled || len(acmeCfg.Domains) == 0 {
		return nil
	}
	cacheDir := "acme-cache"
	if p := findConfigFile(); p != "" {
		if i := lastSep(p); i >= 0 {
			cacheDir = p[:i+1] + "acme-cache"
		}
	}
	_ = os.MkdirAll(cacheDir, 0o700)
	m := &autocert.Manager{
		Prompt:     autocert.AcceptTOS,
		HostPolicy: autocert.HostWhitelist(acmeCfg.Domains...),
		Cache:      autocert.DirCache(cacheDir),
		Email:      acmeCfg.Email,
	}
	if acmeCfg.Staging {
		// Let's Encrypt staging directory - no rate limits while wiring up.
		m.Client = &acme.Client{DirectoryURL: "https://acme-staging-v02.api.letsencrypt.org/directory"}
	}
	return m
}

// ServePanelWithTLS runs the panel server under ACME-managed TLS and the
// HTTP-01 challenge on :80. Falls back to plain HTTP when acme is nil.
func ServePanelWithTLS(mux http.Handler, cfg *Config, acme *autocert.Manager) error {
	if acme == nil {
		srv := &http.Server{Addr: fmt.Sprintf("%s:%d", cfg.Host, cfg.WebPort), Handler: mux}
		return srv.ListenAndServe()
	}
	// HTTP-01 challenges + redirect on :80.
	go http.ListenAndServe(":80", acme.HTTPHandler(nil))
	srv := &http.Server{
		Addr:      fmt.Sprintf("%s:%d", cfg.Host, cfg.WebPort),
		Handler:   mux,
		TLSConfig: &tls.Config{GetCertificate: acme.GetCertificate},
	}
	return srv.ListenAndServeTLS("", "")
}
