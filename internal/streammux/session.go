package streammux

import (
	"encoding/json"
	"math"
	"strconv"
	"sync"
	"time"
)

// Options configures a session. Zero values select the protocol defaults
// shared with the TS implementation.
type Options struct {
	// InitialWindow is the per-stream send/receive window (default 64 KiB).
	InitialWindow int
	// ConnectionWindow is the connection-level window (default 1 MiB).
	ConnectionWindow int
	Logger           Logger
	// OnStream fires for every incoming HEADERS/HEADERS_END frame (new or
	// existing stream) and for TUNNEL_OPEN on a new stream, mirroring the TS
	// _onStream dispatcher. Called after the read loop released its lock, so
	// callbacks may send on the session.
	OnStream func(*Stream)
	// OnGoaway fires when the peer sends GOAWAY. The session ignores further
	// sends afterwards, exactly like the TS mux.
	OnGoaway func(lastStreamID int64)
	// OnText fires for inbound WS text frames - the JSON control plane
	// (auth/heartbeat/stats in the real deployment). The session itself never
	// parses them; without OnText they are ignored, mirroring the TS default.
	OnText func(data []byte)
}

// Conn is one StreamMux session over a Transport. It mirrors the TS StreamMux
// class: connection-level frame handling (PING/PONG/GOAWAY/WINDOW_UPDATE),
// stream bookkeeping, and the batched FIFO send queue gated by the
// connection-level window.
//
// goroutine model: one read loop, one writer loop. Callbacks (OnStream,
// OnGoaway, stream callbacks) run on the read loop after its lock is
// released, so they may call back into the session. The writer blocks on
// Transport.WriteMessage for backpressure - the TS equivalent polls
// ws.bufferedAmount and defers sends; a dedicated writer makes that hack
// unnecessary.
type Conn struct {
	tr   Transport
	log  Logger
	opts Options

	mu        sync.Mutex
	streams   map[uint32]*Stream
	nextID    uint32
	closed    bool
	sendQueue []sendItem // FIFO of frames and text messages awaiting flush
	pingCB    func(rtt int64)
	lastPing  int64

	connSendWindow int
	connRecvWindow int
	initialWindow  int

	sendSignal chan struct{} // new frames queued or window credited
	done       chan struct{} // closed when the session shuts down
	startOnce  sync.Once
}

// NewConn starts a session over tr: read loop, writer loop and the periodic
// receive-window check are running by the time it returns.
func NewConn(tr Transport, opts Options) *Conn {
	if opts.InitialWindow <= 0 {
		opts.InitialWindow = DefaultInitialWindow
	}
	if opts.ConnectionWindow <= 0 {
		opts.ConnectionWindow = DefaultConnectionWindow
	}
	c := &Conn{
		tr:             tr,
		log:            opts.Logger,
		opts:           opts,
		streams:        make(map[uint32]*Stream),
		nextID:         1, // odd ids, step 2 - both TS endpoints do this
		initialWindow:  opts.InitialWindow,
		connSendWindow: opts.ConnectionWindow,
		connRecvWindow: opts.ConnectionWindow,
		sendSignal:     make(chan struct{}, 1),
		done:           make(chan struct{}),
	}
	c.startOnce.Do(func() {
		go c.readLoop()
		go c.writerLoop()
		go c.windowCheckLoop()
	})
	return c
}

// CreateStream allocates a stream with the next odd id (TS createStream).
// Returns nil when the session is closed or MaxConcurrentStreams is reached.
func (c *Conn) CreateStream(priority int) *Stream {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.createStreamLocked(priority)
}

func (c *Conn) createStreamLocked(priority int) *Stream {
	if c.closed || len(c.streams) >= MaxConcurrentStreams {
		return nil
	}
	id := c.nextID
	c.nextID += 2
	s := newStream(id, c, priority)
	c.streams[id] = s
	return s
}

