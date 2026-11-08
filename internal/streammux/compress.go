package streammux

import (
	"sync"

	"github.com/klauspost/compress/zstd"
)

// Compression negotiates and applies per-frame payload compression for bulk
// frame types (DATA / TUNNEL_DATA) using zstd (SpeedFastest - a proxy relay
// needs throughput over ratio).
//
// Protocol extension (Go-only, negotiated): the WS dialer sends a COMPRESS
// frame offering algorithms; the accepting side replies with the selected
// one; from then on both directions may set FlagCompressed on bulk frames
// and carry zstd payloads. TS peers ignore unknown frame types entirely and
// never receive compressed data, so the wire stays backward-compatible.
//
// Frames are compressed independently (EncodeAll/DecodeAll) - no cross-frame
// state, so a lost or malformed frame cannot corrupt the stream.
type Compression struct {
	// MinSize: payloads smaller than this go out raw (ratio not worth it).
	MinSize int

	mu      sync.Mutex
	algo    string // "" = not negotiated yet
	encoder *zstd.Encoder
	decoder *zstd.Decoder
}

// NewCompression prepares the codec state for one connection.
func NewCompression(minSize int) *Compression {
	if minSize <= 0 {
		minSize = 512
	}
	enc, err := zstd.NewWriter(nil,
		zstd.WithEncoderLevel(zstd.SpeedFastest),
		zstd.WithEncoderConcurrency(1),
	)
	if err != nil {
		return nil
	}
	dec, err := zstd.NewReader(nil, zstd.WithDecoderConcurrency(1))
	if err != nil {
		enc.Close()
		return nil
	}
	return &Compression{MinSize: minSize, encoder: enc, decoder: dec}
}

// OfferFrame builds the COMPRESS offer payload (dialer side).
func OfferFramePayload() []byte {
	return []byte(`{"offer":["zstd"]}`)
}

// SelectFramePayload builds the COMPRESS select payload (acceptor side).
func SelectFramePayload(algo string) []byte {
	return []byte(`{"select":"` + algo + `"}`)
}

// Negotiate picks the algorithm from a peer's offer. Returns "" when nothing
// matches (no compression).
func Negotiate(offer []string) string {
	for _, candidate := range offer {
		if candidate == "zstd" {
			return "zstd"
		}
	}
	return ""
}

// Enable activates compression for this connection after a successful
// negotiation.
func (c *Compression) Enable(algo string) {
	if c == nil || algo == "" {
		return
	}
	c.mu.Lock()
	c.algo = algo
	c.mu.Unlock()
}

// Enabled reports whether compression was negotiated.
func (c *Compression) Enabled() bool {
	if c == nil {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.algo != ""
}

// CompressPayload returns the zstd-compressed payload, or the input
// unchanged when compression is off, the payload is too small, or the ratio
// gain is negligible (incompressible data - e.g. TLS inside tunnels - must
// not pay CPU for nothing).
func (c *Compression) CompressPayload(payload []byte) []byte {
	if c == nil || !c.Enabled() || len(payload) < c.MinSize {
		return payload
	}
	out := c.encoder.EncodeAll(payload, nil)
	// >= 90% of input: skip (flag stays unset, receiver uses it as-is).
	if len(out) >= len(payload)-len(payload)/10 {
		return payload
	}
	return out
}

// DecompressPayload inflates a flagged payload; raw payloads pass through.
func (c *Compression) DecompressPayload(payload []byte, compressed bool) ([]byte, error) {
	if c == nil || !compressed {
		return payload, nil
	}
	return c.decoder.DecodeAll(payload, nil)
}

// Close releases codec resources.
func (c *Compression) Close() {
	if c == nil {
		return
	}
	c.encoder.Close()
	c.decoder.Close()
}
