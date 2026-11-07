package client

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

func httpCtx(timeoutMS int) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), time.Duration(timeoutMS)*time.Millisecond)
}

// NetTestResult mirrors the TS NetTestResult shape the panel renders.
type NetTestResult struct {
	OK        bool     `json:"ok"`
	Mode      string   `json:"mode,omitempty"`
	MS        float64  `json:"ms,omitempty"`
	Port      int      `json:"port,omitempty"`
	Status    int      `json:"status,omitempty"`
	Size      int      `json:"size,omitempty"`
	SpeedKBps float64  `json:"speedKBps,omitempty"`
	Detail    string   `json:"detail,omitempty"`
	Note      string   `json:"note,omitempty"`
	Extra     []dnsRec `json:"extra,omitempty"`
	Error     string   `json:"error,omitempty"`
}

type dnsRec struct {
	Type  string `json:"type"`
	Value string `json:"value"`
}

// netTestBusy guards concurrent tasks (TS: one at a time per node).
var netTestBusy atomic.Bool

// handleNetTest executes a server-pushed test task (TS handleNetTest):
// one progress report per target, then done.
func (c *Client) handleNetTest(data []byte) {
	var msg struct {
		TaskID  string `json:"taskId"`
		Payload struct {
			Type    string         `json:"type"`
			Targets []string       `json:"targets"`
			Options map[string]any `json:"options"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(data, &msg); err != nil || msg.TaskID == "" {
		return
	}
	sendDone := func(errMsg string) {
		body := map[string]any{"type": "net_test_done", "taskId": msg.TaskID}
		if errMsg != "" {
			body["error"] = errMsg
		}
		if b, err := json.Marshal(body); err == nil {
			c.sendText(b)
		}
	}
	if len(msg.Payload.Targets) == 0 {
		sendDone("invalid task payload")
		return
	}
	if !netTestBusy.CompareAndSwap(false, true) {
		sendDone("节点忙：已有测试任务在执行")
		return
	}
	go func() {
		defer netTestBusy.Store(false)
		if c.log != nil {
			c.log.Infof("net test started: %s x %d targets (%s)", msg.Payload.Type, len(msg.Payload.Targets), msg.TaskID)
		}
		for i, target := range msg.Payload.Targets {
			res := runNetTest(msg.Payload.Type, target, msg.Payload.Options)
			report := map[string]any{
				"type": msg.Payload.Type, "index": i, "target": target, "result": res,
			}
			progressBody := map[string]any{
				"type": "net_test_progress", "taskId": msg.TaskID,
				"type_":  report["type"],
				"index":  report["index"],
				"target": report["target"],
				"result": res,
			}
			_ = progressBody
			progress, _ := json.Marshal(map[string]any{
				"type": "net_test_progress", "taskId": msg.TaskID,
				"index": i, "target": target, "result": res,
			})
			c.sendText(progress)
		}
		if c.log != nil {
			c.log.Infof("net test done: %s", msg.TaskID)
		}
		sendDone("")
	}()
}

// runNetTest dispatches one target to its probe (TS run()).
func runNetTest(testType, target string, options map[string]any) NetTestResult {
	switch testType {
	case "ping":
		return netTestPing(target, options) // TCP fallback (mode "tcp")
	case "tcping":
		return netTestTcping(target, options)
	case "http":
		return netTestHTTP(target, options)
	case "dns":
		return netTestDNS(target, options)
	case "traceroute":
		return NetTestResult{OK: false, Error: "traceroute is not supported by this go node"}
	default:
		return NetTestResult{OK: false, Error: "unknown test type " + testType}
	}
}

func optInt(options map[string]any, key string, def int) int {
	if v, ok := options[key].(float64); ok && v > 0 {
		return int(v)
	}
	return def
}

func hostOf(target string) string {
	target = strings.TrimSpace(target)
	if h, _, err := net.SplitHostPort(target); err == nil {
		return h
	}
	if strings.HasPrefix(target, "http://") || strings.HasPrefix(target, "https://") {
		trimmed := strings.TrimPrefix(strings.TrimPrefix(target, "https://"), "http://")
		if h, _, err := net.SplitHostPort(trimmed); err == nil {
			return h
		}
		return strings.SplitN(trimmed, "/", 2)[0]
	}
	return target
}

func hostPortOf(target string, defPort int) (string, int) {
	t := strings.TrimSpace(target)
	if h, p, err := net.SplitHostPort(t); err == nil {
		if n, err := strconv.Atoi(p); err == nil {
			return h, n
		}
	}
	if strings.HasPrefix(t, "http://") || strings.HasPrefix(t, "https://") {
		u := t
		port := 80
		if strings.HasPrefix(t, "https://") {
			port = 443
		}
		u = strings.TrimPrefix(strings.TrimPrefix(u, "https://"), "http://")
		if h, p, err := net.SplitHostPort(u); err == nil {
			if n, err := strconv.Atoi(p); err == nil {
				return h, n
			}
		}
		return strings.SplitN(u, "/", 2)[0], port
	}
	return t, defPort
}

// netTestPing is the TS TCP fallback: N probes, averaged (ICMP needs raw
// sockets, which are privileged on Windows - documented divergence).
func netTestPing(target string, options map[string]any) NetTestResult {
	count := optInt(options, "count", 3)
	if count < 1 || count > 10 {
		count = 3
	}
	timeout := optInt(options, "timeout", 2000)
	host := hostOf(target)
	var total time.Duration
	ok := 0
	for i := 0; i < count; i++ {
		start := time.Now()
		conn, err := net.DialTimeout("tcp", net.JoinHostPort(host, "80"), time.Duration(timeout)*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			total += time.Since(start)
			ok++
		}
		if i < count-1 {
			time.Sleep(200 * time.Millisecond)
		}
	}
	if ok == 0 {
		return NetTestResult{OK: false, Mode: "tcp", Error: "no tcp response on :80", Detail: host}
	}
	return NetTestResult{OK: true, Mode: "tcp", MS: float64(total.Microseconds()) / float64(ok) / 1000, Detail: fmt.Sprintf("%d/%d probes", ok, count), Note: host}
}

// netTestTcping probes one host:port once.
func netTestTcping(target string, options map[string]any) NetTestResult {
	host, port := hostPortOf(target, optInt(options, "port", 80))
	timeout := optInt(options, "timeout", 3000)
	start := time.Now()
	conn, err := net.DialTimeout("tcp", net.JoinHostPort(host, strconv.Itoa(port)), time.Duration(timeout)*time.Millisecond)
	if err != nil {
		return NetTestResult{OK: false, Port: port, Error: err.Error()}
	}
	_ = conn.Close()
	return NetTestResult{OK: true, MS: float64(time.Since(start).Microseconds()) / 1000, Port: port}
}

// netTestHTTP measures a GET: status, size, duration, throughput.
func netTestHTTP(target string, options map[string]any) NetTestResult {
	if !strings.HasPrefix(target, "http://") && !strings.HasPrefix(target, "https://") {
		target = "http://" + target
	}
	timeout := optInt(options, "timeout", 10000)
	start := time.Now()
	req, err := http.NewRequest("GET", target, nil)
	if err != nil {
		return NetTestResult{OK: false, Error: err.Error()}
	}
	ctx, cancel := httpCtx(timeout)
	defer cancel()
	resp, err := http.DefaultClient.Do(req.WithContext(ctx))
	if err != nil {
		return NetTestResult{OK: false, Error: err.Error()}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	ms := float64(time.Since(start).Microseconds()) / 1000
	speed := 0.0
	if ms > 0 {
		speed = float64(len(body)) / 1024 / (ms / 1000)
	}
	return NetTestResult{
		OK: resp.StatusCode < 400, Status: resp.StatusCode, MS: ms,
		Size: len(body), SpeedKBps: speed, Detail: resp.Status,
	}
}

// netTestDNS resolves A/AAAA records with timing.
func netTestDNS(target string, options map[string]any) NetTestResult {
	host := hostOf(target)
	start := time.Now()
	ips, err := net.LookupHost(host)
	ms := float64(time.Since(start).Microseconds()) / 1000
	if err != nil {
		return NetTestResult{OK: false, Error: err.Error()}
	}
	extra := make([]dnsRec, 0, len(ips))
	for _, ip := range ips {
		rec := dnsRec{Type: "A", Value: ip}
		if strings.Contains(ip, ":") {
			rec.Type = "AAAA"
		}
		extra = append(extra, rec)
	}
	return NetTestResult{OK: true, MS: ms, Extra: extra, Note: fmt.Sprintf("%d records", len(ips))}
}
