package streammux

import (
	"encoding/json"
	"time"
)

// Stream states, kept as the same strings the TS implementation uses so
// stats/panel parity holds.
const (
	StateIdle             = "idle"
	StateReserved         = "reserved"
	StateOpen             = "open"
	StateHalfClosedLocal  = "half_closed_local"
	StateHalfClosedRemote = "half_closed_remote"
	StateClosed           = "closed"
)

// Stream is one multiplexed stream, mirroring the TS Stream class: window
// accounting, chunked sends with buffering, END_STREAM half-close semantics.
//
// Callbacks fire on the session read loop after the session lock is released,
// so they may call SendData and friends. Set them before traffic flows.
type Stream struct {
	id       uint32
	c        *Conn
	state    string
	priority int

	sendWindow int
	recvWindow int

	buffered     [][]byte // outgoing data waiting for send window
	bufferedSize int
	pendingEnd   bool
	// closeAfterDrain defers a Close() that arrived while data was still
	// buffered (see closeLocked).
	closeAfterDrain bool
	// pendingEnd is a deliberate divergence from the TS mux: when sendData
	// has to buffer data from an endStream=true call, the TS flush of that
	// buffer never emits END_STREAM, so the peer never half-closes. The Go
	// session emits it once the buffer drains; TS peers handle that END_STREAM
	// like any other (it is the wire-correct behavior).

	headers     any
	closeReason string

	createdAt    time.Time
	lastActivity time.Time
	totalSent    int
	totalRecv    int

	onHeaders func(headers json.RawMessage, endStream bool)
	onData    func(chunk []byte)
	onEnd     func()
	onError   func(reason any)
}

func newStream(id uint32, c *Conn, priority int) *Stream {
	if priority < 0 {
		priority = 0
	}
	if priority > 255 {
		priority = 255
	}
	now := time.Now()
	return &Stream{
		id:           id,
		c:            c,
		state:        StateIdle,
		priority:     priority,
		sendWindow:   c.initialWindow,
		recvWindow:   c.initialWindow,
		createdAt:    now,
		lastActivity: now,
	}
}

func (s *Stream) ID() uint32 { return s.id }

// State reports the stream state. Thread-safe.
func (s *Stream) State() string {
	s.c.mu.Lock()
	defer s.c.mu.Unlock()
	return s.state
}

// Priority reports the stream priority. Thread-safe.
func (s *Stream) Priority() int {
	s.c.mu.Lock()
	defer s.c.mu.Unlock()
	return s.priority
}

// Headers reports the latest headers value. Thread-safe.
func (s *Stream) Headers() any {
	s.c.mu.Lock()
	defer s.c.mu.Unlock()
	return s.headers
}

// OnHeaders registers the HEADERS/HEADERS_END callback (endStream = END_STREAM flag).
func (s *Stream) OnHeaders(fn func(headers json.RawMessage, endStream bool)) { s.onHeaders = fn }

// OnData registers the DATA callback.
func (s *Stream) OnData(fn func(chunk []byte)) { s.onData = fn }

// OnEnd registers the half-close (remote END_STREAM) callback.
func (s *Stream) OnEnd(fn func()) { s.onEnd = fn }

// OnError registers the RST_STREAM / connection-drop callback. The reason is
// the peer-supplied RST reason, or one of "goaway"/"destroyed"/
// "connection_closed" when the session tore down.
func (s *Stream) OnError(fn func(reason any)) { s.onError = fn }

// SetPriority adjusts the local priority, clamped to 0-255 (TS setPriority;
// the current TS scheduler is FIFO, so this affects stats and PRIORITY
// frames only).
func (s *Stream) SetPriority(priority int) {
	c := s.c
	c.mu.Lock()
	defer c.mu.Unlock()
	if priority < 0 {
		priority = 0
	}
	if priority > 255 {
		priority = 255
	}
	s.priority = priority
	s.lastActivity = time.Now()
}

// SendHeaders sends a HEADERS frame with END_HEADERS set (TS sendHeaders).
func (s *Stream) SendHeaders(headers any, endStream bool) bool {
	c := s.c
	c.mu.Lock()
	defer c.mu.Unlock()
	if s.state == StateClosed {
		return false
	}
	if endStream {
		s.state = StateHalfClosedLocal
	} else {
		s.state = StateOpen
	}
	s.headers = headers
	s.lastActivity = time.Now()
	flags := FlagEndHeaders
	if endStream {
		flags |= FlagEndStream
	}
	f, err := JSONFrame(TypeHeaders, s.id, flags, headers)
	if err != nil {
		return false
	}
	c.enqueueLocked(f)
	return true
}

