package client

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/WAADRI/node-proxy-go/internal/streammux"
)

// reqs is the process-wide in-flight request table (one client per process,
// like the TS module).
var reqs = newRequestTracker()

// muxRequestHeaders is the HEADERS payload the server sends to dispatch an
// HTTP request over the mux (proxy-http.ts): {type:'request', id, method,
// url, headers}. The id echoes back verbatim in the response.
type muxRequestHeaders struct {
	Type           string          `json:"type"`
	ID             json.RawMessage `json:"id"`
	Method         string          `json:"method"`
	URL            string          `json:"url"`
	RequestHeaders map[string]any  `json:"requestHeaders"`
	Headers        map[string]any  `json:"headers"`
}

// muxResponse mirrors executeMuxRequest's response HEADERS.
type muxResponse struct {
	Type          string          `json:"type"`
	ID            json.RawMessage `json:"id"`
	StatusCode    int             `json:"statusCode"`
	StatusMessage string          `json:"statusMessage"`
	Headers       map[string]any  `json:"headers"`
}

// requestTracker guards the in-flight request table: concurrency limit plus
// the duplicate-id refusal (issue #123 - an overwritten entry orphans the
// first request and misroutes cleanups).
type requestTracker struct {
	mu     sync.Mutex
	active map[string]struct{}
}

func newRequestTracker() *requestTracker {
	return &requestTracker{active: make(map[string]struct{})}
}

func (t *requestTracker) len() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.active)
}

func (t *requestTracker) add(id json.RawMessage) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if _, ok := t.active[string(id)]; ok {
		return false
	}
	t.active[string(id)] = struct{}{}
	return true
}

func (t *requestTracker) remove(id json.RawMessage) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.active, string(id))
}

// handleMuxRequest executes one HTTP request stream (TS handleMuxRequest +
// executeMuxRequest): collect the body from DATA frames until END_STREAM,
// perform the upstream request, answer with {type:'response',...} HEADERS,
// the body and END_STREAM, then close the stream.
func (c *Client) handleMuxRequest(s *streammux.Stream, raw json.RawMessage) {
	var h muxRequestHeaders
	if err := json.Unmarshal(raw, &h); err != nil {
		// Unparseable request headers: nothing to answer with - close.
		s.Close()
		return
	}
	requestID := h.ID
	if len(requestID) == 0 {
		requestID = json.RawMessage(formatID(s.ID()))
	}

	if reqs.len() >= c.maxConcurrent() {
		if c.log != nil {
			c.log.Warnf("request %s rejected: client busy (active %d/%d)", string(requestID), reqs.len(), c.maxConcurrent())
		}
		c.respondError(s, requestID, 503, "Service Unavailable", "Client busy")
		s.Close()
		return
	}
	if !reqs.add(requestID) {
		if c.log != nil {
			c.log.Warnf("duplicate request id %s ignored", string(requestID))
		}
		s.Close()
		return
	}
	c.activeRequests.Add(1)
	defer c.activeRequests.Add(-1)

	// Body collection: DATA frames until END_STREAM (or empty when the
	// request arrived already half-closed, TS dispatchOnce).
	var (
		bodyMu     sync.Mutex
		body       []byte
		dispatched bool
	)
	dispatch := func() {
		bodyMu.Lock()
		if dispatched {
			bodyMu.Unlock()
			return
		}
		dispatched = true
		bodyMu.Unlock()
		c.executeMuxRequest(s, &h, requestID, body)
	}

	if st := s.State(); st == streammux.StateHalfClosedRemote || st == streammux.StateClosed {
		dispatch()
		return
	}
	s.OnData(func(chunk []byte) {
		bodyMu.Lock()
		body = append(body, chunk...)
		bodyMu.Unlock()
	})
	s.OnEnd(dispatch)
}

