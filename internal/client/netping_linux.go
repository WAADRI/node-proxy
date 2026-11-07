//go:build linux

package client

import (
	"net"
	"time"

	"golang.org/x/net/icmp"
	"golang.org/x/net/ipv4"
)

// ICMP on Linux: try the unprivileged UDP ping socket first (kernel turns
// the payload into an echo when ping_group_range allows), fall back to a
// raw ICMP socket (root/CAP_NET_RAW). Both feed the same result shape.
type icmpConn struct {
	conn    *icmp.PacketConn
	payload []byte // sent bytes; replies carry them back (raw mode prepends headers)
	raw     bool
}

func openICMP() (*icmpConn, error) {
	if c, err := icmp.ListenPacket("udp4", ""); err == nil {
		return &icmpConn{conn: c, payload: []byte("node-proxy-go-icmp!")}, nil
	}
	c, err := icmp.ListenPacket("icmp4", "")
	if err != nil {
		return nil, err
	}
	return &icmpConn{conn: c, payload: []byte("node-proxy-go-icmp!"), raw: true}, nil
}

// pingOne sends one echo and returns the RTT, or false on loss.
func (c *icmpConn) pingOne(dest *net.IPAddr, timeoutMS int) (float64, bool) {
	var wb []byte
	if c.raw {
		msg := icmp.Message{Type: ipv4.ICMPTypeEcho, Code: 0,
			Body: &icmp.Echo{ID: 0x4e50, Seq: 1, Data: c.payload}}
		enc, err := msg.Marshal(nil)
		if err != nil {
			return 0, false
		}
		wb = enc
	} else {
		wb = c.payload // the kernel adds the ICMP header for ping sockets
	}
	start := time.Now()
	if _, err := c.conn.WriteTo(wb, dest); err != nil {
		return 0, false
	}
	deadline := time.Now().Add(time.Duration(timeoutMS) * time.Millisecond)
	buf := make([]byte, 1500)
	for {
		if err := c.conn.SetReadDeadline(deadline); err != nil {
			return 0, false
		}
		n, _, err := c.conn.ReadFrom(buf)
		if err != nil {
			return 0, false // deadline
		}
		data := buf[:n]
		if c.raw {
			m, err := icmp.ParseMessage(1, data)
			if err != nil || m.Type != ipv4.ICMPTypeEchoReply {
				continue
			}
			echo, ok := m.Body.(*icmp.Echo)
			if !ok || string(echo.Data) != string(c.payload) {
				continue
			}
		} else if string(data) != string(c.payload) {
			continue // not our reply
		}
		return float64(time.Since(start).Microseconds()) / 1000, true
	}
}

func icmpPingRTT(host string, count, timeoutMS int) ([]float64, bool) {
	dest, err := net.ResolveIPAddr("ip4", host)
	if err != nil {
		return nil, false
	}
	c, err := openICMP()
	if err != nil {
		return nil, false
	}
	defer c.conn.Close()

	out := make([]float64, count)
	for i := 0; i < count; i++ {
		if ms, ok := c.pingOne(dest, timeoutMS); ok {
			out[i] = ms
		}
		if i < count-1 {
			time.Sleep(150 * time.Millisecond)
		}
	}
	return out, true
}

func icmpAvailable() bool {
	c, err := openICMP()
	if err != nil {
		return false
	}
	_ = c.conn.Close()
	return true
}

// icmpTraceroute sends UDP probes with rising TTL and reads TIME_EXCEEDED
// from a raw ICMP socket - requires root/CAP_NET_RAW, exactly like the TS
// raw-socket implementation.
func icmpTraceroute(host string, maxHops, timeoutMS int) ([]tracerouteHop, bool) {
	dest, err := net.ResolveIPAddr("ip4", host)
	if err != nil {
		return nil, false
	}
	raw, err := icmp.ListenPacket("icmp4", "")
	if err != nil {
		return nil, false
	}
	defer raw.Close()
	udp, err := net.DialUDP("udp4", nil, &net.UDPAddr{IP: dest.IP, Port: 33434})
	if err != nil {
		return nil, false
	}
	defer udp.Close()
	pconn := ipv4.NewPacketConn(udp)

	hops := make([]tracerouteHop, 0, maxHops)
	reached := false
	for ttl := 1; ttl <= maxHops && !reached; ttl++ {
		if err := pconn.SetTTL(ttl); err != nil {
			return nil, false
		}
		probe := []byte{byte(ttl), 0xAA}
		start := time.Now()
		if _, err := udp.Write(probe); err != nil {
			return nil, false
		}
		hop := tracerouteHop{TTL: ttl}
		deadline := time.Now().Add(time.Duration(timeoutMS) * time.Millisecond)
		for time.Now().Before(deadline) {
			if err := raw.SetReadDeadline(deadline); err != nil {
				break
			}
			buf := make([]byte, 1500)
			n, from, err := raw.ReadFrom(buf)
			if err != nil {
				break
			}
			m, err := icmp.ParseMessage(1, buf[:n])
			if err != nil {
				continue
			}
			if m.Type == ipv4.ICMPTypeTimeExceeded {
				hop.IP, hop.MS = addrIP(from), float64(time.Since(start).Microseconds())/1000
				hops = append(hops, hop)
				break
			}
			if m.Type == ipv4.ICMPTypeEchoReply {
				hop.IP, hop.MS = dest.String(), float64(time.Since(start).Microseconds())/1000
				hops = append(hops, hop)
				reached = true
				break
			}
		}
		if hop.IP == "" {
			hops = append(hops, hop) // timeout row
		}
	}
	return hops, true
}

func addrIP(addr net.Addr) string {
	if a, ok := addr.(*net.IPAddr); ok {
		return a.IP.String()
	}
	host, _, err := net.SplitHostPort(addr.String())
	if err != nil {
		return addr.String()
	}
	return host
}