// OpenTunnel creates a stream and sends TUNNEL_OPEN {host,port} (TS openTunnel).
func (c *Conn) OpenTunnel(host string, port, priority int) *Stream {
	c.mu.Lock()
	defer c.mu.Unlock()
	s := c.createStreamLocked(priority)
	if s == nil {
		return nil
	}
	f, err := JSONFrame(TypeTunnelOpen, s.id, 0, TunnelOpen{Host: host, Port: port})
	if err != nil {
		return nil
	}
	c.enqueueLocked(f)
	s.state = StateOpen
	s.headers = TunnelOpen{Host: host, Port: port}
	return s
}

// SendTunnelData sends data on an existing tunnel stream (TS sendTunnelData).
func (c *Conn) SendTunnelData(streamID uint32, data []byte) bool {
	c.mu.Lock()
	s := c.streams[streamID]
	c.mu.Unlock()
	if s == nil {
		return false
	}
	return s.SendData(data, false)
}

// CloseTunnel gracefully closes a tunnel: END_STREAM first, then
// TUNNEL_CLOSE {reason}, then removal (TS closeTunnel, including the ordering
// that fixed its slot leak).
func (c *Conn) CloseTunnel(streamID uint32, reason any) {
	c.mu.Lock()
	s, ok := c.streams[streamID]
	if !ok {
		c.mu.Unlock()
		return
	}
	onEnd := s.closeLocked()
	if f, err := JSONFrame(TypeTunnelClose, streamID, 0, Reason{Reason: reason}); err == nil {
		c.enqueueLocked(f)
	}
	s.state = StateClosed
	c.removeStreamLocked(streamID)
	c.mu.Unlock()
	if onEnd != nil {
		onEnd()
	}
}

// Ping sends PING {time} and reports the RTT via cb once (TS ping).
func (c *Conn) Ping(cb func(rtt int64)) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return false
	}
	c.lastPing = time.Now().UnixMilli()
	c.pingCB = cb
	f, _ := JSONFrame(TypePing, 0, 0, PingTime{Time: c.lastPing})
	c.enqueueLocked(f)
	return true
}

// Goaway sends GOAWAY and stops accepting new sends, leaving already queued
// frames to drain (TS goaway). The transport stays open.
func (c *Conn) Goaway(lastStreamID int64) {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	f, _ := JSONFrame(TypeGoAway, 0, 0, Goaway{LastStreamID: lastStreamID})
	c.enqueueLocked(f)
	c.closed = true
	streams := c.takeStreamsLocked("goaway")
	c.mu.Unlock()
	c.closeStreams(streams)
}

// Destroy force-closes everything and closes the transport (TS destroy).
func (c *Conn) Destroy() {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	c.sendQueue = nil
	streams := c.takeStreamsLocked("destroyed")
	c.mu.Unlock()

	close(c.done)
	_ = c.tr.Close()
	c.closeStreams(streams) // OnError only; TS destroy does not call onEnd
}

// Close shuts the session down like a transport drop: streams get OnError
// ("connection_closed"), the transport is closed, queued frames are dropped.
func (c *Conn) Close() {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	streams := c.takeStreamsLocked("connection_closed")
	c.mu.Unlock()

	close(c.done)
	_ = c.tr.Close()
	c.closeStreams(streams)
}

// Done is closed when the session shuts down.
func (c *Conn) Done() <-chan struct{} { return c.done }

// Stats mirrors getStats() in TypeScript.
type Stats struct {
	ActiveStreams        int
	TotalStreams         int
	ConnectionSendWindow int
	ConnectionRecvWindow int
	RTT                  int64
	BufferedFrames       int
	Streams              []StreamStats
}

func (c *Conn) Stats() Stats {
	c.mu.Lock()
	defer c.mu.Unlock()
	st := Stats{
		ConnectionSendWindow: c.connSendWindow,
		ConnectionRecvWindow: c.connRecvWindow,
		BufferedFrames:       len(c.sendQueue),
		TotalStreams:         len(c.streams),
	}
	for _, s := range c.streams {
		ss := s.statsLocked()
		st.Streams = append(st.Streams, ss)
		switch ss.State {
		case StateOpen, StateHalfClosedLocal, StateHalfClosedRemote:
			st.ActiveStreams++
		}
	}
	return st
}

