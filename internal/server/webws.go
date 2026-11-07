package server

import (
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// webHub serves GET /web-ws: the panel's live feed. On connect it pushes the
// current status snapshot, then re-pushes on a short ticker (the TS hub
// pushes on change; a 3s ticker is the Go-equivalent without change-hook
// plumbing) and streams new request-log entries as they are recorded.
type webHub struct {
	srv *Server

	mu    sync.Mutex
	conns map[*websocket.Conn]bool

	logSubsMu sync.Mutex
	logSubs   []func(requestLogEntry)
	logHooked bool
}

var panelUpgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin:     func(*http.Request) bool { return true }, // same-origin panel; token gates access
}

func (s *Server) HandleWebWS(w http.ResponseWriter, r *http.Request) {
	// Token from the query string (the panel passes it explicitly; TS reads
	// cookie first for CSRF reasons - the query token is JWT-validated the
	// same way here).
	if s.Cfg.Web.Enabled {
		token := r.URL.Query().Get("token")
		if token == "" {
			if c, err := r.Cookie("token"); err == nil {
				token = c.Value
			}
		}
		if token == "" || !jwtValid(token, secretKey) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
	}
	conn, err := panelUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}

	hub := s.webWS()
	hub.mu.Lock()
	hub.conns[conn] = true
	hub.mu.Unlock()

	hub.pushStatus(conn)
	hub.hookRequestLog()

	go func() {
		defer func() {
			hub.mu.Lock()
			delete(hub.conns, conn)
			hub.mu.Unlock()
			_ = conn.Close()
		}()
		conn.SetReadLimit(4096)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()

	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		hub.mu.Lock()
		alive := hub.conns[conn]
		hub.mu.Unlock()
		if !alive {
			return
		}
		if !hub.pushStatus(conn) {
			return
		}
	}
}

func (s *Server) webWS() *webHub {
	s.wsOnce.Do(func() {
		s.WS = &webHub{srv: s, conns: map[*websocket.Conn]bool{}}
	})
	return s.WS
}

// pushStatus writes one status snapshot; false means the connection died.
func (h *webHub) pushStatus(conn *websocket.Conn) bool {
	_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err := conn.WriteJSON(map[string]any{"type": "status", "data": h.srv.buildStatusPayload()}); err != nil {
		return false
	}
	return true
}

// hookRequestLog wires the manager's request log to a live broadcast (once).
func (h *webHub) hookRequestLog() {
	h.logSubsMu.Lock()
	defer h.logSubsMu.Unlock()
	if h.logHooked {
		return
	}
	h.logHooked = true
	h.srv.Mgr.OnRequestLog(func(e requestLogEntry) {
		h.mu.Lock()
		targets := make([]*websocket.Conn, 0, len(h.conns))
		for c := range h.conns {
			targets = append(targets, c)
		}
		h.mu.Unlock()
		for _, c := range targets {
			_ = c.SetWriteDeadline(time.Now().Add(5 * time.Second))
			_ = c.WriteJSON(map[string]any{"type": "log", "data": e})
		}
	})
}
