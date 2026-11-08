// node-proxy-client is the Go rewrite of the node-proxy client node.
//
// Configuration precedence matches the TS client: command flags > environment
// > built-in defaults (CLIENT_ID/SERVER_URL/AUTH_TOKEN/REGION/TAGS/
// TLS_REJECT_UNAUTHORIZED are honored, see internal/client).
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"syscall"

	"github.com/WAADRI/node-proxy-go/internal/client"
	"github.com/WAADRI/node-proxy-go/internal/selfupdate"
	"github.com/WAADRI/node-proxy-go/internal/streammux"
)

// streammuxLogger ties the CLI loggers to the interface the client needs.
type streammuxLogger = streammux.Logger

// consoleLogger is the minimal stderr logger used until zap/zerolog lands.
type consoleLogger struct{}

func (consoleLogger) Debugf(f string, a ...any) { printf("DEBUG", f, a...) }
func (consoleLogger) Infof(f string, a ...any)  { printf("INFO", f, a...) }
func (consoleLogger) Warnf(f string, a ...any)  { printf("WARN", f, a...) }
func (consoleLogger) Errorf(f string, a ...any) { printf("ERROR", f, a...) }
func (consoleLogger) Info(m string)             { println("INFO", m) }
func (consoleLogger) Warn(m string)             { println("WARN", m) }
func (consoleLogger) Error(m string)            { println("ERROR", m) }

func printf(level, f string, a ...any) {
	fmt.Fprintf(os.Stderr, "[%s] %s\n", level, fmt.Sprintf(f, a...))
}
func println(level, m string) {
	fmt.Fprintf(os.Stderr, "[%s] %s\n", level, m)
}

func main() {
	cfg, err := client.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "config: %v\n", err)
		os.Exit(2)
	}
	flag.StringVar(&cfg.ServerURL, "server", cfg.ServerURL, "server WebSocket URL (SERVER_URL)")
	flag.StringVar(&cfg.AuthToken, "token", cfg.AuthToken, "auth token (AUTH_TOKEN)")
	flag.StringVar(&cfg.Region, "region", cfg.Region, "node region (REGION)")
	flag.StringVar(&cfg.Tags, "tags", cfg.Tags, "comma separated tags (TAGS)")
	flag.BoolVar(&cfg.TLSRejectUnauthorized, "tls-verify", cfg.TLSRejectUnauthorized, "verify server TLS certificate")
	quiet := flag.Bool("quiet", false, "only log warnings and errors")
	force := flag.Bool("update-force", false, "apply update even when not newer")
	selfUpdate := flag.Bool("update", false, "check GitHub releases, apply a newer build and exit")
	flag.Parse()

	if *selfUpdate {
		runSelfUpdate(cfg, *force)
		return
	}

	var log streammuxLogger = consoleLogger{}
	if *quiet {
		log = quietLogger{}
	}

	fmt.Fprintf(os.Stderr, "node-proxy-go client  server=%s  clientId=%s\n", cfg.ServerURL, cfg.ClientID)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := client.New(cfg, log).Run(ctx); err != nil && ctx.Err() == nil {
		fmt.Fprintf(os.Stderr, "client exited: %v\n", err)
		os.Exit(1)
	}
}

// runSelfUpdate applies a newer client build (checksum-verified) and exits;
// the supervisor or service wrapper restarts the process.
func runSelfUpdate(cfg *client.Config, force bool) {
	apiBases := []string{selfupdate.DefaultAPIBase}
	dlPrefixes := []string{}
	if m := os.Getenv("NP_UPDATE_API_BASES"); m != "" {
		apiBases = splitList(m)
	}
	if m := os.Getenv("NP_UPDATE_DOWNLOAD_PREFIXES"); m != "" {
		dlPrefixes = splitList(m)
	}
	latest, _, err := selfupdate.FetchLatest(apiBases)
	if err != nil {
		fmt.Fprintln(os.Stderr, "update check failed:", err)
		os.Exit(1)
	}
	if !force && !selfupdate.IsNewer(latest, client.Version) {
		fmt.Fprintf(os.Stderr, "already up to date (%s, latest %s)\n", client.Version, latest)
		return
	}
	version, err := selfupdate.SafeVersion(latest)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	asset := selfupdate.AssetName("node-proxy-client", runtime.GOOS, runtime.GOARCH)
	checksumURLs := selfupdate.AssetCandidates(selfupdate.Repo, latest, "checksums.sha256", dlPrefixes)
	checksums, err := selfupdate.FetchChecksums(checksumURLs)
	if err != nil {
		fmt.Fprintln(os.Stderr, "checksums unavailable:", err)
		os.Exit(1)
	}
	want, known := checksums[asset]
	if !known {
		fmt.Fprintf(os.Stderr, "release %s has no checksum for %s\n", latest, asset)
		os.Exit(1)
	}
	exePath, err := os.Executable()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	tmp := exePath + ".new"
	urls := selfupdate.AssetCandidates(selfupdate.Repo, latest, asset, dlPrefixes)
	if err := selfupdate.DownloadVerified(urls, tmp, want); err != nil {
		fmt.Fprintln(os.Stderr, "download failed:", err)
		os.Exit(1)
	}
	backup, err := selfupdate.SwapBinaryAt(exePath, tmp)
	if err != nil {
		fmt.Fprintln(os.Stderr, "swap failed:", err)
		os.Exit(1)
	}
	fmt.Fprintf(os.Stderr, "updated to %s (backup: %s); restart the client to run the new build\n", version, backup)
}

func splitList(s string) []string {
	var out []string
	for _, part := range strings.Split(s, ",") {
		if part = strings.TrimSpace(part); part != "" {
			out = append(out, part)
		}
	}
	return out
}

type quietLogger struct{}

func (quietLogger) Debugf(string, ...any)       {}
func (quietLogger) Infof(string, ...any)        {}
func (quietLogger) Info(string)                 {}
func (l quietLogger) Warnf(f string, a ...any)  { printf("WARN", f, a...) }
func (l quietLogger) Errorf(f string, a ...any) { printf("ERROR", f, a...) }
func (l quietLogger) Warn(m string)             { println("WARN", m) }
func (l quietLogger) Error(m string)            { println("ERROR", m) }
