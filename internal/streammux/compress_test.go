package streammux

import (
	"bytes"
	"crypto/rand"
	"encoding/binary"
	"strings"
	"sync"
	"testing"
	"time"
)

// countingTransport wraps a transport and counts wire bytes (one direction:
// WriteMessage).
type countingTransport struct {
	inner Transport
	mu    sync.Mutex
	bytes int
}

func (c *countingTransport) ReadMessage() ([]byte, bool, error) { return c.inner.ReadMessage() }
func (c *countingTransport) WriteMessage(data []byte) error {
	c.mu.Lock()
	c.bytes += len(data)
	c.mu.Unlock()
	return c.inner.WriteMessage(data)
}
func (c *countingTransport) Close() error { return c.inner.Close() }

func (c *countingTransport) written() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.bytes
}

// wireDataFrames walks recorded WS messages and returns every DATA frame as
// (flags, payloadLen). Handles both single-frame messages and batch messages
// ([2B count][frame]...) the way ParseMessage does.
func wireDataFrames(messages [][]byte) (flags []uint32, payloadLens []int) {
	for _, msg := range messages {
		off := 0
		batched := len(msg) >= 2 && binary.BigEndian.Uint16(msg[0:2]) >= 2
		if batched {
			off = 2
		}
		for off+HeaderSize <= len(msg) {
			if batched && binary.BigEndian.Uint16(msg[off:off+2]) >= 2 && binary.BigEndian.Uint16(msg[off:off+2]) != 0 {
				// count field of a (nested) batch: not a frame length; stop.
				break
			}
			length := int(binary.BigEndian.Uint32(msg[off : off+4]))
			if length > MaxFrameSize || off+HeaderSize+length > len(msg) {
				break
			}
			if FrameType(msg[off+4]) == TypeData {
				flags = append(flags, binary.BigEndian.Uint32(msg[off+9:off+13]))
				payloadLens = append(payloadLens, length)
			}
			off += HeaderSize + length
		}
	}
	return flags, payloadLens
}

// waitEnabled polls until both conns negotiated.
func waitEnabled(t *testing.T, a, b *Conn) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if a.compress != nil && a.compress.Enabled() && b.compress != nil && b.compress.Enabled() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("negotiation never completed")
}

// TestCompressionNegotiation covers the offer/select handshake.
func TestCompressionNegotiation(t *testing.T) {
	cA, cB := newMemPipe()
	initiator := NewConn(cA, Options{Compression: &CompressionConfig{Enabled: true}, CompressInitiator: true})
	acceptor := NewConn(cB, Options{Compression: &CompressionConfig{Enabled: true}})
	t.Cleanup(func() {
		initiator.Close()
		acceptor.Close()
		initiator.compress.Close()
		acceptor.compress.Close()
	})
	waitEnabled(t, initiator, acceptor)
}

// TestCompressedRoundTrip drives a large compressible payload through a
// negotiated connection: integrity holds and the wire carries far fewer
// bytes than the logical payload.
func TestCompressedRoundTrip(t *testing.T) {
	cA, cB := newMemPipe()
	ctA := &countingTransport{inner: cA}
	ctB := &countingTransport{inner: cB}
	_ = ctB

	payload := bytes.Repeat([]byte("compressible text line for the proxy relay\n"), 6000) // ~258KB

	var (
		mu       sync.Mutex
		received []byte
		ended    = make(chan struct{})
	)
	server := NewConn(ctB, Options{Compression: &CompressionConfig{Enabled: true}})
	server.opts.CompressInitiator = false
	server.opts.OnStream = func(s *Stream) {
		s.OnData(func(chunk []byte) {
			mu.Lock()
			received = append(received, chunk...)
			mu.Unlock()
		})
		s.OnEnd(func() { close(ended) })
	}
	client := NewConn(ctA, Options{Compression: &CompressionConfig{Enabled: true}, CompressInitiator: true})
	t.Cleanup(func() {
		client.Close()
		server.Close()
		client.compress.Close()
		server.compress.Close()
	})
	waitEnabled(t, client, server)

	st := client.OpenTunnel("compress.test", 1, DefaultPriority)
	if st == nil {
		t.Fatal("OpenTunnel nil")
	}
	if !st.SendData(payload, true) {
		t.Fatal("SendData failed")
	}
	select {
	case <-ended:
	case <-time.After(15 * time.Second):
		t.Fatal("timed out waiting for stream end")
	}
	mu.Lock()
	defer mu.Unlock()
	if !bytes.Equal(received, payload) {
		t.Fatalf("payload corrupted: got %d bytes, want %d", len(received), len(payload))
	}
	// The wire carried the compressed frames: expect well under half.
	wire := ctA.written()
	ratio := float64(wire) / float64(len(payload))
	if ratio > 0.5 {
		t.Fatalf("wire %d bytes for %d payload (ratio %.2f) - compression not effective", wire, len(payload), ratio)
	}
	t.Logf("wire %d / payload %d (ratio %.2f)", wire, len(payload), ratio)
}

