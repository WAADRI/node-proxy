package client

import (
	"net"
	"strconv"
	"time"

	"github.com/WAADRI/node-proxy-go/internal/streammux"
)

// tunnelReady / tunnelError are the HEADERS the node answers with, mirroring
// the TS handleMuxTunnel payloads (key order matters for golden parity only;
// receivers parse JSON).
type tunnelReady struct {
	Type string `json:"type"`
	ID   uint32 `json:"id"`
}

type tunnelError struct {
	Type    string `json:"type"`
	ID      uint32 `json:"id"`
	Message string `json:"message"`
	Code    string `json:"code"`
}

// hardCloseGrace matches the TS 5s destroy-after-FIN: a keep-alive target can
// hold its half open indefinitely after our FIN, leaking fds and slots. The
// timer is intentionally not tracked - closing an already-closed conn is a
// no-op, and a live 5s timer per ended tunnel is negligible.
const hardCloseGrace = 5 * time.Second

// handleTunnel carries one accepted TUNNEL_OPEN through dial -> pipe ->
// teardown, mirroring TS handleMuxTunnel including its slot-leak fixes:
// connect-phase failures report tunnel_error while established-stream resets
// do not, and the slot is released on every end path.
func (c *Client) handleTunnel(s *streammux.Stream, host string, port int) {
	tunnelID := s.ID()

	if c.tunnels.Load() >= int64(c.maxConcurrent()) {
		if c.log != nil {
			c.log.Warnf("tunnel %d rejected: client busy (active %d/%d)", tunnelID, c.tunnels.Load(), c.maxConcurrent())
		}
		_ = s.SendHeaders(tunnelError{"tunnel_error", tunnelID, "Client busy", ""}, false)
		s.Close()
		return
	}
	c.tunnels.Add(1)
	defer c.tunnels.Add(-1)

	if !validTarget(host, port) {
		if c.log != nil {
			c.log.Warnf("tunnel %d invalid target %s:%d", tunnelID, host, port)
		}
		_ = s.SendHeaders(tunnelError{"tunnel_error", tunnelID, "Invalid target " + host + ":" + strconv.Itoa(port), "EBADTARGET"}, false)
		s.Close()
		return
	}

	if c.log != nil {
		c.log.Infof("opening tunnel %d to %s:%d", tunnelID, host, port)
	}
	conn, err := net.DialTimeout("tcp", net.JoinHostPort(host, strconv.Itoa(port)), c.cfg.TunnelTimeout)
	if err != nil {
		if c.log != nil {
			c.log.Errorf("tunnel %d failed to %s:%d: %v", tunnelID, host, port, err)
		}
		_ = s.SendHeaders(tunnelError{"tunnel_error", tunnelID, err.Error(), errCode(err)}, false)
		s.Close()
		return
	}

	if c.log != nil {
		c.log.Infof("tunnel %d established to %s:%d", tunnelID, host, port)
	}
	_ = s.SendHeaders(tunnelReady{"tunnel_ready", tunnelID}, false)

	// Target -> mux. When the target finishes (EOF or error), gracefully
	// close the stream - the socket.on('close') equivalent.
	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, readErr := conn.Read(buf)
			if n > 0 {
				// TS checks stream state before writing; SendData refuses
				// half-closed/closed streams the same way.
				if !s.SendData(buf[:n], false) {
					break
				}
			}
			if readErr != nil {
				break
			}
		}
		s.Close()
	}()

	// Mux -> target.
	s.OnData(func(chunk []byte) {
		if _, err := conn.Write(chunk); err != nil {
			_ = conn.Close()
		}
	})
	s.OnEnd(func() {
		// Server ended the tunnel: half-close the target, then hard-destroy
		// after the grace period (TS stream._onEnd).
		if tc, ok := conn.(*net.TCPConn); ok {
			_ = tc.CloseWrite()
		}
		time.AfterFunc(hardCloseGrace, func() { _ = conn.Close() })
	})
	s.OnError(func(any) {
		// RST or connection loss: destroy immediately (TS stream._onError).
		_ = conn.Close()
	})
}

func validTarget(host string, port int) bool {
	return host != "" && port >= 1 && port <= 65535
}

// errCode extracts an errno-style code from a dial error, mirroring the TS
// err.code the server may log.
func errCode(err error) string {
	if ne, ok := err.(net.Error); ok && ne.Timeout() {
		return "ETIMEDOUT"
	}
	if _, ok := err.(*net.OpError); ok {
		return "ECONNREFUSED"
	}
	return ""
}