// ---------------------------------------------------------------------------
// Session-internal helpers. Methods suffixed Locked require c.mu.
// ---------------------------------------------------------------------------

// takeStreamsLocked empties the stream map, marking every stream closed.
// reason feeds Stream.OnError, matching the TS close paths
// ('goaway' / 'destroyed' / 'connection_closed').
func (c *Conn) takeStreamsLocked(reason string) []*Stream {
	streams := make([]*Stream, 0, len(c.streams))
	for _, s := range c.streams {
		s.state = StateClosed
		s.closeReason = reason
		streams = append(streams, s)
	}
	c.streams = make(map[uint32]*Stream)
	return streams
}

func (c *Conn) closeStreams(streams []*Stream) {
	for _, s := range streams {
		if fn := s.onError; fn != nil {
			fn(s.closeReason)
		}
	}
}

func (c *Conn) removeStreamLocked(id uint32) { delete(c.streams, id) }

func (c *Conn) signalWriterLocked() {
	select {
	case c.sendSignal <- struct{}{}:
	default:
	}
}

// sendItem is one entry of the send queue: a mux frame, or an out-of-band
// WS text message (JSON control plane). Text mirrors TS, where JSON sends
// (sock.send) and mux frame batches share the single ws send queue FIFO.
type sendItem struct {
	frame  Frame
	text   []byte
	isFram bool
}

// enqueueLocked appends a frame to the send queue.
func (c *Conn) enqueueLocked(f Frame) {
	if len(f.Payload) > MaxFrameSize {
		// The TS send path chunks before queuing, so oversized frames never
		// reach this point; guard anyway since the receiver drops them.
		if c.log != nil {
			c.log.Warnf("streammux: dropping frame %s: payload exceeds MaxFrameSize", f.Type)
		}
		return
	}
	c.sendQueue = append(c.sendQueue, sendItem{isFram: true, frame: f})
	c.signalWriterLocked()
}

// SendText queues a WS text message (JSON control plane) on the same FIFO as
// mux frames, so its ordering relative to frames matches the TS client. It
// reports false when the session is closed or the transport cannot carry text.
func (c *Conn) SendText(data []byte) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return false
	}
	if _, ok := c.tr.(TextWriter); !ok {
		return false
	}
	c.sendQueue = append(c.sendQueue, sendItem{text: append([]byte(nil), data...)})
	c.signalWriterLocked()
	return true
}

// sendFrameLocked queues a frame unless the session is closed (TS _sendFrame
// entry check).
func (c *Conn) sendFrameLocked(f Frame) {
	if c.closed {
		return
	}
	c.enqueueLocked(f)
}

// ---------------------------------------------------------------------------
// Read loop
// ---------------------------------------------------------------------------

func (c *Conn) readLoop() {
	for {
		data, isText, err := c.tr.ReadMessage()
		if err != nil {
			c.Close()
			return
		}
		if isText {
			// JSON control plane (auth/heartbeat/stats in the real
			// deployment). Without OnText the frame is ignored - the TS mux
			// similarly only reacts to legacy {type:"ping"}.
			if fn := c.opts.OnText; fn != nil {
				fn(data)
			}
			continue
		}
		frames, err := ParseMessage(data)
		if err != nil {
			if c.log != nil {
				c.log.Warnf("streammux: dropping malformed message: %v", err)
			}
			continue // drop, keep the connection alive (TS policy)
		}
		c.dispatch(frames)
	}
}

