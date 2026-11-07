package streammux

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// EncodeJSONPayload marshals v the way the TS mux stringifies object payloads
// (_sendFrame): compact JSON, no HTML escaping. Go's json.Marshal escapes
// '<', '>' and '&' by default while JavaScript's JSON.stringify does not, so
// the encoder disables that to stay byte-compatible.
func EncodeJSONPayload(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// JSONFrame builds a frame whose payload is compact JSON, mirroring the TS
// send sites that pass plain objects to _sendFrame.
func JSONFrame(t FrameType, streamID uint32, flags uint32, v any) (Frame, error) {
	payload, err := EncodeJSONPayload(v)
	if err != nil {
		return Frame{}, err
	}
	return Frame{Type: t, StreamID: streamID, Flags: flags, Payload: payload}, nil
}

// Typed payloads for the JSON frame types. Field order matches the object
// literals at the TS send sites, so re-marshaling reproduces their key order
// byte for byte (relevant only for golden parity - receivers parse JSON and
// are key-order agnostic).

// TunnelOpen is the TUNNEL_OPEN payload: openTunnel(host, port).
type TunnelOpen struct {
	Host string `json:"host"`
	Port int    `json:"port"`
}

// WindowUpdate is the WINDOW_UPDATE payload, used at both stream and
// connection level (stream id 0).
type WindowUpdate struct {
	Increment int64 `json:"increment"`
}

// PingTime is the PING/PONG payload; PONG echoes the received time.
type PingTime struct {
	Time int64 `json:"time"`
}

// Goaway is the GOAWAY payload.
type Goaway struct {
	LastStreamID int64 `json:"lastStreamId"`
}

// Reason is the payload of RST_STREAM and TUNNEL_CLOSE. The TS send sites
// accept both numbers and strings (closeTunnel defaults to 0), so the value
// stays interface-typed.
type Reason struct {
	Reason any `json:"reason"`
}

// ParseJSONPayload decodes a JSON frame payload into v, mirroring the TS
// receive side (_parsePayload: every non-DATA frame type is JSON.parse'd,
// with connection-level frames dropped when parsing fails).
func ParseJSONPayload(f Frame, v any) error {
	if err := json.Unmarshal(f.Payload, v); err != nil {
		return fmt.Errorf("streammux: frame %s payload: %w", f.Type, err)
	}
	return nil
}

// IsBinaryPayload reports whether frames of type t carry raw bytes rather
// than JSON (DATA and TUNNEL_DATA).
func IsBinaryPayload(t FrameType) bool {
	return t == TypeData || t == TypeTunnelData
}
