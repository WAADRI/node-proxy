// Package wstransport adapts gorilla/websocket connections to the
// streammux.Transport interface, so a streammux.Conn session can run over a
// real WebSocket.
package wstransport

import (
	"github.com/gorilla/websocket"

	"github.com/WAADRI/node-proxy-go/internal/streammux"
)

// Transport wraps a gorilla WebSocket connection. It is not safe for
// concurrent use by multiple readers or multiple writers; gorilla allows one
// concurrent reader and one concurrent writer, which matches the streammux
// session model (one read loop, one writer loop).
type Transport struct {
	conn *websocket.Conn
}

// Wrap adapts an established gorilla connection.
func Wrap(conn *websocket.Conn) *Transport { return &Transport{conn: conn} }

// ReadMessage returns the next message. Binary frames surface as data with
// isText=false; text frames (legacy JSON in the TS protocol) surface with
// isText=true so the session can apply its legacy policy.
func (t *Transport) ReadMessage() (data []byte, isText bool, err error) {
	mt, payload, err := t.conn.ReadMessage()
	if err != nil {
		return nil, false, err
	}
	return payload, mt == websocket.TextMessage, nil
}

// WriteMessage sends one binary message. The streammux writer goroutine is
// the only writer, satisfying gorilla's single-writer requirement.
func (t *Transport) WriteMessage(data []byte) error {
	return t.conn.WriteMessage(websocket.BinaryMessage, data)
}

// WriteTextMessage sends one text message (JSON control plane).
func (t *Transport) WriteTextMessage(data []byte) error {
	return t.conn.WriteMessage(websocket.TextMessage, data)
}

// Close closes the underlying connection. gorilla tolerates concurrent Close
// with in-flight writes; a normal closure is sent first.
func (t *Transport) Close() error {
	return t.conn.Close()
}

// Compile-time interface check.
var _ streammux.Transport = (*Transport)(nil)
