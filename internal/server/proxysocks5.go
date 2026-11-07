package server

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net"
	"sync"
	"time"
)

// HandleSOCKS5 serves the 1080 port: greeting (optional user/pass auth),
// CONNECT via client nodes. UDP ASSOCIATE lands with the UDP step.
func (s *Server) HandleSOCKS5(conn net.Conn) {
	// Once the CONNECT succeeds the socket belongs to the tunnel pipeline
	// (completeTunnelReady pumps it) - the deferred close below must not fire
	// for a handed-off socket, or it kills the tunnel as this goroutine exits.
	handedOff := false
	defer func() {
		if !handedOff {
			_ = conn.Close()
		}
	}()

	state := "greeting"
	var routeTag string

	buf := make([]byte, 512)
	pending := make([]byte, 0, 512)

	read := func() ([]byte, bool) {
		n, err := conn.Read(buf)
		if n > 0 {
			pending = append(pending, buf[:n]...)
		}
		if err != nil {
			return pending, false
		}
		return pending, true
	}
	consume := func(n int) {
		pending = append(pending[:0], pending[n:]...)
	}

	for {
		switch state {
		case "greeting":
			if len(pending) < 2 {
				data, ok := read()
				pending = data
				if !ok {
					return
				}
				continue
			}
			if pending[0] != 0x05 {
				return
			}
			nmethods := int(pending[1])
			if len(pending) < 2+nmethods {
				data, ok := read()
				pending = data
				if !ok {
					return
				}
				continue
			}
			methods := pending[2 : 2+nmethods]
			consume(2 + nmethods)
			if s.Cfg.Proxy.Enabled {
				has := false
				for _, m := range methods {
					if m == 0x02 {
						has = true
						break
					}
				}
				if !has {
					_, _ = conn.Write([]byte{0x05, 0xff})
					return
				}
				_, _ = conn.Write([]byte{0x05, 0x02})
				state = "auth_sub"
			} else {
				_, _ = conn.Write([]byte{0x05, 0x00})
				state = "request"
			}

		case "auth_sub":
			if len(pending) < 2 {
				data, ok := read()
				pending = data
				if !ok {
					return
				}
				continue
			}
			uLen := int(pending[1])
			if len(pending) < 2+uLen+1 {
				data, ok := read()
				pending = data
				if !ok {
					return
				}
				continue
			}
			pLen := int(pending[2+uLen])
			if len(pending) < 2+uLen+1+pLen {
				data, ok := read()
				pending = data
				if !ok {
					return
				}
				continue
			}
			user := string(pending[2 : 2+uLen])
			pass := string(pending[2+uLen+1 : 2+uLen+1+pLen])
			consume(2 + uLen + 1 + pLen)
			if user == s.Cfg.Proxy.Username && pass == s.Cfg.Proxy.Password {
				_, _ = conn.Write([]byte{0x01, 0x00})
				state = "request"
			} else if s.ProxyPasswords != nil {
				if rec, matched := MatchProxyPassword(*s.ProxyPasswords, user, pass); matched {
					routeTag, _, _ = routeFromPassword(rec)
					_, _ = conn.Write([]byte{0x01, 0x00})
					state = "request"
				} else {
					_, _ = conn.Write([]byte{0x01, 0x01})
					return
				}
			} else {
				_, _ = conn.Write([]byte{0x01, 0x01})
				return
			}

		case "request":
			if len(pending) < 5 {
				data, ok := read()
				pending = data
				if !ok {
					return
				}
				continue
			}
			if pending[0] != 0x05 {
				return
			}
			cmd := pending[1]
			atyp := pending[3]
			var addrLen int
			switch atyp {
			case 0x01:
				addrLen = 4
			case 0x03:
				if len(pending) < 5 {
					data, ok := read()
					pending = data
					if !ok {
						return
					}
					continue
				}
				addrLen = 1 + int(pending[4])
			case 0x04:
				addrLen = 16
			default:
				_, _ = conn.Write(encodeSocks5Reply(0x08))
				return
			}
			headerLen := 4 + addrLen + 2
			if len(pending) < headerLen {
				data, ok := read()
				pending = data
				if !ok {
					return
				}
				continue
			}
			host := socks5Host(pending, atyp)
			port := int(binary.BigEndian.Uint16(pending[headerLen-2 : headerLen]))
			consume(headerLen)

			if cmd == 0x03 {
				// UDP ASSOCIATE: bind a relay port and pump datagrams until
				// the control connection drops (TS handleUDPAssociate).
				s.handleUDPAssociate(conn, routeTag)
				return
			}
			if cmd != 0x01 {
				_, _ = conn.Write(encodeSocks5Reply(0x07))
				return
			}

			srcIP := peerIP(conn)
			if s.ACL != nil && !s.ACL.Check(srcIP, host, "socks5", port, nil) {
				s.Log.Warnf("ACL denied socks5 %s:%d from %s", host, port, srcIP)
				_, _ = conn.Write(encodeSocks5Reply(0x02))
				return
			}
			tag := firstNonEmpty(routeTag, s.domainTagFor(host))
			client := s.Mgr.Select(tag, "")
			if client == nil {
				_, _ = conn.Write(encodeSocks5Reply(0x01))
				return
			}
			if openNodeTunnel(s, conn, client, host, port, "socks5", nil) == "" {
				_, _ = conn.Write(encodeSocks5Reply(0x01))
				return
			}
			// From here the socket belongs to the tunnel pipeline
			// (completeTunnelReady); stop reading and skip the deferred close.
			handedOff = true
			return
		}
	}
}

