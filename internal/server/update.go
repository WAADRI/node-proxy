package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"runtime"
	"time"

	"github.com/WAADRI/node-proxy-go/internal/selfupdate"
)

// updateSources resolves the API bases and download prefixes for the
// self-update: config lists first (mirrors), defaults last.
func (s *Server) updateSources() (apiBases, downloadPrefixes []string) {
	apiBases = s.Cfg.Update.APIBases
	downloadPrefixes = s.Cfg.Update.DownloadPrefixes
	if len(apiBases) == 0 {
		apiBases = []string{selfupdate.DefaultAPIBase}
	}
	return apiBases, downloadPrefixes
}

// handleUpdateCheck queries the latest release and reports whether it is
// newer than the running build.
func (s *Server) handleUpdateCheck(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	apiBases, _ := s.updateSources()
	latest, url, err := selfupdate.FetchLatest(apiBases)
	out := map[string]any{"success": err == nil, "currentVersion": Version}
	if err != nil {
		out["error"] = err.Error()
	} else {
		out["latest"] = latest
		out["url"] = url
		out["upToDate"] = !selfupdate.IsNewer(latest, Version)
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(out)
}

// handleUpdateApply downloads the platform asset (checksum-verified) and
// swaps the running binary; the process exits so the supervisor restarts it.
// Body: {"force": true} overrides the "already up to date" gate.
func (s *Server) handleUpdateApply(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Force bool `json:"force"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)

	apiBases, downloadPrefixes := s.updateSources()
	latest, tagURL, err := selfupdate.FetchLatest(apiBases)
	if err != nil {
		updateError(w, err)
		return
	}
	if !body.Force && !selfupdate.IsNewer(latest, Version) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"success": true, "upToDate": true, "currentVersion": Version, "latest": latest,
		})
		return
	}
	version, err := selfupdate.SafeVersion(latest)
	if err != nil {
		updateError(w, err)
		return
	}

	asset := selfupdate.AssetName("node-proxy-server", runtime.GOOS, runtime.GOARCH)
	checksumURLs := selfupdate.AssetCandidates(selfupdate.Repo, latest, "checksums.sha256", downloadPrefixes)
	checksums, err := selfupdate.FetchChecksums(checksumURLs)
	if err != nil {
		updateError(w, fmt.Errorf("checksums.sha256: %w", err))
		return
	}
	wantHex, known := checksums[asset]
	if !known {
		updateError(w, fmt.Errorf("release %s has no checksum for %s", latest, asset))
		return
	}

	exePath, err := os.Executable()
	if err != nil {
		updateError(w, err)
		return
	}
	tmp := exePath + ".new"
	urls := selfupdate.AssetCandidates(selfupdate.Repo, latest, asset, downloadPrefixes)
	if err := selfupdate.DownloadVerified(urls, tmp, wantHex); err != nil {
		updateError(w, fmt.Errorf("download %s: %w", asset, err))
		return
	}
	backup, err := selfupdate.SwapBinaryAt(exePath, tmp)
	if err != nil {
		_ = os.Remove(tmp)
		updateError(w, err)
		return
	}
	s.Log.Infof("update %s applied (checksum verified, backup: %s); exiting for supervisor restart", version, backup)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"success": true, "version": version, "asset": asset,
		"url": tagURL, "backup": backup, "restart": "supervisor",
	})
	go func() {
		time.Sleep(time.Second)
		os.Exit(0)
	}()
}

func updateError(w http.ResponseWriter, err error) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusInternalServerError)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"success": false, "error": err.Error(), "currentVersion": Version,
	})
}
