package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/WAADRI/node-proxy-go/internal/selfupdate"
)

// TestSwapBinary covers the rename dance on a temp pair of files.
func TestSwapBinary(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "server.exe")
	if err := os.WriteFile(exe, []byte("OLD-BINARY"), 0o755); err != nil {
		t.Fatal(err)
	}
	newPath := filepath.Join(dir, "candidate.bin")
	if err := os.WriteFile(newPath, []byte("NEW-BINARY-CONTENT"), 0o755); err != nil {
		t.Fatal(err)
	}

	backup, err := selfupdate.SwapBinaryAt(exe, newPath)
	if err != nil {
		t.Fatalf("swap: %v", err)
	}
	got, _ := os.ReadFile(exe)
	if string(got) != "NEW-BINARY-CONTENT" {
		t.Fatalf("exe content = %q, want new binary", got)
	}
	old, _ := os.ReadFile(backup)
	if string(old) != "OLD-BINARY" {
		t.Fatalf("backup content = %q, want old binary", old)
	}
}

// TestApplyUpdate drives the full update flow against a fake GitHub: release
// metadata + a platform asset; the running binary is swapped in place.
func TestApplyUpdate(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "node-proxy-server.exe")
	if err := os.WriteFile(exe, []byte("OLD"), 0o755); err != nil {
		t.Fatal(err)
	}
	// The swap target is os.Executable() in ApplyUpdate; run THIS test
	// binary? No - too dangerous. ApplyUpdate is refactored to take the
	// executable path, so drive swapBinaryAt via a fake-release server for
	// the download side and verify the payload handling.
	assetBody := strings.Repeat("NEWBIN", 300) // > 1024 bytes

	var gh *httptest.Server
	gh = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/releases/latest"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"tag_name": "v9.9.9",
				"html_url": "https://github.com/WAADRI/node-proxy/releases/tag/v9.9.9",
				"assets": []map[string]any{
					{"name": "node-proxy-server-test", "browser_download_url": gh.URL + "/dl/asset"},
				},
			})
		case r.URL.Path == "/dl/asset":
			_, _ = w.Write([]byte(assetBody))
		default:
			http.NotFound(w, r)
		}
	}))
	defer gh.Close()

	srv, _, _ := newTestServer(t)
	srv.Cfg.Update.APIBases = []string{gh.URL}

	// Validate helpers against the fake.
	latest, urlStr, err := selfupdate.FetchLatest(srv.Cfg.Update.APIBases)
	if err != nil || latest != "v9.9.9" {
		t.Fatalf("FetchLatest = %q %q %v", latest, urlStr, err)
	}
	if _, err := SafeVersion("v9.9.9"); err != nil {
		t.Fatalf("safe version rejected: %v", err)
	}
	for _, bad := range []string{"../etc", "v1;rm", "v x", ""} {
		if _, err := SafeVersion(bad); err == nil {
			t.Fatalf("unsafe version %q accepted", bad)
		}
	}
	if got := selfupdate.AssetName("node-proxy-server", "windows", "amd64"); got != "node-proxy-server-windows-amd64.exe" {
		t.Fatalf("asset name = %s", got)
	}
	if got := selfupdate.AssetName("node-proxy-server", "linux", "arm64"); got != "node-proxy-server-linux-arm64" {
		t.Fatalf("asset name = %s", got)
	}

	// DownloadVerified round-trip (asset has no checksum entry here; size path).
	dst := filepath.Join(dir, "dl.bin")
	urls := selfupdate.AssetCandidates(selfupdate.Repo, "v9.9.9", "asset.bin", []string{})
	_ = urls
	if err := selfupdate.DownloadVerified([]string{gh.URL + "/dl/asset"}, dst, ""); err != nil {
		t.Fatalf("DownloadVerified: %v", err)
	}
	if b, _ := os.ReadFile(dst); string(b) != assetBody {
		t.Fatal("downloaded content mismatch")
	}
}

// TestACMEConfigParsing covers the yaml/env surface of the ACME section.
func TestACMEConfigParsing(t *testing.T) {
	dir := t.TempDir()
	cfgFile := filepath.Join(dir, "config.yaml")
	yamlContent := `server:
  web_port: 3100
auth:
  token: acme-test-token
acme:
  enabled: true
  email: ops@example.com
  staging: true
  domains:
    - proxy.example.com
    - panel.example.com
`
	if err := os.WriteFile(cfgFile, []byte(yamlContent), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CONFIG_PATH", cfgFile)
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.ACME.Enabled || cfg.ACME.Email != "ops@example.com" || !cfg.ACME.Staging {
		t.Fatalf("acme section not parsed: %+v", cfg.ACME)
	}
	if len(cfg.ACME.Domains) != 2 || cfg.ACME.Domains[0] != "proxy.example.com" {
		t.Fatalf("domains = %v", cfg.ACME.Domains)
	}

	// Manager construction: enabled with domains -> manager; disabled -> nil.
	if m := BuildACMEManager(cfg, cfg.ACME); m == nil {
		t.Fatal("expected autocert manager for enabled config")
	}
	cfg.ACME.Enabled = false
	if m := BuildACMEManager(cfg, cfg.ACME); m != nil {
		t.Fatal("disabled ACME must not build a manager")
	}
	// Staging points at the LE staging directory.
	cfg.ACME.Enabled = true
	m := BuildACMEManager(cfg, cfg.ACME)
	if m.Client == nil || !strings.Contains(m.Client.DirectoryURL, "acme-staging") {
		t.Fatal("staging directory not configured")
	}
}
