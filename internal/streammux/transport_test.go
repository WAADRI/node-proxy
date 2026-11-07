package streammux

import (
	"errors"
	"sync"
)

// memTransport is a message-oriented in-memory pipe for session tests,
// standing in for the WebSocket. Messages are delivered whole, like WS
// binary/text frames.
type memTransport struct {
	peer      *memTransport
	inbox     chan memMsg
	closeOnce sync.Once
	closed    chan struct{}
}

type memMsg struct {
	data []byte
	text bool
}

func newMemPipe() (a, b *memTransport) {
	a = &memTransport{inbox: make(chan memMsg, 4096), closed: make(chan struct{})}
	b = &memTransport{inbox: make(chan memMsg, 4096), closed: make(chan struct{})}
	a.peer, b.peer = b, a
	return a, b
}

func (t *memTransport) ReadMessage() ([]byte, bool, error) {
	select {
	case m := <-t.inbox:
		return m.data, m.text, nil
	case <-t.closed:
		return nil, false, errors.New("transport closed")
	}
}

func (t *memTransport) WriteMessage(data []byte) error {
	select {
	case t.peer.inbox <- memMsg{data: append([]byte(nil), data...)}:
		return nil
	case <-t.closed:
		return errors.New("transport closed")
	}
}

// WriteTextMessage implements the TextWriter half.
func (t *memTransport) WriteTextMessage(data []byte) error {
	select {
	case t.peer.inbox <- memMsg{data: append([]byte(nil), data...), text: true}:
		return nil
	case <-t.closed:
		return errors.New("transport closed")
	}
}

func (t *memTransport) Close() error {
	t.closeOnce.Do(func() { close(t.closed) })
	return nil
}
