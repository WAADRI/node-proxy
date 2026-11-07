package client

import (
	"encoding/base64"
	"encoding/json"
	"net"
	"sync"
	"time"
)

// udpAssoc mirrors TS handleUdpData: one UDP socket per server association,
// a pending table for response routing, and a 3-minute idle timer.
type udpAssoc struct {
	conn    *net.UDPConn
	mu      sync.Mutex
	pending map[string]*udpPending // udpId -> request info (most recent last)
	order   []string               // insertion order for the most-recent fallback
	src     *udpSrc
	timer   *time.Timer
	c       *Client
}

type udpPending struct {
	src     *udpSrc
	rport   int
	created time.Time
}

type udpSrc struct {
	Address string `json:"address"`
	Port    int    `json:"port"`
}

var udpAssocs = struct {
	mu    sync.Mutex
	assoc map[string]*udpAssoc
}{assoc: map[string]*udpAssoc{}}

// handleUdpData processes a server-pushed udp_data text message: dial the
// target, relay the payload, route responses back over the control plane.
func (c *Client) handleUdpData(data []byte) {
	var msg struct {
		ID      string  `json:"id"`
		AssocID string  `json:"assocId"`
		Host    string  `json:"host"`
		Port    int     `json:"port"`
		Src     *udpSrc `json:"src"`
		Data    string  `json:"data"`
	}
	if err := json.Unmarshal(data, &msg); err != nil {
		return
	}
	if msg.AssocID == "" || msg.Host == "" || msg.Port == 0 || msg.Data == "" {
		return
	}
	payload, err := base64.StdEncoding.DecodeString(msg.Data)
	if err != nil || len(payload) == 0 {
		return
	}

	udpAssocs.mu.Lock()
	a := udpAssocs.assoc[msg.AssocID]
	if a == nil {
		conn, derr := net.DialUDP("udp4", nil, &net.UDPAddr{IP: net.ParseIP(msg.Host), Port: msg.Port})
		if derr != nil {
			udpAssocs.mu.Unlock()
			if c.log != nil {
				c.log.Warnf("udp relay dial %s:%d failed: %v", msg.Host, msg.Port, derr)
			}
			return
		}
		a = &udpAssoc{
			conn:    conn,
			pending: map[string]*udpPending{},
			src:     msg.Src,
			timer:   time.AfterFunc(3*time.Minute, func() { closeUdpAssoc(msg.AssocID) }),
			c:       c,
		}
		udpAssocs.assoc[msg.AssocID] = a
		go a.readLoop(msg.AssocID)
	} else {
		if a.src == nil {
			a.src = msg.Src
		}
		a.timer.Reset(3 * time.Minute)
	}
	a.mu.Lock()
	a.pending[msg.ID] = &udpPending{src: msg.Src, rport: msg.Port, created: time.Now()}
	a.order = append(a.order, msg.ID)
	a.mu.Unlock()
	udpAssocs.mu.Unlock()

	_, _ = a.conn.Write(payload)
}

// readLoop routes responses back to the server: the pending request whose
// target port matches the responder wins, else the most recent (TS parity).
func (a *udpAssoc) readLoop(assocID string) {
	buf := make([]byte, 65536)
	for {
		n, rinfo, err := a.conn.ReadFromUDP(buf)
		if err != nil {
			return
		}
		a.mu.Lock()
		matched := ""
		for id, p := range a.pending {
			if p.rport == rinfo.Port {
				matched = id
				break
			}
		}
		if matched == "" && len(a.order) > 0 {
			matched = a.order[len(a.order)-1]
		}
		if matched == "" {
			a.mu.Unlock()
			return
		}
		p := a.pending[matched]
		src := p.src
		if src == nil {
			src = a.src
		}
		// Keep the entry so later responses reuse src (TS keeps pending until
		// the association ends).
		a.mu.Unlock()

		payload, _ := json.Marshal(map[string]any{
			"type":    "udp_data_response",
			"id":      matched,
			"assocId": assocID,
			"src":     src,
			"rinfo":   map[string]any{"address": rinfo.IP.String(), "port": rinfo.Port},
			"data":    base64.StdEncoding.EncodeToString(buf[:n]),
		})
		if !a.c.sendText(payload) {
			return
		}
	}
}

func closeUdpAssoc(assocID string) {
	udpAssocs.mu.Lock()
	a := udpAssocs.assoc[assocID]
	delete(udpAssocs.assoc, assocID)
	udpAssocs.mu.Unlock()
	if a != nil {
		a.timer.Stop()
		_ = a.conn.Close()
	}
}

// closeAllUdpAssocs tears down every association (connection teardown).
func closeAllUdpAssocs() {
	udpAssocs.mu.Lock()
	ids := make([]string, 0, len(udpAssocs.assoc))
	for id := range udpAssocs.assoc {
		ids = append(ids, id)
	}
	udpAssocs.mu.Unlock()
	for _, id := range ids {
		closeUdpAssoc(id)
	}
}
