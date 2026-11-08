// Package selfupdate implements the shared self-update machinery for the
// node-proxy binaries: release discovery over a failover chain of GitHub API
// mirrors (domestic access to api.github.com is unreliable), asset download
// through configurable mirror prefixes, sha256 verification against the
// published checksums.sha256, version comparison, and the Windows-safe
// binary swap.
package selfupdate

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Default endpoints; callers prepend mirrors before these.
const (
	DefaultAPIBase     = "https://api.github.com"
	DefaultDownloadURL = "https://github.com"
	Repo               = "WAADRI/node-proxy"
)

// SafeVersion validates a version string before it touches file names
// (issue #120: anything beyond a dotted version allows traversal or worse).
func SafeVersion(v string) (string, error) {
	v = strings.TrimSpace(v)
	if !regexp.MustCompile(`^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$`).MatchString(v) || strings.Contains(v, "..") {
		return "", fmt.Errorf("refusing update: unsafe version %q", v)
	}
	return v, nil
}

// versionCore extracts the numeric dotted core of a version-ish string:
// "v1.2.3-go" -> "1.2.3". Returns "" when there is no numeric core.
func versionCore(v string) []int {
	v = strings.TrimPrefix(strings.TrimSpace(strings.ToLower(v)), "v")
	m := regexp.MustCompile(`^\d+(\.\d+)*`).FindString(v)
	if m == "" {
		return nil
	}
	parts := strings.Split(m, ".")
	out := make([]int, len(parts))
	for i, p := range parts {
		out[i], _ = strconv.Atoi(p)
	}
	return out
}

// IsNewer reports whether latest has a higher numeric core than current
// ("v0.2.0" > "v0.1.0-go"; suffixes never win, only the numeric core
// compares). Unparsable sides return false - dev builds are never "older".
func IsNewer(latest, current string) bool {
	l, c := versionCore(latest), versionCore(current)
	if len(l) == 0 || len(c) == 0 {
		return false
	}
	n := len(l)
	if len(c) > n {
		n = len(c)
	}
	for i := 0; i < n; i++ {
		a, b := 0, 0
		if i < len(l) {
			a = l[i]
		}
		if i < len(c) {
			b = c[i]
		}
		if a != b {
			return a > b
		}
	}
	return false
}

// AssetName is the release asset file name for one binary on one platform.
func AssetName(app, goos, goarch string) string {
	name := app + "-" + goos + "-" + goarch
	if goos == "windows" {
		name += ".exe"
	}
	return name
}

// FetchLatest returns the latest release tag and its HTML URL, trying each
// API base in order (mirrors first, default last) and failing over on error
// or non-200.
func FetchLatest(apiBases []string) (tag, htmlURL string, err error) {
	if len(apiBases) == 0 {
		apiBases = []string{DefaultAPIBase}
	}
	var lastErr error
	for _, base := range apiBases {
		base = strings.TrimSpace(base)
		if base != "" && !strings.Contains(base, "://") {
			base = "https://" + base // bare mirror hosts are common in configs
		}
		url := strings.TrimRight(base, "/") + "/repos/" + Repo + "/releases/latest"
		client := &http.Client{Timeout: 15 * time.Second}
		req, reqErr := http.NewRequest("GET", url, nil)
		if reqErr != nil {
			lastErr = reqErr
			continue
		}
		req.Header.Set("Accept", "application/vnd.github+json")
		resp, doErr := client.Do(req)
		if doErr != nil {
			lastErr = doErr
			continue
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			lastErr = fmt.Errorf("%s: status %d", base, resp.StatusCode)
			continue
		}
		var parsed struct {
			TagName string `json:"tag_name"`
			HTMLURL string `json:"html_url"`
		}
		if jsonErr := json.Unmarshal(body, &parsed); jsonErr != nil {
			lastErr = jsonErr
			continue
		}
		if parsed.TagName == "" {
			lastErr = fmt.Errorf("%s: empty tag_name", base)
			continue
		}
		return parsed.TagName, parsed.HTMLURL, nil
	}
	return "", "", lastErr
}

// AssetCandidates builds the download URL candidates for one asset: every
// mirror prefix first (prefix + canonical github.com URL, the common
// domestic acceleration pattern), then the direct URL last.
func AssetCandidates(repo, tag, asset string, downloadPrefixes []string) []string {
	canonical := DefaultDownloadURL + "/" + repo + "/releases/download/" + tag + "/" + asset
	var out []string
	for _, p := range downloadPrefixes {
		p = strings.TrimRight(strings.TrimSpace(p), "/")
		if p != "" {
			out = append(out, p+"/"+strings.TrimPrefix(canonical, "https://"))
		}
	}
	return append(out, canonical)
}

// FetchChecksums downloads and parses a checksums.sha256 asset from the
// candidate URLs. Returns map[assetName]hexDigest.
func FetchChecksums(candidates []string) (map[string]string, error) {
	for _, url := range candidates {
		client := &http.Client{Timeout: 20 * time.Second}
		resp, err := client.Get(url)
		if err != nil {
			continue
		}
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK || readErr != nil {
			continue
		}
		out := map[string]string{}
		ok := true
		for _, line := range strings.Split(string(body), "\n") {
			line = strings.TrimSpace(line)
			if line == "" {
				continue
			}
			fields := strings.Fields(line)
			if len(fields) != 2 || len(fields[0]) != 64 {
				ok = false
				break
			}
			name := strings.TrimPrefix(fields[1], "*")
			out[name] = strings.ToLower(fields[0])
		}
		if ok && len(out) > 0 {
			return out, nil
		}
	}
	return nil, fmt.Errorf("checksums.sha256 unavailable from any source")
}

// DownloadVerified fetches the asset from the candidate URLs (failover in
// order), verifies the sha256 against wantHex when non-empty, and writes the
// bytes to dest.
func DownloadVerified(candidates []string, dest, wantHex string) error {
	var lastErr error
	for _, url := range candidates {
		client := &http.Client{Timeout: 10 * time.Minute}
		resp, err := client.Get(url)
		if err != nil {
			lastErr = err
			continue
		}
		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			lastErr = fmt.Errorf("%s: status %d", url, resp.StatusCode)
			continue
		}
		f, err := os.Create(dest)
		if err != nil {
			resp.Body.Close()
			return err
		}
		hasher := sha256.New()
		_, copyErr := io.Copy(io.MultiWriter(f, hasher), resp.Body)
		closeErr := f.Close()
		resp.Body.Close()
		if copyErr != nil {
			lastErr = copyErr
			continue
		}
		if closeErr != nil {
			lastErr = closeErr
			continue
		}
		if wantHex != "" {
			got := hex.EncodeToString(hasher.Sum(nil))
			if !strings.EqualFold(got, wantHex) {
				os.Remove(dest)
				lastErr = fmt.Errorf("sha256 mismatch: got %s want %s", got, wantHex)
				continue
			}
		}
		return nil
	}
	return lastErr
}

// SwapBinaryAt replaces the running executable at exePath with newPath using
// the rename dance (running files cannot be overwritten on Windows, but they
// can be renamed away). Returns the backup path.
func SwapBinaryAt(exePath, newPath string) (backup string, err error) {
	backup = exePath + ".old"
	os.Remove(backup)
	if err := os.Rename(exePath, backup); err != nil {
		return "", fmt.Errorf("rename running binary: %w", err)
	}
	if err := os.Rename(newPath, exePath); err != nil {
		os.Rename(backup, exePath) // roll back; the process keeps running
		return "", fmt.Errorf("install new binary: %w", err)
	}
	return backup, nil
}