// TestIncompressibleSkipped sends random data (already high-entropy): frames
// must go out WITHOUT the compressed flag (ratio heuristic) and still arrive
// intact.
func TestIncompressibleSkipped(t *testing.T) {
	cA, cB := newMemPipe()
	ctB := &countingTransport{inner: cB}
	var messages [][]byte
	capA := &captureTransport{Transport: cA, sink: &messages}
	ctA := &countingTransport{inner: capA}

	payload := make([]byte, 64*1024)
	if _, err := rand.Read(payload); err != nil {
		t.Fatal(err)
	}

	var (
		mu    sync.Mutex
		got   []byte
		ended = make(chan struct{})
	)
	server := NewConn(ctB, Options{Compression: &CompressionConfig{Enabled: true}})
	server.opts.CompressInitiator = false
	server.opts.OnStream = func(s *Stream) {
		s.OnData(func(chunk []byte) {
			mu.Lock()
			got = append(got, chunk...)
			mu.Unlock()
		})
		s.OnEnd(func() { close(ended) })
	}
	client := NewConn(ctA, Options{Compression: &CompressionConfig{Enabled: true}, CompressInitiator: true})
	t.Cleanup(func() {
		client.Close()
		server.Close()
		client.compress.Close()
		server.compress.Close()
	})
	waitEnabled(t, client, server)

	st := client.OpenTunnel("incompressible.test", 1, DefaultPriority)
	st.SendData(payload, true)
	select {
	case <-ended:
	case <-time.After(15 * time.Second):
		t.Fatal("timed out")
	}
	mu.Lock()
	defer mu.Unlock()
	if !bytes.Equal(got, payload) {
		t.Fatalf("payload corrupted: %d bytes", len(got))
	}

	flags, lens := wireDataFrames(capA.snapshot())
	if len(flags) == 0 {
		t.Fatal("no DATA frames observed")
	}
	for i, f := range flags {
		if f&FlagCompressed != 0 {
			t.Fatalf("incompressible frame %d was compressed (payload %d)", i, lens[i])
		}
	}
}

// TestTSCompatGuard proves the backward-compat story: a peer WITHOUT
// compression support never receives compressed frames, even though the
// initiator offered (its COMPRESS frame is ignored like any unknown type).
func TestTSCompatGuard(t *testing.T) {
	cA, cB := newMemPipe()
	var messages [][]byte
	capA := &captureTransport{Transport: cA, sink: &messages}
	ctA := &countingTransport{inner: capA}

	// The "TS peer": plain conn, no compression, records every raw message.
	var peerMsgs [][]byte
	peer := NewConn(cB, Options{})
	peer.opts.OnStream = func(s *Stream) {
		// A TS server accepts tunnels but never negotiates compression.
		s.OnData(func([]byte) {})
	}
	t.Cleanup(peer.Close)

	client := NewConn(ctA, Options{Compression: &CompressionConfig{Enabled: true}, CompressInitiator: true})
	t.Cleanup(func() {
		client.Close()
		client.compress.Close()
	})

	st := client.OpenTunnel("tscompat.test", 1, DefaultPriority)
	st.SendData([]byte(strings.Repeat("plaintext line\n", 2000)), true)

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && ctA.written() == 0 {
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(300 * time.Millisecond)

	snapshot := capA.snapshot()
	flags, _ := wireDataFrames(snapshot)
	if len(flags) == 0 {
		t.Fatal("no DATA frames on the wire")
	}
	for i, f := range flags {
		if f&FlagCompressed != 0 {
			t.Fatalf("frame %d compressed despite non-negotiating peer", i)
		}
	}
	_ = peerMsgs
	_ = peer
}
