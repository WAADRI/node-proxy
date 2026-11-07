package server

import (
	"encoding/binary"
	"testing"
)

// buildClientHello crafts a minimal TLS ClientHello with one SNI entry.
func buildClientHello(sni string) []byte {
	name := []byte(sni)
	// server_name list: listLen(2) { name_type(0x00) nameLen(2) name }
	list := []byte{byte(int(len(name)+3) >> 8), byte(len(name) + 3)}
	list = append(list, 0x00, byte(int(len(name))>>8), byte(len(name)))
	list = append(list, name...)

	ext := make([]byte, 4+len(list))
	binary.BigEndian.PutUint16(ext[0:2], 0x0000) // server_name
	binary.BigEndian.PutUint16(ext[2:4], uint16(len(list)))
	copy(ext[4:], list)

	ch := make([]byte, 2+32)
	ch[0], ch[1] = 0x03, 0x03               // TLS 1.2
	ch = append(ch, 0x00)                   // session id len 0
	ch = append(ch, 0x00, 0x02, 0x13, 0x01) // one cipher suite
	ch = append(ch, 0x01, 0x00)             // one compression method
	ch = append(ch, byte(int(len(ext))>>8), byte(len(ext)))
	ch = append(ch, ext...)

	hs := make([]byte, 4)
	hs[0] = 0x01
	hs[1] = byte(int(len(ch)) >> 16)
	hs[2] = byte(int(len(ch)) >> 8)
	hs[3] = byte(len(ch))
	body := append(hs, ch...)

	rec := make([]byte, 5)
	rec[0] = 0x16
	rec[1], rec[2] = 0x03, 0x01
	rec[3] = byte(int(len(body)) >> 8)
	rec[4] = byte(len(body))
	return append(rec, body...)
}

func TestParseClientHelloSNI(t *testing.T) {
	if got := parseClientHelloSNI(buildClientHello("example.com")); got != "example.com" {
		t.Fatalf("sni = %q, want example.com", got)
	}
	if got := parseClientHelloSNI(buildClientHello("a.b.hosting.example.co")); got != "a.b.hosting.example.co" {
		t.Fatalf("sni = %q", got)
	}
	// Not TLS / truncated / empty -> "" without panicking.
	for _, bad := range [][]byte{
		nil,
		{0x17, 0x03, 0x00, 0x01, 0x41}, // application data record
		{0x16, 0x03},                   // truncated
		{0x16, 0x03, 0x01, 0x00, 0x02, 0xFF, 0xFF}, // garbage handshake
	} {
		if got := parseClientHelloSNI(bad); got != "" {
			t.Fatalf("garbage input %x returned %q", bad, got)
		}
	}
}