// dispatch handles one message's frames. Each frame is processed under the
// lock and its callbacks fired after releasing it, one frame at a time.
//
// This per-frame lock cycling is deliberate: the TS mux fires _onStream (and
// stream callbacks) synchronously DURING message processing, so a TUNNEL_OPEN
// batched with DATA makes its handler visible before the DATA frames are
// dispatched. Deferring OnStream to end-of-message would silently drop those
// frames' payloads for late-attaching consumers.
func (c *Conn) dispatch(frames []Frame) {
	for _, f := range frames {
		type invocation func()
		var fire []invocation

		c.mu.Lock()
		// Connection-level DATA accounting happens before any stream logic,
		// regardless of stream id (TS _handleFrame).
		if f.Type == TypeData && len(f.Payload) > 0 {
			c.connRecvWindow -= len(f.Payload)
			c.checkConnectionWindowLocked()
		}
		switch {
		case f.StreamID == 0:
			if fn := c.handleConnectionFrameLocked(f); fn != nil {
				fire = append(fire, fn)
			}
		case f.Type == TypeHeaders || f.Type == TypeHeadersEnd:
			s := c.streams[f.StreamID]
			if s == nil {
				s = newStream(f.StreamID, c, DefaultPriority)
				c.streams[f.StreamID] = s
			}
			if fn := s.handleFrameLocked(f); fn != nil {
				fire = append(fire, fn)
			}
			if fn := c.opts.OnStream; fn != nil {
				stream := s
				fire = append(fire, func() { fn(stream) }) // every HEADERS, new or not (TS parity)
			}
		case f.Type == TypeTunnelOpen:
			if c.streams[f.StreamID] == nil {
				s := newStream(f.StreamID, c, DefaultPriority)
				var open TunnelOpen
				if err := json.Unmarshal(f.Payload, &open); err != nil && c.log != nil {
					c.log.Warnf("streammux: bad TUNNEL_OPEN payload: %v", err)
				}
				s.headers = open
				s.state = StateOpen
				c.streams[f.StreamID] = s
				if fn := c.opts.OnStream; fn != nil {
					stream := s
					fire = append(fire, func() { fn(stream) })
				}
			} // TUNNEL_OPEN on an existing stream is ignored (TS parity)
		default:
			if s := c.streams[f.StreamID]; s != nil {
				if fn := s.handleFrameLocked(f); fn != nil {
					fire = append(fire, fn)
				}
			} // frames on unknown streams are dropped (TS parity)
		}
		c.mu.Unlock()

		for _, fn := range fire {
			fn()
		}
	}
}

// handleConnectionFrameLocked dispatches stream-id-0 frames (TS
// _handleConnectionFrame). Invalid JSON payloads are dropped.
func (c *Conn) handleConnectionFrameLocked(f Frame) func() {
	var payload struct {
		Time         *int64 `json:"time"`
		LastStreamID *int64 `json:"lastStreamId"`
		Increment    any    `json:"increment"`
	}
	if err := json.Unmarshal(f.Payload, &payload); err != nil {
		if c.log != nil {
			c.log.Warnf("streammux: dropping connection frame %s with invalid payload", f.Type)
		}
		return nil
	}

	switch f.Type {
	case TypePing:
		// Reply PONG echoing the peer's payload bytes (TS re-marshals the
		// parsed object; for the single-key payloads in use this is the same).
		c.sendFrameLocked(NewFrame(TypePong, 0, 0, f.Payload))
	case TypePong:
		if c.pingCB != nil {
			cb := c.pingCB
			c.pingCB = nil
			peerTime := int64(0)
			if payload.Time != nil {
				peerTime = *payload.Time
			}
			if peerTime == 0 {
				peerTime = c.lastPing
			}
			rtt := time.Now().UnixMilli() - peerTime
			return func() { cb(rtt) }
		}
	case TypeGoAway:
		c.closed = true
		lastStreamID := int64(0)
		if payload.LastStreamID != nil {
			lastStreamID = *payload.LastStreamID
		}
		if fn := c.opts.OnGoaway; fn != nil {
			return func() { fn(lastStreamID) }
		}
	case TypeWindowUpdate:
		if inc, ok := coerceIncrement(payload.Increment); ok && inc > 0 && inc <= MaxWindowIncrement {
			c.connSendWindow += int(inc)
			c.signalWriterLocked() // resume a flush the connection window stalled
		} else if c.log != nil {
			c.log.Debugf("streammux: ignoring invalid WINDOW_UPDATE increment %v", payload.Increment)
		}
	}
	return nil
}

// coerceIncrement accepts a JSON number or numeric string, mirroring the TS
// Number(p.increment) coercion; non-integers are rejected like
// Number.isInteger would.
func coerceIncrement(v any) (int64, bool) {
	switch n := v.(type) {
	case float64:
		if n != math.Trunc(n) {
			return 0, false
		}
		return int64(n), true
	case string:
		i, err := strconv.ParseInt(n, 10, 64)
		return i, err == nil
	default:
		return 0, false
	}
}

