package streammux

import (
	"encoding/binary"
	"errors"
	"fmt"
	"sync"
)

// Errors returned by ParseMessage. Callers mirror the TS receive policy: log
// the error, drop the message, keep the connection alive.
var (
	// ErrShortMessage means the message is too short to dispatch (TS ignores
	// messages shorter than 2 bytes, or shorter than a header on the single
	// frame path).
	ErrShortMessage = errors.New("streammux: message too short to be a frame or batch")
	// ErrMalformedFrame means the message dispatched as a single frame but its
	// declared length exceeds MaxFrameSize or runs past the message end.
	ErrMalformedFrame = errors.New("streammux: malformed frame")
)

// ParseMessage decodes one WebSocket binary message into its frames,
// replicating the TS dispatcher exactly:
//
//   - fewer than 2 bytes                 -> ErrShortMessage
//   - first 2 bytes (uint16 BE) >= 2     -> batch: [2B count][frame][frame]...
//   - otherwise, and message >= 13 bytes -> single frame
//   - otherwise                          -> ErrShortMessage
//
// Batch parsing stops at the first inner frame that is malformed or truncated
// (the TS decoder `break`s there) and returns the frames decoded so far with
// a nil error, matching the drop-and-continue behavior.
//
// Note the intentional asymmetry with Frame.Encode: TypeBatch is the value a
// sender would put in a BATCH frame header, but on the wire batching is
// signaled by the 2-byte count prefix, not by a BATCH-typed frame. The TS
// codebase defines the type for legacy/round-trip purposes only.
func ParseMessage(msg []byte) ([]Frame, error) {
	if len(msg) < 2 {
		return nil, ErrShortMessage
	}
	if count := binary.BigEndian.Uint16(msg[0:2]); count >= 2 {
		return decodeBatch(msg), nil
	}
	if len(msg) < HeaderSize {
		return nil, ErrShortMessage
	}
	length := binary.BigEndian.Uint32(msg[0:4])
	if length > MaxFrameSize || HeaderSize+int(length) > len(msg) {
		return nil, fmt.Errorf("%w: declared length %d, message size %d", ErrMalformedFrame, length, len(msg))
	}
	f, _ := decodeHeader(msg)
	f.Payload = msg[HeaderSize : HeaderSize+int(length)]
	return []Frame{f}, nil
}

// decodeBatch walks [2B count][frame][frame]... and stops at the first
// malformed or truncated inner frame, mirroring _decodeBatch in TypeScript.
func decodeBatch(msg []byte) []Frame {
	var frames []Frame
	offset := 2 // skip the count field
	for offset < len(msg) {
		if offset+HeaderSize > len(msg) {
			break
		}
		length := binary.BigEndian.Uint32(msg[offset : offset+4])
		if length > MaxFrameSize || offset+HeaderSize+int(length) > len(msg) {
			break
		}
		f, _ := decodeHeader(msg[offset:])
		f.Payload = msg[offset+HeaderSize : offset+HeaderSize+int(length)]
		frames = append(frames, f)
		offset += HeaderSize + int(length)
	}
	return frames
}

// EncodeBatch wraps frames in the batch wire format: [2B count BE] followed
// by each frame's full encoding. The TS sender only batches two or more
// frames, and never beyond MaxBatchBytes total; those policies live at the
// session layer, so EncodeBatch enforces only the count-width limit plus the
// per-frame payload limit.
func EncodeBatch(frames []Frame) ([]byte, error) {
	return EncodeBatchInto(nil, frames)
}

// EncodeBatchInto is EncodeBatch appending into dst (buffer pooling for the
// writer's hot path).
func EncodeBatchInto(dst []byte, frames []Frame) ([]byte, error) {
	if len(frames) > int(^uint16(0)) {
		return nil, fmt.Errorf("streammux: batch of %d frames exceeds uint16 count field", len(frames))
	}
	size := 2
	for i := range frames {
		if len(frames[i].Payload) > MaxFrameSize {
			return nil, fmt.Errorf("streammux: batch frame %d payload size %d exceeds MaxFrameSize %d", i, len(frames[i].Payload), MaxFrameSize)
		}
		size += HeaderSize + len(frames[i].Payload)
	}
	if cap(dst)-len(dst) < size {
		dst = append(dst, make([]byte, size)...)[:len(dst)]
	}
	buf := binary.BigEndian.AppendUint16(dst, uint16(len(frames)))
	for i := range frames {
		buf = AppendHeader(buf, &frames[i])
		buf = append(buf, frames[i].Payload...)
	}
	return buf, nil
}

// wireBufPool backs the session writer's batch buffers: one 48MB transfer
// otherwise allocates ~48MB of short-lived encode buffers and drags GC into
// the window-update latency chain.
var wireBufPool = sync.Pool{
	New: func() any { return make([]byte, 0, MaxBatchBytes+HeaderSize+2) },
}