func socks5Host(b []byte, atyp byte) string {
	switch atyp {
	case 0x01:
		return net.IP(b[4:8]).String()
	case 0x03:
		return string(b[5 : 5+b[4]])
	case 0x04:
		ip := make(net.IP, 16)
		copy(ip, b[4:20])
		return ip.String()
	}
	return ""
}

// encodeSocks5Reply builds the 10-byte IPv4 reply (TS encodeSocks5Reply).
func encodeSocks5Reply(code byte) []byte {
	buf := make([]byte, 10)
	buf[0] = 0x05
	buf[1] = code
	buf[2] = 0x00
	buf[3] = 0x01
	return buf
}

// ---------------------------------------------------------------------------
// UDP ASSOCIATE (cmd 0x03) - TS handleUDPAssociate
// ---------------------------------------------------------------------------

// udpAssoc is one SOCKS5 UDP association: the relay socket, the control
// connection's peer IP (the relay-authorization anchor), and the original
// SOCKS5 UDP client addresses seen (for response routing).
type udpAssoc struct {
	id       string
	udp      *net.UDPConn
	peerIP   string
	srv      *Server
	clientID string // last client a datagram was forwarded through
	tag      string

	mu      sync.Mutex
	clients map[string]*net.UDPAddr // "ip:port" of the SOCKS5 UDP client
	lastAct time.Time
}

// handleUDPAssociate binds a relay port, replies with BND.PORT, and pumps
// datagrams until the control connection or idle timeout ends it.
func (s *Server) handleUDPAssociate(conn net.Conn, tag string) {
	udpAddr, err := net.ResolveUDPAddr("udp4", ":0")
	if err != nil {
		_, _ = conn.Write(encodeSocks5Reply(0x01))
		return
	}
	udp, err := net.ListenUDP("udp4", udpAddr)
	if err != nil {
		_, _ = conn.Write(encodeSocks5Reply(0x01))
		return
	}
	assoc := &udpAssoc{
		id:      newUUID(),
		udp:     udp,
		peerIP:  peerIP(conn),
		srv:     s,
		tag:     tag,
		clients: map[string]*net.UDPAddr{},
		lastAct: time.Now(),
	}
	s.Mgr.AddUDPAssoc(assoc)

	// Reply: BND.ADDR = 0.0.0.0, BND.PORT = relay port (TS parity).
	localPort := udp.LocalAddr().(*net.UDPAddr).Port
	reply := make([]byte, 10)
	reply[0] = 0x05
	reply[1] = 0x00
	reply[3] = 0x01
	reply[8] = byte(localPort >> 8)
	reply[9] = byte(localPort & 0xff)
	if _, err := conn.Write(reply); err != nil {
		s.Mgr.RemoveUDPAssoc(assoc.id)
		return
	}
	totalTunnels.Add(1)

	// The control connection holds the association open; when it drops
	// (client went away), tear the relay down. Reads are discarded.
	go func() {
		buf := make([]byte, 512)
		for {
			if _, err := conn.Read(buf); err != nil {
				s.Mgr.RemoveUDPAssoc(assoc.id)
				return
			}
		}
	}()

	// Relay loop: only datagrams from the control connection's peer IP are
	// eligible (issue #126 semantics - the declared DST.ADDR is advisory).
	buf := make([]byte, 65536)
	idle := time.NewTimer(3 * time.Minute)
	defer idle.Stop()
	go func() {
		for range idle.C {
			assoc.mu.Lock()
			idleFor := time.Since(assoc.lastAct)
			assoc.mu.Unlock()
			if idleFor > 3*time.Minute {
				s.Mgr.RemoveUDPAssoc(assoc.id)
				return
			}
			idle.Reset(30 * time.Second)
		}
	}()
	for {
		n, rinfo, err := udp.ReadFromUDP(buf)
		if err != nil {
			return
		}
		assoc.mu.Lock()
		assoc.lastAct = time.Now()
		assoc.mu.Unlock()
		if peerIPFrom(rinfo) != assoc.peerIP {
			continue
		}
		if !assoc.forwardDatagram(buf[:n], rinfo) {
			return
		}
	}
}

