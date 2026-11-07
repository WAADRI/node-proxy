package server

import (
	"crypto/tls"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"runtime"
	"strings"
	"time"

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

// assetNameFor picks the release asset for this platform (single-binary
// model: node-proxy-server-<goos>-<goarch>[.exe]).
func assetNameFor(goos, goarch string) string {
	name := "node-proxy-server-" + goos + "-" + goarch
	if goos == "windows" {
		name += ".exe"
	}
	return name
}

// ApplyUpdate downloads the latest release binary for this platform,
// validates it, swaps the running file and schedules a process exit so the
// supervisor (docker/systemd/service) restarts into the new build.
// githubBase is injectable for tests.
func (s *Server) ApplyUpdate() (map[string]any, error) {
	latest, tagURL, err := s.checkLatestRelease()
	if err != nil {
		return nil, err
	}
	version, err := SafeVersion(latest)
	if err != nil {
		return nil, err
	}

	assetName := assetNameFor(runtime.GOOS, runtime.GOARCH)
	dlURL := s.releaseAssetURL(latest, assetName)
	exePath, err := os.Executable()
	if err != nil {
		return nil, err
	}
	tmp := exePath + ".new"
	if err := downloadTo(dlURL, tmp); err != nil {
		return nil, fmt.Errorf("download %s: %w", assetName, err)
	}
	info, err := os.Stat(tmp)
	if err != nil || info.Size() < 1024 {
		_ = os.Remove(tmp)
		return nil, fmt.Errorf("downloaded asset %s is too small to be a binary", assetName)
	}
	backup, err := swapBinaryAt(exePath, tmp)
	if err != nil {
		_ = os.Remove(tmp)
		return nil, err
	}
	s.Log.Infof("update %s applied (backup: %s); exiting for supervisor restart", version, backup)
	out := map[string]any{
		"success": true, "version": version, "asset": assetName,
		"url": tagURL, "backup": backup, "restart": "supervisor",
	}
	go func() {
		time.Sleep(time.Second)
		os.Exit(0)
	}()
	return out, nil
}

// releaseAssetURL builds the browser-download URL for a release asset.
func (s *Server) releaseAssetURL(tag, asset string) string {
	base := s.GitHubAPIBase
	if base == "" {
		base = "https://github.com"
	}
	return base + "/releases/download/" + tag + "/" + asset
}

// downloadTo fetches a URL into a local file (honors HTTPS_PROXY via the
// default transport).
func downloadTo(url, path string) error {
	resp, err := http.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("status %d", resp.StatusCode)
	}
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(f, resp.Body)
	return err
}

// swapBinary replaces the running executable with newPath (rename dance).
func swapBinary(newPath string) (backup string, err error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return swapBinaryAt(exe, newPath)
}

// swapBinaryAt is the path-injectable core (tests): the running file cannot
// be overwritten on Windows, but it can be renamed away.
func swapBinaryAt(exePath, newPath string) (backup string, err error) {
	backup = exePath + ".old"
	_ = os.Remove(backup)
	if err := os.Rename(exePath, backup); err != nil {
		return "", fmt.Errorf("rename running binary: %w", err)
	}
	if err := os.Rename(newPath, exePath); err != nil {
		// Roll the old one back; the process keeps running either way.
		_ = os.Rename(backup, exePath)
		return "", fmt.Errorf("install new binary: %w", err)
	}
	return backup, nil
}
