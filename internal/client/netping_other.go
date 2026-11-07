//go:build !windows && !linux

package client

// Non-Windows/non-Linux platforms (darwin, *bsd): ICMP echo needs raw
// sockets with elevated privileges and traceroute the same - keep the TCP
// fallback and report the requirement, mirroring the TS behavior when its
// raw-socket module is unavailable.

func icmpPingRTT(host string, count, timeoutMS int) ([]float64, bool) {
	return nil, false
}

func icmpAvailable() bool { return false }

func icmpTraceroute(host string, maxHops, timeoutMS int) ([]tracerouteHop, bool) {
	return nil, false
}