// SendData sends data, chunking at the window limit and buffering the rest
// (TS sendData). Returns false only when the stream can no longer send
// (closed or half-closed locally).
func (s *Stream) SendData(data []byte, endStream bool) bool {
	c := s.c
	c.mu.Lock()
	defer c.mu.Unlock()

	if s.state == StateClosed || s.state == StateHalfClosedLocal {
		return false
	}

	// Also respect the connection window (TS issue #119 fix): clamp only
	// while it has room, the batch path is what stalls at <= 0.
	connWindow := c.connSendWindow
	maxChunk := min3(s.sendWindow, orIfPositive(connWindow, MaxFrameSize), MaxFrameSize)

	if len(data) <= maxChunk {
		s.sendWindow -= len(data)
		s.totalSent += len(data)
		s.lastActivity = time.Now()
		flags := uint32(0)
		if endStream {
			flags = FlagEndStream
		}
		c.enqueueLocked(NewFrame(TypeData, s.id, flags, data))
		if endStream {
			s.state = StateHalfClosedLocal
		}
		return true
	}

	// Chunk what the window allows, buffer the rest. The size is clamped to
	// the remaining data: the TS loop relies on Buffer.slice clamping past
	// the end, which Go slicing must do explicitly.
	offset := 0
	for offset < len(data) && s.sendWindow > 0 {
		size := min3(s.sendWindow, MaxFrameSize, len(data)-offset)
		chunk := data[offset : offset+size]
		s.sendWindow -= size
		s.totalSent += size
		offset += size
		flags := uint32(0)
		if offset >= len(data) && endStream {
			flags = FlagEndStream
		}
		c.enqueueLocked(NewFrame(TypeData, s.id, flags, chunk))
	}
	if offset < len(data) {
		remaining := append([]byte(nil), data[offset:]...)
		s.buffered = append(s.buffered, remaining)
		s.bufferedSize += len(remaining)
		s.priority = clamp255(s.priority + 10) // TS boosts priority for buffered data
		if endStream {
			s.pendingEnd = true
		}
	}
	if offset >= len(data) && endStream {
		s.state = StateHalfClosedLocal
	}
	return true
}

// Reset kills the stream with RST_STREAM (TS reset).
func (s *Stream) Reset(reason any) {
	c := s.c
	c.mu.Lock()
	if s.state == StateClosed {
		c.mu.Unlock()
		return
	}
	s.state = StateClosed
	s.lastActivity = time.Now()
	if f, err := JSONFrame(TypeRSTStream, s.id, 0, Reason{Reason: reason}); err == nil {
		c.enqueueLocked(f)
	}
	c.removeStreamLocked(s.id)
	fn := s.onError
	c.mu.Unlock()
	if fn != nil {
		fn(reason)
	}
}

// Close gracefully closes the stream from this side (TS close): an OPEN
// stream gets an empty END_STREAM DATA frame; anything else closes outright
// and fires OnEnd.
func (s *Stream) Close() {
	c := s.c
	c.mu.Lock()
	onEnd := s.closeLocked()
	c.mu.Unlock()
	if onEnd != nil {
		onEnd()
	}
}

// closeLocked is the graceful half-close (TS close): OPEN streams get an
// empty END_STREAM DATA frame; anything else closes outright. Returns the
// OnEnd callback to fire after the session lock is released (or nil).
//
// Deliberate divergence (bug fix, verified live against the TS server): when
// buffered data is still waiting for window (pendingEnd set), the TS close()
// emits END_STREAM immediately, truncating every response body larger than
// the send window - executeMuxRequest calls close() right after sendData,
// so >64KiB bodies died at 64KiB. Here the close is deferred until the
// buffer drains and the real END_STREAM goes out.
func (s *Stream) closeLocked() func() {
	if s.state == StateClosed {
		return nil
	}
	if s.state == StateOpen {
		if s.pendingEnd || len(s.buffered) > 0 {
			s.closeAfterDrain = true
			return nil
		}
		s.state = StateHalfClosedLocal
		s.c.enqueueLocked(NewFrame(TypeData, s.id, FlagEndStream, nil))
		return nil
	}
	s.state = StateClosed
	s.c.removeStreamLocked(s.id)
	return s.onEnd
}

