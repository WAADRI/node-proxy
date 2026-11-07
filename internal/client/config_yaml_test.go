package client

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeTemp(t *testing.T, content string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestConfigYAMLPrecedence(t *testing.T) {
	yamlFile := writeTemp(t, `
server_url: ws://from-yaml:3000/ws
auth_token: yaml-token
region: yaml-region
tags: yaml,tags
tls_reject_unauthorized: false
`)

	cfg := Default()
	applyYAMLFiles(cfg, []string{yamlFile}, func(string) {})

	if cfg.ServerURL != "ws://from-yaml:3000/ws" {
		t.Fatalf("ServerURL = %s", cfg.ServerURL)
	}
	if cfg.AuthToken != "yaml-token" {
		t.Fatalf("AuthToken = %s", cfg.AuthToken)
	}
	if cfg.Region != "yaml-region" || cfg.Tags != "yaml,tags" {
		t.Fatalf("region/tags = %s/%s", cfg.Region, cfg.Tags)
	}
	if cfg.TLSRejectUnauthorized {
		t.Fatal("tls_reject_unauthorized: false not applied")
	}

	// Env overrides YAML.
	t.Setenv("SERVER_URL", "ws://from-env:3000/ws")
	t.Setenv("AUTH_TOKEN", "env-token")
	if err := applyEnv(cfg); err != nil {
		t.Fatal(err)
	}
	if cfg.ServerURL != "ws://from-env:3000/ws" || cfg.AuthToken != "env-token" {
		t.Fatalf("env did not override yaml: %s / %s", cfg.ServerURL, cfg.AuthToken)
	}
	// Non-overridden keys keep the YAML values.
	if cfg.Region != "yaml-region" {
		t.Fatalf("region = %s", cfg.Region)
	}
}

func TestConfigYAMLFixedKeysWarned(t *testing.T) {
	yamlFile := writeTemp(t, `
server_url: ws://ok:3000/ws
heartbeat_interval: 100
reconnect_delay: 1
`)

	cfg := Default()
	var warnings []string
	applyYAMLFiles(cfg, []string{yamlFile}, func(msg string) { warnings = append(warnings, msg) })

	if len(warnings) != 2 {
		t.Fatalf("warnings = %v, want 2 (fixed keys reported)", warnings)
	}
	for _, w := range warnings {
		if !strings.Contains(w, "ignoring") {
			t.Fatalf("warning text = %s", w)
		}
	}
	// Fixed internals keep their defaults - a config file cannot change them.
	if cfg.HeartbeatInterval != 15*time.Second {
		t.Fatalf("heartbeat = %s", cfg.HeartbeatInterval)
	}
	if cfg.ReconnectDelay != 3*time.Second {
		t.Fatalf("reconnect = %s", cfg.ReconnectDelay)
	}
	if cfg.ServerURL != "ws://ok:3000/ws" {
		t.Fatalf("valid key not applied: %s", cfg.ServerURL)
	}
}

func TestConfigFirstFileWins(t *testing.T) {
	second := writeTemp(t, "server_url: ws://second:3000/ws\n")
	first := writeTemp(t, "server_url: ws://first:3000/ws\n")

	cfg := Default()
	applyYAMLFiles(cfg, []string{filepath.Join(t.TempDir(), "missing.yaml"), first, second}, func(string) {})
	if cfg.ServerURL != "ws://first:3000/ws" {
		t.Fatalf("ServerURL = %s, want first file to win", cfg.ServerURL)
	}
}
