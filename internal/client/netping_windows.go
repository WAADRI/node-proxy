//go:build windows

package client

import (
	"encoding/binary"
	"fmt"
	"net"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// ICMP echo via iphlpapi's IcmpSendEcho: works for unprivileged users on
// Windows (the OS opens the raw handle for us), and IcmpSendEcho with a TTL
// option doubles as the traceroute engine - each probe with TTL=n elicits an
// ICMP TIME_EXCEEDED from hop n, delivered through the same call.
var (
	modiphlpapi         = windows.NewLazySystemDLL("iphlpapi.dll")
	procIcmpCreateFile  = modiphlpapi.NewProc("IcmpCreateFile")
	procIcmpCloseHandle = modiphlpapi.NewProc("IcmpCloseHandle")
	procIcmpSendEcho    = modiphlpapi.NewProc("IcmpSendEcho")
)

const (
	ipSuccess      = 0
	ipTimeExceeded = 11013
)

type icmpOptions struct {
	Ttl         uint8
	Tos         uint8
	Flags       uint8
	OptionsSize uint8
	OptionsData *byte
}

type icmpEchoReply struct {
	Address       uint32
	Status        uint32
	RoundTripTime uint32
	DataSize      uint16
	Reserved      uint16
	Data          *byte
	Options       icmpOptions
}

func icmpSendEchoRaw(destUint32 uint32, ttl int, payload []byte, timeoutMS uint32) (hopIP net.IP, rttMS float64, status uint32, err error) {
	handle, _, _ := procIcmpCreateFile.Call()
	if handle == 0 {
		return nil, 0, 0, fmt.Errorf("IcmpCreateFile failed")
	}
	defer procIcmpCloseHandle.Call(handle)

	replySize := uint32(unsafe.Sizeof(icmpEchoReply{})) + uint32(len(payload)) + 8
	replyBuf := make([]byte, replySize)

	var opts *icmpOptions
	var optsBuf icmpOptions
	if ttl > 0 {
		optsBuf = icmpOptions{Ttl: uint8(ttl)}
		opts = &optsBuf
	}

	ret, _, _ := procIcmpSendEcho.Call(
		handle,
		uintptr(destUint32),
		uintptr(unsafe.Pointer(&payload[0])),
		uintptr(len(payload)),
		uintptr(unsafe.Pointer(opts)),
		uintptr(unsafe.Pointer(&replyBuf[0])),
		uintptr(replySize),
		uintptr(timeoutMS),
	)
	if ret == 0 {
		return nil, 0, 0, fmt.Errorf("IcmpSendEcho failed")
	}
	reply := (*icmpEchoReply)(unsafe.Pointer(&replyBuf[0]))
	// IcmpSendEcho stores the address as a host-order u32 whose memory image
	// is the network-order IP bytes - read it little-endian.
	addr := make(net.IP, 4)
	binary.LittleEndian.PutUint32(addr, reply.Address)
	return addr, float64(reply.RoundTripTime), reply.Status, nil
}

// icmpSendEcho sends one echo to dest. The ipaddr parameter is the IP in
// network byte order stored in a u32 - i.e. LittleEndian read of the bytes
// (verified empirically: BE silently pinged 1.0.0.127 instead of 127.0.0.1).
func icmpSendEcho(dest net.IP, ttl int, payload []byte, timeoutMS uint32) (hopIP net.IP, rttMS float64, status uint32, err error) {
	return icmpSendEchoRaw(binary.LittleEndian.Uint32(dest.To4()), ttl, payload, timeoutMS)
}

// icmpPingRTT: n probes, returns per-probe ms (0 for lost) via ICMP.
func icmpPingRTT(host string, count, timeoutMS int) ([]float64, bool) {
	dest, err := net.ResolveIPAddr("ip4", host)
	if err != nil {
		return nil, false
	}
	payload := []byte("node-proxy-go-icmp!")
	out := make([]float64, count)
	for i := 0; i < count; i++ {
		_, ms, status, err := icmpSendEcho(dest.IP, 0, payload, uint32(timeoutMS))
		if err == nil && status == ipSuccess {
			out[i] = ms
			if out[i] == 0 {
				// Sub-millisecond loopback RTT: IcmpSendEcho quantizes to ms.
				// A floor keeps success distinguishable from a lost probe.
				out[i] = 0.001
			}
		}
		if i < count-1 {
			time.Sleep(150 * time.Millisecond)
		}
	}
	return out, true
}

// icmpTraceroute: TTL-stepped echoes; TIME_EXCEEDED replies name the hop.
func icmpTraceroute(host string, maxHops, timeoutMS int) ([]tracerouteHop, bool) {
	dest, err := net.ResolveIPAddr("ip4", host)
	if err != nil {
		return nil, false
	}
	payload := []byte("node-proxy-go-traceroute")
	hops := make([]tracerouteHop, 0, maxHops)
	for ttl := 1; ttl <= maxHops; ttl++ {
		addr, ms, status, err := icmpSendEcho(dest.IP, ttl, payload, uint32(timeoutMS))
		if err != nil || addr == nil {
			hops = append(hops, tracerouteHop{TTL: ttl, IP: "", MS: 0})
			continue
		}
		if status == ipSuccess {
			hops = append(hops, tracerouteHop{TTL: ttl, IP: addr.String(), MS: ms})
			return hops, true // destination reached
		}
		if status == ipTimeExceeded {
			hops = append(hops, tracerouteHop{TTL: ttl, IP: addr.String(), MS: ms})
			continue
		}
		hops = append(hops, tracerouteHop{TTL: ttl, IP: "", MS: 0})
	}
	return hops, true
}

func icmpAvailable() bool {
	h, _, _ := procIcmpCreateFile.Call()
	if h == 0 {
		return false
	}
	procIcmpCloseHandle.Call(h)
	return true
}
