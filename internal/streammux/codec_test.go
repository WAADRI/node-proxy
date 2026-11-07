package streammux

import (
	"bytes"
	"encoding/binary"
	"errors"
	"testing"
)

func TestFrameEncodeDecodeRoundTrip(t *testing.T) {
	payload := []byte("hello tunnel")
	f := NewFrame(TypeData, 7, FlagEndStream, payload)

	wire, err := f.Encode()
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	if len(wire) != HeaderSize+len(payload) {
		t.Fatalf("wire size = %d, want %d", len(wire), HeaderSize+len(payload))
	}

	got, err := ParseMessage(wire)
	if err != nil {
		t.Fatalf("ParseMessage: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d frames, want 1", len(got))
	}
	if got[0].Type != TypeData || got[0].StreamID != 7 || got[0].Flags != FlagEndStream {
		t.Fatalf("header mismatch: %+v", got[0])
	}
	if !bytes.Equal(got[0].Payload, payload) {
		t.Fatalf("payload = %q, want %q", got[0].Payload, payload)
	}
}

func TestHeaderLayoutMatchesTS(t *testing.T) {
	// Byte-for-byte against the TS encoder:
	//   writeUInt32BE(len,0); [4]=type; writeUInt32BE(id,5); writeUInt32BE(flags,9)
	f := NewFrame(TypeTunnelOpen, 0x01020304, 0x05060708, []byte{0xAA})
	wire := f.MustEncode()

	want := []byte{
		0x00, 0x00, 0x00, 0x01, // length = 1
		0x0b,                   // TUNNEL_OPEN
		0x01, 0x02, 0x03, 0x04, // stream id
		0x05, 0x06, 0x07, 0x08, // flags
		0xAA, // payload
	}
	if !bytes.Equal(wire, want) {
		t.Fatalf("wire = %x, want %x", wire, want)
	}
}

func TestParseMessageDispatch(t *testing.T) {
	t.Run("short message", func(t *testing.T) {
		if _, err := ParseMessage([]byte{0x00}); !errors.Is(err, ErrShortMessage) {
			t.Fatalf("err = %v, want ErrShortMessage", err)
		}
		if _, err := ParseMessage(nil); !errors.Is(err, ErrShortMessage) {
			t.Fatalf("nil message: err = %v, want ErrShortMessage", err)
		}
	})

	t.Run("count 1 falls through to single frame", func(t *testing.T) {
		// A single frame whose length < 512 has zero top-16 bits; verify the
		// dispatch reads it as a frame, not a batch, even though a uint16
		// interpretation would give count 0 or 1.
		wire := NewFrame(TypePing, 0, 0, []byte(`{"time":1}`)).MustEncode()
		if wire[0] != 0 || wire[1] == 0 && wire[1] >= 2 {
			t.Fatalf("test setup invalid: top 16 bits must dispatch single frame, got %x", wire[:2])
		}
		frames, err := ParseMessage(wire)
		if err != nil || len(frames) != 1 || frames[0].Type != TypePing {
			t.Fatalf("frames = %+v, err = %v", frames, err)
		}
	})

	t.Run("oversized declared length", func(t *testing.T) {
		msg := make([]byte, HeaderSize)
		binary.BigEndian.PutUint32(msg[0:4], MaxFrameSize+1)
		if _, err := ParseMessage(msg); !errors.Is(err, ErrMalformedFrame) {
			t.Fatalf("err = %v, want ErrMalformedFrame", err)
		}
	})

	t.Run("truncated payload", func(t *testing.T) {
		wire := NewFrame(TypeData, 1, 0, []byte("0123456789")).MustEncode()
		if _, err := ParseMessage(wire[:len(wire)-3]); !errors.Is(err, ErrMalformedFrame) {
			t.Fatalf("err = %v, want ErrMalformedFrame", err)
		}
	})
}

func TestBatchRoundTrip(t *testing.T) {
	frames := []Frame{
		NewFrame(TypePing, 0, 0, []byte(`{"time":42}`)),
		NewFrame(TypeData, 1, 0, []byte("abc")),
		NewFrame(TypeTunnelOpen, 3, 0, []byte(`{"host":"example.com","port":443}`)),
	}

	wire, err := EncodeBatch(frames)
	if err != nil {
		t.Fatalf("EncodeBatch: %v", err)
	}
	if binary.BigEndian.Uint16(wire[0:2]) != 3 {
		t.Fatalf("batch count = %d, want 3", binary.BigEndian.Uint16(wire[0:2]))
	}

	got, err := ParseMessage(wire)
	if err != nil {
		t.Fatalf("ParseMessage: %v", err)
	}
	if len(got) != len(frames) {
		t.Fatalf("got %d frames, want %d", len(got), len(frames))
	}
	for i := range frames {
		if got[i].Type != frames[i].Type || got[i].StreamID != frames[i].StreamID ||
			got[i].Flags != frames[i].Flags || !bytes.Equal(got[i].Payload, frames[i].Payload) {
			t.Fatalf("frame %d = %+v, want %+v", i, got[i], frames[i])
		}
	}
}

func TestBatchStopsAtMalformedInnerFrame(t *testing.T) {
	good := NewFrame(TypePing, 0, 0, []byte(`{"time":1}`)).MustEncode()
	bad := make([]byte, HeaderSize)
	binary.BigEndian.PutUint32(bad[0:4], MaxFrameSize+1) // oversized inner frame

	msg := binary.BigEndian.AppendUint16(nil, 2)
	msg = append(msg, good...)
	msg = append(msg, bad...)

	frames, err := ParseMessage(msg)
	if err != nil {
		t.Fatalf("ParseMessage: %v", err)
	}
	if len(frames) != 1 {
		t.Fatalf("got %d frames, want 1 (parse must stop at the bad frame)", len(frames))
	}
}

func TestEncodePayloadLimit(t *testing.T) {
	if _, err := NewFrame(TypeData, 1, 0, make([]byte, MaxFrameSize)).Encode(); err != nil {
		t.Fatalf("MaxFrameSize payload should encode: %v", err)
	}
	if _, err := NewFrame(TypeData, 1, 0, make([]byte, MaxFrameSize+1)).Encode(); err == nil {
		t.Fatal("payload larger than MaxFrameSize should be rejected")
	}
}

func TestJSONPayloadKeyOrderAndEscaping(t *testing.T) {
	f, err := JSONFrame(TypeTunnelOpen, 5, 0, TunnelOpen{Host: "example.com", Port: 443})
	if err != nil {
		t.Fatalf("JSONFrame: %v", err)
	}
	// TS sends {host,port}: insertion order, no spaces.
	if want := `{"host":"example.com","port":443}`; string(f.Payload) != want {
		t.Fatalf("payload = %s, want %s", f.Payload, want)
	}

	// JSON.stringify does not escape <, >, &; Go's default marshal does.
	f, err = JSONFrame(TypeRSTStream, 7, 0, Reason{Reason: "a<b&c>d"})
	if err != nil {
		t.Fatalf("JSONFrame: %v", err)
	}
	if want := `{"reason":"a<b&c>d"}`; string(f.Payload) != want {
		t.Fatalf("payload = %s, want %s", f.Payload, want)
	}

	// Unknown keys are ignored on decode, same as JSON.parse on the TS side.
	var open TunnelOpen
	if err := ParseJSONPayload(f, &open); err != nil || open.Host != "" {
		t.Fatalf("decode = %+v, err = %v; want zero-value Host", open, err)
	}
}
