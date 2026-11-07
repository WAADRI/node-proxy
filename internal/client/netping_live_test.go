package client

import "testing"

// TestICMPLiveWindows pings the loopback through the real iphlpapi path;
// skipped on non-Windows (and on CI without the privilege it still works -
// IcmpSendEcho is unprivileged).
func TestICMPLiveWindows(t *testing.T) {
	times, ok := icmpPingRTT("127.0.0.1", 2, 1000)
	if !ok {
		t.Skip("ICMP unavailable on this platform")
	}
	lost := 0
	for _, ms := range times {
		if ms <= 0 {
			lost++
		}
	}
	if lost == len(times) {
		t.Fatalf("all loopback ICMP probes lost: %v", times)
	}
}

// TestTracerouteLiveLoopback: the loopback route ignores TTL, so the first
// probe reaches the destination - a deterministic traceroute check on
// Windows (skips where ICMP raw access is unavailable).
func TestTracerouteLiveLoopback(t *testing.T) {
	hops, ok := icmpTraceroute("127.0.0.1", 10, 1000)
	if !ok {
		t.Skip("traceroute unavailable on this platform")
	}
	if len(hops) == 0 || hops[len(hops)-1].IP != "127.0.0.1" {
		t.Fatalf("hops = %+v, want loopback as final hop", hops)
	}
}
