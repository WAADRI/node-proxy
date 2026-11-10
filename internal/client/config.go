// Package client implements the node-proxy client node: it connects to the
// server's WebSocket endpoint, authenticates with a token over the JSON text
// control plane, then serves TUNNEL_OPEN streams by dialing local targets and
// piping bytes - the same protocol as the TypeScript client in
// WAADRI/node-proxy (client/client.ts).
package client

import (
	"crypto/rand"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Config mirrors client/lib/config-schema.ts: a handful of user settings
// (env-overridable) plus fixed internals that no config can change
// (issue #53 item 4). Defaults match the TS values exactly.
type Config struct {
	ServerURL             string // default ws://127.0.0.1:3000/ws
	AuthToken             string // default node-proxy-default-token
	Region                string
	Tags                  string // comma separated
	TLSRejectUnauthorized bool   // default true
	ClientID              string // CLIENT_ID env > CLIENT_ID_FILE > generated+persisted

	// Fixed internals (TS FIXED schema).
	ReconnectDelay        time.Duration // 3s
	MaxReconnectDelay     time.Duration // 30s
	ReconnectJitter       time.Duration // 1s
	HeartbeatInterval     time.Duration // 15s
	RequestTimeout        time.Duration // 30s
	TunnelTimeout         time.Duration // 12s (must stay under the server's 35s wait)
	MaxConcurrentRequests int           // 100

	// CompressEnabled negotiates zstd payload compression on the mux when
	// the server supports it (Go-only extension). Default on.
	CompressEnabled bool

	// WSTransportWrap optionally wraps the client's WebSocket transport
	// (byte counters in tests / metrics).
	WSTransportWrap func(tr WSTransport) WSTransport
}

// WSTransport is the transport surface the wrap hook sees.
type WSTransport interface {
	ReadMessage() (data []byte, isText bool, err error)
	WriteMessage(data []byte) error
	WriteTextMessage(data []byte) error
	Close() error
}

// Load builds the config with TS precedence: defaults < config.yaml <
// environment (an empty or unparsable env value cannot wipe out a setting).
func Load() (*Config, error) {
	cfg := Default()
	applyYAMLFile(cfg, func(msg string) { fmt.Fprintln(os.Stderr, "[warn] "+msg) })
	if err := applyEnv(cfg); err != nil {
		return nil, err
	}

	id, err := resolveClientID()
	if err != nil {
		return nil, err
	}
	cfg.ClientID = id
	return cfg, nil
}

// Default returns the TS default configuration (fixed internals included).
func Default() *Config {
	return &Config{
		ServerURL:             "ws://127.0.0.1:3000/ws",
		AuthToken:             "node-proxy-default-token",
		TLSRejectUnauthorized: true,
		ReconnectDelay:        3 * time.Second,
		MaxReconnectDelay:     30 * time.Second,
		ReconnectJitter:       1 * time.Second,
		HeartbeatInterval:     15 * time.Second,
		RequestTimeout:        30 * time.Second,
		TunnelTimeout:         12 * time.Second,
		MaxConcurrentRequests: 100,
		CompressEnabled:       true,
	}
}

// applyEnv overlays environment variables onto cfg (highest precedence).
func applyEnv(cfg *Config) error {
	if v := envFirst("SERVER_URL"); v != "" {
		cfg.ServerURL = v
	}
	if v := envFirst("AUTH_TOKEN"); v != "" {
		cfg.AuthToken = v
	}
	if v := envFirst("REGION", "NODE_REGION"); v != "" {
		cfg.Region = v
	}
	if v := envFirst("TAGS"); v != "" {
		cfg.Tags = v
	}
	if v := envFirst("COMPRESS_ENABLED", "NP_COMPRESS_ENABLED"); v != "" {
		cfg.CompressEnabled = strings.EqualFold(v, "true") || v == "1"
	}
	if v := envFirst("TLS_REJECT_UNAUTHORIZED"); v != "" {
		b, err := strconv.ParseBool(strings.ToLower(v))
		if err != nil {
			return fmt.Errorf("invalid TLS_REJECT_UNAUTHORIZED %q: %w", v, err)
		}
		cfg.TLSRejectUnauthorized = b
	}
	return nil
}

func envFirst(keys ...string) string {
	for _, k := range keys {
		if v, ok := os.LookupEnv(k); ok && v != "" {
			return v
		}
	}
	return ""
}

// resolveClientID mirrors the TS priority: CLIENT_ID env > CLIENT_ID_FILE
// (default ~/.node-proxy-client-id) > generated UUID persisted to the file.
func resolveClientID() (string, error) {
	if id := os.Getenv("CLIENT_ID"); id != "" {
		return id, nil
	}
	file := os.Getenv("CLIENT_ID_FILE")
	if file == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			home = "."
		}
		file = filepath.Join(home, ".node-proxy-client-id")
	}
	if data, err := os.ReadFile(file); err == nil {
		if id := strings.TrimSpace(string(data)); id != "" {
			return id, nil
		}
	}
	id, err := newUUID()
	if err != nil {
		return "", fmt.Errorf("generate client id: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		return id, nil // persistence is best-effort; the ID still works this run
	}
	if err := os.WriteFile(file, []byte(id+"\n"), 0o600); err != nil && !errors.Is(err, os.ErrPermission) {
		return id, nil
	}
	return id, nil
}

// newUUID returns a random RFC 4122 v4 UUID string.
func newUUID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}
