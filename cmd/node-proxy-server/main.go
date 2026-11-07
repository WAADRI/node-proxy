// node-proxy-server is the Go rewrite of the node-proxy server (data plane
// strangler step 1): client registration over WebSocket + HTTP/SOCKS5 proxy
// ports + minimal panel API.
package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/WAADRI/node-proxy-go/internal/server"
)

type stderrLogger struct{}

func (stderrLogger) Debugf(string, ...any) {}
func (stderrLogger) Infof(f string, a ...any) {
	fmt.Fprintf(os.Stderr, "[INFO] "+f+"\n", a...)
}
func (stderrLogger) Warnf(f string, a ...any) {
	fmt.Fprintf(os.Stderr, "[WARN] "+f+"\n", a...)
}
func (stderrLogger) Errorf(f string, a ...any) {
	fmt.Fprintf(os.Stderr, "[ERROR] "+f+"\n", a...)
}

// auditFilePath places the JSONL audit log next to the runtime overrides.
func auditFilePath() string {
	if p := os.Getenv("CONFIG_PATH"); p != "" {
		if i := strings.LastIndexAny(p, `/`+string(os.PathSeparator)); i >= 0 {
			return p[:i+1] + "runtime-audit.jsonl"
		}
	}
	return "runtime-audit.jsonl"
}

func main() {
	cfg, err := server.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "config: %v\n", err)
		os.Exit(2)
	}
	log := stderrLogger{}
	srv := &server.Server{Cfg: cfg, Mgr: server.NewManager(cfg, log), Log: log}
	srv.Settings = server.NewSettings(srv)
	srv.Mgr.SetMetaLookup(srv.Settings.ClientMetaFor)
	srv.Settings.LoadPersisted()
	srv.Metrics = server.NewMetrics()
	srv.Mgr.SetErrorHook(func(id string) { srv.Metrics.ObserveError("node", id) })
	srv.ACL = server.NewACL()
	srv.DomainRouter = &server.DomainRouter{}
	srv.ProxyPasswords = &[]*server.ProxyPassword{}
	srv.Users = server.NewUserStore(cfg.Web.Username, cfg.Web.Password)
	srv.Cache = server.NewResponseCache(5*time.Minute, 256)
	srv.Bandwidth = server.NewBandwidthLimiter()
	srv.Audit = server.NewAuditLog(5000)
	srv.Bandwidth.ApplyConfig(map[string]any{"enabled": false})
	srv.NetTest = server.NewNetTestManager(srv)
	srv.Audit.LoadFromFile(auditFilePath())
	srv.Audit.SetPersistPath(auditFilePath())

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Panel + client WebSocket on the web port (TS shape: /ws upgrade on the
	// same server as the panel).
	mux := http.NewServeMux()
	srv.HandlePanelAPI(mux)
	mux.HandleFunc("/ws", srv.HandleClientWS)
	// /metrics is public, matching the TS server (Grafana compat).
	mux.Handle("/metrics", srv.Metrics.Handler(srv))
	acmeMgr := server.BuildACMEManager(cfg, cfg.ACME)
	webSrv := &http.Server{Addr: net.JoinHostPort(cfg.Host, fmt.Sprint(cfg.WebPort)), Handler: mux}
	go func() {
		if acmeMgr != nil {
			log.Infof("web/panel serving HTTPS via ACME for %v (HTTP-01 on :80)", cfg.ACME.Domains)
			go http.ListenAndServe(":80", acmeMgr.HTTPHandler(nil))
			if err := webSrv.ListenAndServeTLS("", ""); err != nil && ctx.Err() == nil {
				log.Errorf("web server: %v", err)
			}
			return
		}
		log.Infof("web/panel listening on %s (ws at /ws)", webSrv.Addr)
		if err := webSrv.ListenAndServe(); err != nil && ctx.Err() == nil {
			log.Errorf("web server: %v", err)
		}
	}()

	// HTTP proxy port.
	httpProxy := &http.Server{
		Addr:    net.JoinHostPort(cfg.Host, fmt.Sprint(cfg.HTTPProxyPort)),
		Handler: http.HandlerFunc(srv.HandleHTTPProxy),
	}
	go func() {
		log.Infof("http proxy listening on %s", httpProxy.Addr)
		if err := httpProxy.ListenAndServe(); err != nil && ctx.Err() == nil {
			log.Errorf("http proxy: %v", err)
		}
	}()

	// SOCKS5 port.
	socksLn, err := net.Listen("tcp", net.JoinHostPort(cfg.Host, fmt.Sprint(cfg.SOCKS5Port)))
	if err != nil {
		fmt.Fprintf(os.Stderr, "socks5 listen: %v\n", err)
		os.Exit(1)
	}
	log.Infof("socks5 listening on %s", socksLn.Addr())
	go func() {
		for {
			conn, err := socksLn.Accept()
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				continue
			}
			go srv.HandleSOCKS5(conn)
		}
	}()

	<-ctx.Done()
	log.Infof("shutting down")
	_ = webSrv.Close()
	_ = httpProxy.Close()
	_ = socksLn.Close()
}