// checkConnectionWindowLocked credits the peer when our receive window drops
// below half (TS _checkConnectionWindow).
func (c *Conn) checkConnectionWindowLocked() {
	if c.connRecvWindow < DefaultConnectionWindow/2 {
		increment := DefaultConnectionWindow - c.connRecvWindow
		c.connRecvWindow += increment
		f, _ := JSONFrame(TypeWindowUpdate, 0, 0, WindowUpdate{Increment: int64(increment)})
		c.sendFrameLocked(f)
	}
}

// ---------------------------------------------------------------------------
// Writer loop
// ---------------------------------------------------------------------------

// writerLoop drains the send queue one WS message per pass, mirroring the TS
// flush: batch the queued frames (<= MaxBatchBytes) when there are two or
// more, send a lone frame as-is; stall DATA when the connection send window is
// exhausted until the peer credits WINDOW_UPDATE. Text messages are sent one
// per pass and never batched (TS sends them as individual sock.send calls).
func (c *Conn) writerLoop() {
	for {
		c.mu.Lock()
		for len(c.sendQueue) == 0 {
			if c.closed {
				c.mu.Unlock()
				return
			}
			c.mu.Unlock()
			select {
			case <-c.sendSignal:
			case <-c.done:
				return
			}
			c.mu.Lock()
		}

		// Take the head item; gather a run of frames behind it into a batch.
		var batch []Frame
		if c.sendQueue[0].isFram {
			total := 0
			cut := 0
			for cut < len(c.sendQueue) && c.sendQueue[cut].isFram {
				f := c.sendQueue[cut].frame
				if cut > 0 && total+len(f.Payload)+HeaderSize > MaxBatchBytes {
					break
				}
				total += len(f.Payload) + HeaderSize
				cut++
			}
			batch = make([]Frame, 0, cut)
			for i := 0; i < cut; i++ {
				batch = append(batch, c.sendQueue[i].frame)
			}

			// Connection window gate: only DATA is flow-controlled.
			dataBytes := 0
			for _, f := range batch {
				if f.Type == TypeData {
					dataBytes += len(f.Payload)
				}
			}
			if dataBytes > 0 && c.connSendWindow <= 0 {
				// Wait for window credit; the queue is untouched (TS re-queues
				// the batch identically).
				c.mu.Unlock()
				select {
				case <-c.sendSignal:
				case <-c.done:
					return
				}
				continue
			}
			c.sendQueue = c.sendQueue[cut:]
			c.connSendWindow -= dataBytes
		}

		var (
			wire []byte
			text []byte
		)
		if batch == nil {
			text = c.sendQueue[0].text
			c.sendQueue = c.sendQueue[1:]
		}
		c.mu.Unlock()

		if text != nil {
			tw, ok := c.tr.(TextWriter)
			if !ok {
				continue
			}
			if err := tw.WriteTextMessage(text); err != nil {
				if c.log != nil {
					c.log.Errorf("streammux: transport text write failed: %v", err)
				}
				c.Close()
				return
			}
			continue
		}

		if len(batch) == 1 {
			wire = batch[0].MustEncode()
		} else {
			encoded, err := EncodeBatch(batch)
			if err != nil {
				if c.log != nil {
					c.log.Errorf("streammux: batch encode failed: %v", err)
				}
				continue
			}
			wire = encoded
		}
		if err := c.tr.WriteMessage(wire); err != nil {
			if c.log != nil {
				c.log.Errorf("streammux: transport write failed: %v", err)
			}
			c.Close()
			return
		}
	}
}

// windowCheckLoop mirrors the TS 1s interval that re-checks the receive
// window (belt-and-braces; DATA receipt already triggers the check).
func (c *Conn) windowCheckLoop() {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-c.done:
			return
		case <-ticker.C:
			c.mu.Lock()
			c.checkConnectionWindowLocked()
			c.mu.Unlock()
		}
	}
}