func (c *Client) executeMuxRequest(s *streammux.Stream, h *muxRequestHeaders, requestID json.RawMessage, body []byte) {
	method := h.Method
	if method == "" {
		method = "GET"
	}
	targetURL := h.URL
	upstream := h.RequestHeaders
	if upstream == nil {
		upstream = h.Headers
	}

	// TS validates with new URL(), which throws on URLs without a scheme -
	// http.NewRequest accepts schemeless URLs, so check explicitly.
	if !strings.HasPrefix(targetURL, "http://") && !strings.HasPrefix(targetURL, "https://") {
		c.respondError(s, requestID, 400, "Bad Request", "Invalid request: Invalid URL")
		s.Close()
		return
	}
	req, err := http.NewRequest(method, targetURL, nil)
	if err != nil {
		c.respondError(s, requestID, 400, "Bad Request", "Invalid request: "+err.Error())
		s.Close()
		return
	}
	applyUpstreamHeaders(req.Header, upstream)
	req.Header.Del("Host")
	req.Header.Del("Proxy-Connection")
	req.Header.Del("Transfer-Encoding")
	if len(body) > 0 {
		req.Body = io.NopCloser(strings.NewReader(string(body)))
	}

	ctx, cancel := context.WithTimeout(context.Background(), c.cfg.RequestTimeout)
	defer cancel()
	req = req.WithContext(ctx)
	transport := &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: !c.cfg.TLSRejectUnauthorized},
	}
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse // proxy: forward redirects verbatim
	}}

	resp, err := client.Do(req)
	if err != nil {
		reqs.remove(requestID)
		if isTimeout(err) {
			if c.log != nil {
				c.log.Warnf("request %s timed out after %s", string(requestID), c.cfg.RequestTimeout)
			}
			c.respondError(s, requestID, 504, "Gateway Timeout", "Request timeout")
		} else {
			if c.log != nil {
				c.log.Errorf("request %s failed: %v", string(requestID), err)
			}
			c.respondError(s, requestID, 502, "Bad Gateway", err.Error())
		}
		s.Close()
		return
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	reqs.remove(requestID)

	_ = s.SendHeaders(muxResponse{
		Type:          "response",
		ID:            requestID,
		StatusCode:    resp.StatusCode,
		StatusMessage: statusPhrase(resp.Status),
		Headers:       flattenHeader(resp.Header),
	}, false)
	s.SendData(respBody, true)
	// END_STREAM only half-closes; close() releases the stream slot (TS
	// comment: ~1.1 KB per request would otherwise live forever).
	s.Close()
}

// respondError answers with a JSON error response body (TS error paths).
func (c *Client) respondError(s *streammux.Stream, requestID json.RawMessage, code int, phrase, message string) {
	_ = s.SendHeaders(muxResponse{
		Type:          "response",
		ID:            requestID,
		StatusCode:    code,
		StatusMessage: phrase,
		Headers:       map[string]any{"content-type": "text/plain"},
	}, false)
	s.SendData([]byte(message), true)
}

// applyUpstreamHeaders copies the peer-supplied headers onto the request.
// Values may be strings or arrays (Node headers shape); hop-by-hop and host
// headers are stripped by the caller.
func applyUpstreamHeaders(dst http.Header, src map[string]any) {
	for k, v := range src {
		switch name := strings.ToLower(k); name {
		case "host", "proxy-connection", "transfer-encoding", "content-length":
			continue
		default:
		}
		switch val := v.(type) {
		case string:
			dst.Add(k, val)
		case []any:
			for _, item := range val {
				if str, ok := item.(string); ok {
					dst.Add(k, str)
				}
			}
		}
	}
}

// flattenHeader lowercases header names, matching Node's res.headers shape.
type kv struct {
	k string
	v any
}

func flattenHeader(h http.Header) map[string]any {
	keys := make([]string, 0, len(h))
	for k := range h {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make(map[string]any, len(h))
	for _, k := range keys {
		vals := h[k]
		if len(vals) == 1 {
			out[strings.ToLower(k)] = vals[0]
		} else {
			out[strings.ToLower(k)] = append([]string(nil), vals...)
		}
	}
	return out
}

func statusPhrase(status string) string {
	if i := strings.IndexByte(status, ' '); i >= 0 && i+1 < len(status) {
		return status[i+1:]
	}
	return ""
}

func isTimeout(err error) bool {
	type timeouter interface{ Timeout() bool }
	if te, ok := err.(timeouter); ok && te.Timeout() {
		return true
	}
	return strings.Contains(err.Error(), context.DeadlineExceeded.Error())
}

// formatID renders the numeric stream id fallback the way the TS client
// would (`headers.id || stream.id`, a JSON number).
func formatID(id uint32) json.RawMessage {
	return json.RawMessage(strconv.FormatUint(uint64(id), 10))
}