// forwardDatagram parses the RFC 1928 UDP header and forwards the payload to
// a client node via the JSON control plane (TS: udp_data text message).
func (a *udpAssoc) forwardDatagram(msg []byte, rinfo *net.UDPAddr) bool {
	if len(msg) < 4 {
		return true
	}
	frag := msg[2]
	if frag != 0x00 {
		return true // fragmentation unsupported, datagram dropped (TS parity)
	}
	var (
		host      string
		port      int
		dataStart int
	)
	switch msg[3] {
	case 0x01:
		if len(msg) < 10 {
			return true
		}
		host = net.IP(msg[4:8]).String()
		port = int(msg[8])<<8 | int(msg[9])
		dataStart = 10
	case 0x03:
		nameLen := int(msg[4])
		if len(msg) < 7+nameLen {
			return true
		}
		host = string(msg[5 : 5+nameLen])
		port = int(msg[5+nameLen])<<8 | int(msg[5+nameLen+1])
		dataStart = 7 + nameLen
	case 0x04:
		if len(msg) < 22 {
			return true
		}
		host = net.IP(msg[4:20]).String()
		port = int(msg[20])<<8 | int(msg[21])
		dataStart = 22
	default:
		return true
	}

	srcIP := a.peerIP
	if a.srv.ACL != nil && !a.srv.ACL.Check(srcIP, host, "udp", port, nil) {
		return true // dropped silently, TS parity
	}
	tag := firstNonEmpty(a.tag, a.srv.domainTagFor(host))
	client := a.srv.Mgr.Select(tag, "")
	if client == nil || client.WS == nil {
		return true
	}
	a.clientID = client.ID

	a.mu.Lock()
	a.clients[rinfo.String()] = rinfo
	a.mu.Unlock()

	payload, _ := json.Marshal(map[string]any{
		"type":    "udp_data",
		"id":      newUUID(),
		"assocId": a.id,
		"host":    host,
		"port":    port,
		"src":     map[string]any{"address": rinfo.IP.String(), "port": rinfo.Port},
		"data":    base64.StdEncoding.EncodeToString(msg[dataStart:]),
	})
	if !client.WS.sendText(payload) {
		return false
	}
	return true
}

// onUdpDataResponse relays a client's UDP response back to the original
// SOCKS5 UDP client, wrapped in the RFC 1928 header (TS onUdpData; note the
// header carries the original client address - TS parity quirk).
func (s *Server) onUdpDataResponse(msg *clientTextMsg) {
	data, err := base64.StdEncoding.DecodeString(msg.Data)
	if err != nil || len(data) == 0 {
		return
	}
	assoc := s.Mgr.GetUDPAssoc(msg.AssocID)
	if assoc == nil {
		return
	}
	var (
		srcAddr string
		srcPort int
	)
	if msg.Src != nil {
		srcAddr = msg.Src.Address
		srcPort = msg.Src.Port
	}
	if srcAddr == "" {
		return
	}
	srcIP := net.ParseIP(srcAddr)
	var header []byte
	if srcIP.To4() != nil {
		header = make([]byte, 10)
		header[3] = 0x01
		copy(header[4:8], srcIP.To4())
		header[8] = byte(srcPort >> 8)
		header[9] = byte(srcPort & 0xff)
	} else {
		header = make([]byte, 22)
		header[3] = 0x04
		copy(header[4:20], srcIP.To16())
		header[20] = byte(srcPort >> 8)
		header[21] = byte(srcPort & 0xff)
	}
	// The header above is already the full RFC 1928 datagram header
	// (RSV+FRAG+ATYP+ADDR+PORT). The TS server prepends ANOTHER [00 00 00],
	// producing a 13-byte double prefix real SOCKS5 UDP clients must skip
	// past; we send the RFC-correct layout on purpose (only servers emit
	// this wrap, so no TS peer ever parses it).
	out := append(header, data...)
	assoc.mu.Lock()
	addr := assoc.clients[srcAddr+fmt.Sprintf(":%d", srcPort)]
	assoc.lastAct = time.Now()
	assoc.mu.Unlock()
	if addr == nil {
		// Unknown source: reply to the address the response claims, best effort.
		addr = &net.UDPAddr{IP: srcIP, Port: srcPort}
	}
	_, _ = assoc.udp.WriteToUDP(out, addr)
}

func peerIP(conn net.Conn) string {
	if ra, ok := conn.RemoteAddr().(*net.TCPAddr); ok {
		return ra.IP.String()
	}
	host, _, err := net.SplitHostPort(conn.RemoteAddr().String())
	if err != nil {
		return conn.RemoteAddr().String()
	}
	return host
}

func peerIPFrom(rinfo *net.UDPAddr) string {
	return rinfo.IP.String()
}
