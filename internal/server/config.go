// Package server is the Go rewrite of the node-proxy server data plane:
// client registration over WebSocket (JSON control plane + StreamMux), and
// the HTTP / SOCKS5 proxy ports that dispatch work to client nodes.
//
// This is the first strangler step: the data plane. The panel API ships as a
// minimal subset (login + status); ACL / cache / domain routing / bandwidth /
// metrics / ACME follow the OpenAPI contract in later steps.
package server

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// Config is the server configuration subset the data plane needs. Key names
// match server/config.yaml. Fixed TS defaults apply.
type Config struct {
	Host             string
	WebPort          int
	HTTPProxyPort    int
	SOCKS5Port       int
	TrustedProxyHops int

	AuthToken string
	Web       WebAuth
	Proxy     ProxyAuth

	RequestTimeout time.Duration // client.request_timeout, default 30s
	TunnelTimeout  time.Duration // client.tunnel_timeout, default 35s (must stay above the node's 12s)
	MaxConcurrent  int           // per-node default cap (panel-adjustable later)

	ACME ACMEConfig
}

type WebAuth struct {
	Enabled  bool
	Username string
	Password string
}

type ProxyAuth struct {
	Enabled  bool
	Username string
	Password string
}

// Default returns TS defaults.
func Default() *Config {
	return &Config{
		Host:           "0.0.0.0",
		WebPort:        3000,
		HTTPProxyPort:  8080,
		SOCKS5Port:     1080,
		AuthToken:      "node-proxy-default-token",
		Web:            WebAuth{Enabled: true, Username: "admin", Password: "admin-password"},
		RequestTimeout: 30 * time.Second,
		TunnelTimeout:  35 * time.Second,
		MaxConcurrent:  100,
	}
}

// Load reads config file paths (CONFIG_PATH, ./config.yaml, ./config.yml,
// with a config.local.yaml overlay next to the main file - TS semantics) and
// then NP_ environment variables.
func Load() (*Config, error) {
	cfg := Default()
	main := findConfigFile()
	if main != "" {
		if err := applyYAML(cfg, main); err != nil {
			return nil, err
		}
		local := overlayPath(main)
		if local != "" {
			// Missing overlay is fine; a broken one must not be silent.
			if _, err := os.Stat(local); err == nil {
				if err := applyYAML(cfg, local); err != nil {
					return nil, err
				}
			}
		}
	}
	applyEnv(cfg)

	if cfg.AuthToken == "node-proxy-default-token" {
		// Same guard as server.ts: the shipped default is public knowledge.
		if os.Getenv("ALLOW_DEFAULT_TOKEN") != "1" {
			return nil, fmt.Errorf("auth.token is still the shipped default; set auth.token or NP_AUTH_TOKEN (ALLOW_DEFAULT_TOKEN=1 overrides for throwaway setups)")
		}
	}
	return cfg, nil
}

