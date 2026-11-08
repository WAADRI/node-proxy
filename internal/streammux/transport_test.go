package streammux

import (
	"errors"
	"sync"
)

// memTransport is a message-oriented in-memory pipe for session tests,
// standing in for the WebSocket. Messages are delivered whole, like WS
// binary/text frames.
var errClosedMem = errors.New("transport closed")

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
		return nil, false, errClosedMem
	}
}

func (t *memTransport) WriteMessage(data []byte) error {
	select {
	case t.peer.inbox <- memMsg{data: append([]byte(nil), data...)}:
		return nil
	case <-t.closed:
		return errClosedMem
	}
}

// WriteTextMessage implements the TextWriter half.
func (t *memTransport) WriteTextMessage(data []byte) error {
	select {
	case t.peer.inbox <- memMsg{data: append([]byte(nil), data...), text: true}:
		return nil
	case <-t.closed:
		return errClosedMem
	}
}

func (t *memTransport) Close() error {
	t.closeOnce.Do(func() { close(t.closed) })
	return nil
}

// captureTransport records every outbound message (test-only).
type captureTransport struct {
	Transport
	sink *[][]byte
	mu   sync.Mutex
}

func (c *captureTransport) WriteMessage(data []byte) error {
	c.mu.Lock()
	*c.sink = append(*c.sink, append([]byte(nil), data...))
	c.mu.Unlock()
	return c.Transport.WriteMessage(data)
}

// snapshot copies the recorded messages under the same lock the writer uses.
func (c *captureTransport) snapshot() [][]byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([][]byte, len(*c.sink))
	copy(out, *c.sink)
	return out
}
