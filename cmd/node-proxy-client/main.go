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
	"syscall"

	"github.com/WAADRI/node-proxy-go/internal/client"
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
	flag.Parse()

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

type quietLogger struct{}

func (quietLogger) Debugf(string, ...any)       {}
func (quietLogger) Infof(string, ...any)        {}
func (quietLogger) Info(string)                 {}
func (l quietLogger) Warnf(f string, a ...any)  { printf("WARN", f, a...) }
func (l quietLogger) Errorf(f string, a ...any) { printf("ERROR", f, a...) }
func (l quietLogger) Warn(m string)             { println("WARN", m) }
func (l quietLogger) Error(m string)            { println("ERROR", m) }
