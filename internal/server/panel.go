package server

import (
	"io/fs"
	"net/http"
	"strings"

	"github.com/WAADRI/node-proxy-go/panel"
)

// HandlePanelRoutes mounts the web panel: the login page, the built Vue app
// under /app (SPA fallback to index.html), mirroring the TS static mounting.
func (s *Server) HandlePanelRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/login", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(panel.LoginHTML)
	})
	mux.HandleFunc("/login.js", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		_, _ = w.Write(panel.LoginJS)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		http.Redirect(w, r, "/app/", http.StatusFound)
	})

	dist, err := fs.Sub(panel.Dist, "dist")
	if err != nil {
		return
	}
	appHandler := http.FileServerFS(dist)
	mux.HandleFunc("/app", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/app/", http.StatusFound)
	})
	mux.HandleFunc("/app/", func(w http.ResponseWriter, r *http.Request) {
		// SPA fallback: unknown paths render the app shell (vue-router takes
		// over). StripPrefix is required - FileServerFS resolves the FULL
		// URL path against the dist root.
		rel := strings.TrimPrefix(r.URL.Path, "/app/")
		if rel != "" {
			if f, err := dist.Open(rel); err == nil {
				f.Close()
				http.StripPrefix("/app/", appHandler).ServeHTTP(w, r)
				return
			}
		}
		index, err := fs.ReadFile(dist, "index.html")
		if err != nil {
			http.Error(w, "管理面板尚未构建。请在 panel 目录执行 npm ci && npm run build 后重新编译。", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(index)
	})
}
