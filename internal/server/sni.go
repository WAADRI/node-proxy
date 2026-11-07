package server

import "encoding/binary"

// parseClientHelloSNI extracts the server_name extension from a TLS
// ClientHello (issue #107 parity): the CONNECT target is often a literal IP,
// which says nothing about what the session is for - the SNI does.
//
// Input: the first bytes read from the tunnel after the CONNECT reply.
// Anything that does not parse as a ClientHello returns "" (plain HTTP
// tunnels, resumptions, garbage) - never an error; sniffing is best-effort.
func parseClientHelloSNI(b []byte) string {
	// TLS record: type(0x16) version(2) length(2)
	if len(b) < 5 || b[0] != 0x16 {
		return ""
	}
	recLen := int(b[3])<<8 | int(b[4])
	if len(b) < 5+recLen {
		return ""
	}
	body := b[5 : 5+recLen]
	// Handshake: type(0x01=ClientHello) length(3)
	if len(body) < 4 || body[0] != 0x01 {
		return ""
	}
	hsLen := int(body[1])<<16 | int(body[2])<<8 | int(body[3])
	if len(body) < 4+hsLen {
		return ""
	}
	ch := body[4 : 4+hsLen]
	// ClientHello: version(2) random(32) session_id(vec8) cipher_suites(vec16)
	// compression(vec8) extensions(vec16)
	pos := 2 + 32
	if len(ch) < pos+1 {
		return ""
	}
	pos += 1 + int(ch[pos]) // session id
	if len(ch) < pos+2 {
		return ""
	}
	csLen := int(ch[pos])<<8 | int(ch[pos+1])
	pos += 2 + csLen
	if len(ch) < pos+1 {
		return ""
	}
	pos += 1 + int(ch[pos]) // compression methods
	if len(ch) < pos+2 {
		return ""
	}
	extLen := int(ch[pos])<<8 | int(ch[pos+1])
	pos += 2
	end := pos + extLen
	if end > len(ch) {
		end = len(ch)
	}
	// Walk extensions: type(2) length(2) data; server_name = 0x0000.
	for pos+4 <= end {
		extType := binary.BigEndian.Uint16(ch[pos : pos+2])
		extLen := int(binary.BigEndian.Uint16(ch[pos+2 : pos+4]))
		dataStart := pos + 4
		dataEnd := dataStart + extLen
		if dataEnd > end {
			return ""
		}
		if extType == 0x0000 {
			return parseServerNameList(ch[dataStart:dataEnd])
		}
		pos = dataEnd
	}
	return ""
}

// parseServerNameList: server_name_list(vec16) { name_type(1=host_name) vec16 }.
func parseServerNameList(b []byte) string {
	if len(b) < 2 {
		return ""
	}
	listLen := int(binary.BigEndian.Uint16(b[0:2]))
	if listLen > len(b)-2 {
		listLen = len(b) - 2
	}
	pos := 2
	for pos+3 <= 2+listLen {
		nameType := b[pos]
		nameLen := int(binary.BigEndian.Uint16(b[pos+1 : pos+3]))
		pos += 3
		if pos+nameLen > len(b) {
			return ""
		}
		if nameType == 0x00 && nameLen > 0 {
			return string(b[pos : pos+nameLen])
		}
		pos += nameLen
	}
	return ""
}
