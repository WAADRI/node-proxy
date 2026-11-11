package wstransport

import (
	"context"
	"time"

	"github.com/gorilla/websocket"
)

// StartKeepalive arms ping/pong keepalive and deadlines on a gorilla
// WebSocket connection. Without this, a stalled TCP connection (no FIN,
// NAT timeout, cable pull) blocks ReadMessage and WriteMessage forever -
// the session goroutines pile up and eventually the HTTP handler stops
// responding.
//
//   - Sends a WS ping every pingPeriod; each ping also extends the write
//     deadline so data writes can't block past the next ping interval.
//   - Expects a pong within pongWait; extends the read deadline on every
//     pong. A dead connection trips the read deadline within pongWait.
//   - The session's own ReadMessage calls also qualify as "alive" signals
//     (data arrival = connection is not stuck), because gorilla delivers
//     control frames between data frames and the pong handler fires.
//
// Returns a cancel func; call it when the connection is torn down.
func StartKeepalive(conn *websocket.Conn, pingPeriod, pongWait time.Duration) context.CancelFunc {
	ctx, cancel := context.WithCancel(context.Background())

	extendRead := func() { conn.SetReadDeadline(time.Now().Add(pongWait)) }
	extendWrite := func() { conn.SetWriteDeadline(time.Now().Add(pingPeriod + 10*time.Second)) }

	extendRead()
	extendWrite()
	conn.SetPongHandler(func(string) error {
		extendRead()
		return nil
	})

	go func() {
		ticker := time.NewTicker(pingPeriod)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				extendWrite()
				if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second)); err != nil {
					cancel()
					return
				}
			}
		}
	}()
	return cancel
}
