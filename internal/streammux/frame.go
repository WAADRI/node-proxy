package streammux

import (
	"encoding/binary"
	"fmt"
)

// Frame is one StreamMux frame, decoded or ready to encode.
//
// Field widths mirror the wire format: StreamID and Flags are uint32 on the
// wire even though flag values in use are the small Flag* constants.
type Frame struct {
	Type     FrameType
	StreamID uint32
	Flags    uint32
	Payload  []byte
}

// NewFrame builds a frame, copying the payload.
func NewFrame(t FrameType, streamID uint32, flags uint32, payload []byte) Frame {
	p := make([]byte, len(payload))
	copy(p, payload)
	return Frame{Type: t, StreamID: streamID, Flags: flags, Payload: p}
}

// AppendHeader appends the 13-byte frame header to dst, matching the TS
// encoder byte for byte:
//
//	writeUInt32BE(len, 0); header[4] = type; writeUInt32BE(id, 5); writeUInt32BE(flags, 9)
func AppendHeader(dst []byte, f *Frame) []byte {
	dst = binary.BigEndian.AppendUint32(dst, uint32(len(f.Payload)))
	dst = append(dst, byte(f.Type))
	dst = binary.BigEndian.AppendUint32(dst, f.StreamID)
	return binary.BigEndian.AppendUint32(dst, f.Flags)
}

// Encode returns the full wire representation of the frame (header + payload).
//
// Unlike the TS encoder, which silently emits oversized payloads (its send
// path chunks first), Encode rejects payloads larger than MaxFrameSize: the
// TS receiver drops such frames on sight, so they can never be delivered
// anyway.
func (f Frame) Encode() ([]byte, error) {
	if len(f.Payload) > MaxFrameSize {
		return nil, fmt.Errorf("streammux: payload size %d exceeds MaxFrameSize %d", len(f.Payload), MaxFrameSize)
	}
	buf := make([]byte, 0, HeaderSize+len(f.Payload))
	buf = AppendHeader(buf, &f)
	return append(buf, f.Payload...), nil
}

// MustEncode is Encode for payloads already known to be within MaxFrameSize.
// It panics on violation, making it suitable for constants and tests.
func (f Frame) MustEncode() []byte {
	buf, err := f.Encode()
	if err != nil {
		panic(err)
	}
	return buf
}

// decodeHeader parses the fixed 13-byte header at the start of b. ok is false
// when b is shorter than the header.
func decodeHeader(b []byte) (f Frame, ok bool) {
	if len(b) < HeaderSize {
		return Frame{}, false
	}
	return Frame{
		Type:     FrameType(b[4]),
		StreamID: binary.BigEndian.Uint32(b[5:9]),
		Flags:    binary.BigEndian.Uint32(b[9:13]),
		Payload:  b[HeaderSize : HeaderSize+binary.BigEndian.Uint32(b[0:4])],
	}, true
}
