package selfupdate

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestIsNewer(t *testing.T) {
	cases := []struct {
		latest, current string
		want            bool
	}{
		{"v0.2.0", "v0.1.0-go", true},
		{"v0.1.0-go", "v0.1.0-go", false},
		{"v0.1.0", "v0.1.1", false},
		{"v1.0", "v0.9.9", true},
		{"v1.0.0", "v1.0", false}, // equal core
		{"dev", "v0.1.0", false},  // unparsable latest never wins
		{"v0.2.0", "dev", false},  // unparsable current never loses
	}
	for _, c := range cases {
		if got := IsNewer(c.latest, c.current); got != c.want {
			t.Errorf("IsNewer(%q, %q) = %v, want %v", c.latest, c.current, got, c.want)
		}
	}
}

func TestFetchLatestFailover(t *testing.T) {
	var primary *httptest.Server
	primary = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "mirror down", http.StatusBadGateway)
	}))
	defer primary.Close()

	good := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"tag_name":"v1.2.3","html_url":"u"}`))
	}))
	defer good.Close()

	// Primary (unreachable port) fails over to the working base.
	tag, _, err := FetchLatest([]string{
		"http://127.0.0.1:1", // refused
		good.URL,
	})
	if err != nil || tag != "v1.2.3" {
		t.Fatalf("failover = %q %v", tag, err)
	}
	_ = primary
}

func TestDownloadVerifiedChecksum(t *testing.T) {
	dir := t.TempDir()
	payload := "verified-binary-content"
	want := hex.EncodeToString(func() []byte { h := sha256.Sum256([]byte(payload)); return h[:] }())

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/checksums.sha256":
			_, _ = w.Write([]byte(want + "  asset.bin\n"))
		case "/asset.bin":
			_, _ = w.Write([]byte(payload))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	got, err := FetchChecksums([]string{srv.URL + "/checksums.sha256"})
	if err != nil {
		t.Fatal(err)
	}
	if got["asset.bin"] != want {
		t.Fatalf("checksum map = %v", got)
	}

	dst := filepath.Join(dir, "dl.bin")
	if err := DownloadVerified([]string{srv.URL + "/asset.bin"}, dst, want); err != nil {
		t.Fatalf("DownloadVerified: %v", err)
	}
	if b, _ := os.ReadFile(dst); string(b) != payload {
		t.Fatal("content mismatch")
	}

	// Corrupt checksum must abort the download.
	if err := DownloadVerified([]string{srv.URL + "/asset.bin"}, dst, strings.Repeat("0", 64)); err == nil {
		t.Fatal("mismatched checksum accepted")
	}
}
