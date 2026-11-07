// Package streammux implements the wire codec for node-proxy's StreamMux
// protocol: HTTP/2-style stream multiplexing carried over WebSocket binary
// messages.
//
// The byte layout is compatible with the TypeScript implementation in
// WAADRI/node-proxy (server/lib/stream-mux.ts, client/lib/stream-mux.ts),
// which is the normative reference. Compatibility is enforced by golden
// vectors generated with the real TS encoder; see golden_test.go and
// tools/gen-goldens.
//
// Wire format:
//
//	frame  = [4B payload length BE][1B type][4B stream id BE][4B flags BE][payload]
//	ws msg = frame | batch
//	batch  = [2B frame count BE] frame{count}   (count >= 2)
//
// A WS message is dispatched as a batch when its first two bytes, read as a
// big-endian uint16, are >= 2. The dispatch is unambiguous: a single frame's
// length field is capped at MaxFrameSize (16 KiB), so its top 16 bits are
// always zero and can never be mistaken for a batch count.
//
// Payloads are raw bytes for DATA and TUNNEL_DATA, and compact JSON for every
// other frame type (a JSON.parse failure falls back to the raw UTF-8 string
// on the receive side). Receivers drop malformed or truncated frames and keep
// the connection alive - the same policy is mirrored here.
package streammux

// FrameType is the 1-byte type field of a frame header.
type FrameType uint8

// Frame types, mirroring FRAME_TYPE in the TypeScript implementation.
const (
	TypeHeaders      FrameType = 0x01 // stream metadata (JSON)
	TypeData         FrameType = 0x02 // stream payload data (raw)
	TypePriority     FrameType = 0x03 // stream priority change
	TypeRSTStream    FrameType = 0x04 // reset/kill stream
	TypeGoAway       FrameType = 0x05 // graceful shutdown
	TypeWindowUpdate FrameType = 0x06 // flow control window update
	TypePing         FrameType = 0x07 // keepalive + RTT measurement
	TypePong         FrameType = 0x08 // ping response
	TypeBatch        FrameType = 0x09 // container: multiple batched frames
	TypeHeadersEnd   FrameType = 0x0a // final HEADERS frame
	TypeTunnelOpen   FrameType = 0x0b // SOCKS5 tunnel open request
	TypeTunnelData   FrameType = 0x0c // tunnel data (raw)
	TypeTunnelClose  FrameType = 0x0d // tunnel close
)

func (t FrameType) String() string {
	switch t {
	case TypeHeaders:
		return "HEADERS"
	case TypeData:
		return "DATA"
	case TypePriority:
		return "PRIORITY"
	case TypeRSTStream:
		return "RST_STREAM"
	case TypeGoAway:
		return "GOAWAY"
	case TypeWindowUpdate:
		return "WINDOW_UPDATE"
	case TypePing:
		return "PING"
	case TypePong:
		return "PONG"
	case TypeBatch:
		return "BATCH"
	case TypeHeadersEnd:
		return "HEADERS_END"
	case TypeTunnelOpen:
		return "TUNNEL_OPEN"
	case TypeTunnelData:
		return "TUNNEL_DATA"
	case TypeTunnelClose:
		return "TUNNEL_CLOSE"
	default:
		return "UNKNOWN"
	}
}

// Frame flags (the 4-byte flags field), mirroring FLAG in TypeScript.
const (
	FlagEndStream  uint32 = 0x01
	FlagEndHeaders uint32 = 0x02
	FlagPriority   uint32 = 0x04
	FlagPadded     uint32 = 0x08
)

// Protocol limits shared by both TS endpoints. A Go peer must stay within
// these to remain byte- and behavior-compatible.
const (
	// MaxFrameSize is the maximum frame payload in bytes (16 KiB).
	MaxFrameSize = 16384
	// MaxBatchBytes is the maximum total size of a batched WS message (64 KiB).
	// Enforced by the TS sender; the receiver stops parsing a batch past its
	// first malformed inner frame.
	MaxBatchBytes = 65536
	// MaxConcurrentStreams is the per-connection open-stream limit.
	MaxConcurrentStreams = 512
	// DefaultInitialWindow is the per-stream send window (64 KiB).
	DefaultInitialWindow = 65536
	// DefaultConnectionWindow is the connection-level send window (1 MiB).
	DefaultConnectionWindow = 1048576
	// MaxWindowIncrement caps a WINDOW_UPDATE increment (16 MiB).
	MaxWindowIncrement = 16 * 1024 * 1024
	// DefaultPriority is the default stream priority (0-255, lower = higher).
	DefaultPriority = 128
)

// HeaderSize is the fixed frame header size:
// length(4) + type(1) + stream id(4) + flags(4).
const HeaderSize = 13