func findConfigFile() string {
	for _, p := range []string{os.Getenv("CONFIG_PATH"), "config.yaml", "config.yml"} {
		if p == "" {
			continue
		}
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

// overlayPath mirrors TS: config.local.yaml lives next to the main config.
func overlayPath(main string) string {
	dir := "."
	if i := lastSep(main); i >= 0 {
		dir = main[:i]
	}
	return dir + string(os.PathSeparator) + "config.local.yaml"
}

func lastSep(p string) int {
	for i := len(p) - 1; i >= 0; i-- {
		if p[i] == '/' || p[i] == '\\' {
			return i
		}
	}
	return -1
}

func applyYAML(cfg *Config, path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var doc map[string]any
	if err := yaml.Unmarshal(data, &doc); err != nil {
		return fmt.Errorf("config %s: %w", path, err)
	}
	server_, _ := doc["server"].(map[string]any)
	auth, _ := doc["auth"].(map[string]any)
	client_, _ := doc["client"].(map[string]any)

	if server_ != nil {
		str(cfg, server_, "host", &cfg.Host)
		int_(cfg, server_, "web_port", &cfg.WebPort)
		int_(cfg, server_, "http_proxy_port", &cfg.HTTPProxyPort)
		int_(cfg, server_, "socks5_port", &cfg.SOCKS5Port)
		int_(cfg, server_, "trusted_proxy_hops", &cfg.TrustedProxyHops)
	}
	if auth != nil {
		str(cfg, auth, "token", &cfg.AuthToken)
		if web, ok := auth["web"].(map[string]any); ok {
			str(cfg, web, "username", &cfg.Web.Username)
			str(cfg, web, "password", &cfg.Web.Password)
			if b, ok := web["enabled"].(bool); ok {
				cfg.Web.Enabled = b
			}
		}
		if proxy, ok := auth["proxy"].(map[string]any); ok {
			str(cfg, proxy, "username", &cfg.Proxy.Username)
			str(cfg, proxy, "password", &cfg.Proxy.Password)
			if b, ok := proxy["enabled"].(bool); ok {
				cfg.Proxy.Enabled = b
			}
		}
	}
	if client_ != nil {
		ms(cfg, client_, "request_timeout", &cfg.RequestTimeout)
		ms(cfg, client_, "tunnel_timeout", &cfg.TunnelTimeout)
		int_(cfg, client_, "max_concurrent_requests", &cfg.MaxConcurrent)
	}
	if acmeS, ok := doc["acme"].(map[string]any); ok {
		if b, ok := acmeS["enabled"].(bool); ok {
			cfg.ACME.Enabled = b
		}
		if s, ok := acmeS["email"].(string); ok {
			cfg.ACME.Email = s
		}
		if b, ok := acmeS["staging"].(bool); ok {
			cfg.ACME.Staging = b
		}
		if arr, ok := acmeS["domains"].([]any); ok {
			for _, d := range arr {
				if s, ok := d.(string); ok && strings.TrimSpace(s) != "" {
					cfg.ACME.Domains = append(cfg.ACME.Domains, s)
				}
			}
		}
	}
	return nil
}

// applyEnv overlays NP_ variables. Deliberate divergence from the TS loader,
// which splits the remainder on underscores and therefore cannot address
// multi-word keys (client.max_concurrent is unreachable via env there); the
// mapping here is explicit, so every key below is settable.
func applyEnv(cfg *Config) {
	if v := os.Getenv("NP_AUTH_TOKEN"); v != "" {
		cfg.AuthToken = v
	}
	if v := os.Getenv("NP_AUTH_WEB_USERNAME"); v != "" {
		cfg.Web.Username = v
	}
	if v := os.Getenv("NP_AUTH_WEB_PASSWORD"); v != "" {
		cfg.Web.Password = v
	}
	if v := os.Getenv("NP_AUTH_PROXY_ENABLED"); v != "" {
		cfg.Proxy.Enabled = v == "true" || v == "1"
	}
	if v := os.Getenv("NP_AUTH_PROXY_USERNAME"); v != "" {
		cfg.Proxy.Username = v
	}
	if v := os.Getenv("NP_AUTH_PROXY_PASSWORD"); v != "" {
		cfg.Proxy.Password = v
	}
	if v := os.Getenv("NP_WEB_PORT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.WebPort = n
		}
	}
	if v := os.Getenv("NP_HTTP_PROXY_PORT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.HTTPProxyPort = n
		}
	}
	if v := os.Getenv("NP_SOCKS5_PORT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.SOCKS5Port = n
		}
	}
	if v := os.Getenv("NP_ACME_EMAIL"); v != "" {
		cfg.ACME.Email = v
	}
	if v := os.Getenv("NP_ACME_DOMAINS"); v != "" {
		cfg.ACME.Enabled = true
		for _, d := range strings.Split(v, ",") {
			if d = strings.TrimSpace(d); d != "" {
				cfg.ACME.Domains = append(cfg.ACME.Domains, d)
			}
		}
	}
	if v := os.Getenv("NP_ACME_STAGING"); v == "1" || v == "true" {
		cfg.ACME.Staging = true
	}
}

func str(_ *Config, m map[string]any, key string, dst *string) {
	if v, ok := m[key].(string); ok && v != "" {
		*dst = v
	}
}

func int_(_ *Config, m map[string]any, key string, dst *int) {
	if v, ok := m[key].(int); ok {
		*dst = v
	} else if v, ok := m[key].(float64); ok {
		*dst = int(v)
	}
}

func ms(_ *Config, m map[string]any, key string, dst *time.Duration) {
	if v, ok := m[key].(int); ok {
		*dst = time.Duration(v) * time.Millisecond
	} else if v, ok := m[key].(float64); ok {
		*dst = time.Duration(v) * time.Millisecond
	}
}