// handleFrameLocked processes a stream-level frame (TS Stream._handleFrame)
// and returns an optional callback to fire after the session lock is
// released. Unknown frame types are ignored, matching the TS handler.
func (s *Stream) handleFrameLocked(f Frame) func() {
	s.lastActivity = time.Now()

	switch f.Type {
	case TypeHeaders, TypeHeadersEnd:
		s.headers = json.RawMessage(f.Payload)
		endStream := f.Flags&FlagEndStream != 0
		if endStream {
			s.state = StateHalfClosedRemote
		} else {
			s.state = StateOpen
		}
		if fn := s.onHeaders; fn != nil {
			payload := append(json.RawMessage(nil), f.Payload...)
			return func() { fn(payload, endStream) }
		}

	case TypeData:
		s.recvWindow -= len(f.Payload)
		s.totalRecv += len(f.Payload)
		if s.recvWindow < DefaultInitialWindow/2 {
			// Credit the peer at the fixed 64 KiB baseline, exactly like the
			// TS handler (which ignores the configured initialWindow here).
			increment := DefaultInitialWindow - s.recvWindow
			s.recvWindow += increment
			if fu, err := JSONFrame(TypeWindowUpdate, s.id, 0, WindowUpdate{Increment: int64(increment)}); err == nil {
				s.c.enqueueLocked(fu)
			}
		}
		// TS fires onData and then, when END_STREAM is set, onEnd - both on
		// the same frame. Fire them together after unlock.
		var (
			dataFn = s.onData
			endFn  = s.onEnd
		)
		if f.Flags&FlagEndStream != 0 {
			s.state = StateHalfClosedRemote
		}
		if dataFn == nil && (f.Flags&FlagEndStream == 0 || endFn == nil) {
			return nil
		}
		payload := append([]byte(nil), f.Payload...)
		endStream := f.Flags&FlagEndStream != 0
		return func() {
			if dataFn != nil {
				dataFn(payload)
			}
			if endStream && endFn != nil {
				endFn()
			}
		}

	case TypePriority:
		var p struct {
			Priority *int `json:"priority"`
		}
		if err := json.Unmarshal(f.Payload, &p); err == nil && p.Priority != nil && *p.Priority != 0 {
			s.priority = clamp255(*p.Priority)
		} else {
			s.priority = DefaultPriority // TS: p.priority || DEFAULT_PRIORITY
		}

	case TypeRSTStream:
		s.state = StateClosed
		s.c.removeStreamLocked(s.id)
		var p struct {
			Reason any `json:"reason"`
		}
		_ = json.Unmarshal(f.Payload, &p)
		reason := any(0) // TS: p.reason || 0
		if p.Reason != nil && p.Reason != "" && p.Reason != float64(0) {
			reason = p.Reason
		}
		if fn := s.onError; fn != nil {
			return func() { fn(reason) }
		}

	case TypeWindowUpdate:
		var p struct {
			Increment any `json:"increment"`
		}
		if err := json.Unmarshal(f.Payload, &p); err == nil {
			if inc, ok := coerceIncrement(p.Increment); ok && inc > 0 && inc <= MaxWindowIncrement {
				s.sendWindow += int(inc)
			}
		}
		s.flushBufferedLocked()
	}
	return nil
}

// flushBufferedLocked drains buffered data as the send window opens
// (TS _flushBuffered), emitting the deferred END_STREAM when the buffer
// empties (see pendingEnd).
//
// The buffer holds VIEWS (head[size:]), not copies: NewFrame copies each
// chunk into its frame, so re-slicing is safe and keeps draining O(n) total -
// copying the remainder per chunk would be O(n^2) (a 48MB body copied 16KiB
// at a time measures ~72GB of memcpy).
func (s *Stream) flushBufferedLocked() {
	for len(s.buffered) > 0 && s.sendWindow > 0 {
		head := s.buffered[0]
		size := min3(len(head), s.sendWindow, MaxFrameSize)
		s.sendWindow -= size
		s.totalSent += size
		s.c.enqueueLocked(NewFrame(TypeData, s.id, 0, head[:size]))
		if size < len(head) {
			s.buffered[0] = head[size:]
			s.bufferedSize -= size
		} else {
			s.buffered = s.buffered[1:]
			s.bufferedSize -= len(head)
		}
	}
	if len(s.buffered) > 0 || s.state == StateClosed {
		return
	}
	// Buffer fully drained: honor pendingEnd, then a deferred close.
	if s.pendingEnd {
		s.pendingEnd = false
		s.c.enqueueLocked(NewFrame(TypeData, s.id, FlagEndStream, nil))
		s.state = StateHalfClosedLocal
	}
	if s.closeAfterDrain {
		s.closeAfterDrain = false
		if s.state == StateOpen {
			// No endStream was requested with the data; close() still owes
			// the peer an END_STREAM.
			s.c.enqueueLocked(NewFrame(TypeData, s.id, FlagEndStream, nil))
		}
		s.state = StateClosed
		s.c.removeStreamLocked(s.id)
	}
}

func (s *Stream) statsLocked() StreamStats {
	return StreamStats{
		ID:                 s.id,
		State:              s.state,
		Priority:           s.priority,
		SendWindow:         s.sendWindow,
		RecvWindow:         s.recvWindow,
		BufferedSize:       s.bufferedSize,
		TotalBytesSent:     s.totalSent,
		TotalBytesReceived: s.totalRecv,
		AgeMS:              time.Since(s.createdAt).Milliseconds(),
		IdleMS:             time.Since(s.lastActivity).Milliseconds(),
	}
}

// StreamStats mirrors the TS FrameStats shape.
type StreamStats struct {
	ID                 uint32
	State              string
	Priority           int
	SendWindow         int
	RecvWindow         int
	BufferedSize       int
	TotalBytesSent     int
	TotalBytesReceived int
	AgeMS              int64
	IdleMS             int64
}

func min2(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func min3(a, b, c int) int { return min2(min2(a, b), c) }

// orIfPositive returns v if positive, otherwise fallback - the TS sendData
// conn-window clamp shape (connWindow > 0 ? connWindow : MAX_FRAME_SIZE).
func orIfPositive(v, fallback int) int {
	if v > 0 {
		return v
	}
	return fallback
}

func clamp255(v int) int {
	if v < 0 {
		return 0
	}
	if v > 255 {
		return 255
	}
	return v
}
