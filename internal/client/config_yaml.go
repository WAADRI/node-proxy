package client

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

// yamlKeys are the user-configurable settings (TS SCHEMA). Anything else in
// config.yaml - especially the FIXED internals - is ignored and reported,
// mirroring the TS loader's ignoredHints behavior (issue #53: silently dead
// settings are exactly what made per-node tuning untrustworthy).
var yamlKeys = map[string]string{ // yaml key -> setter
	"server_url":              "server_url",
	"auth_token":              "auth_token",
	"region":                  "region",
	"tags":                    "tags",
	"tls_reject_unauthorized": "tls_reject_unauthorized",
}

// configFilePaths mirrors the TS search order: CONFIG_PATH env, cwd, then
// next to the executable (packaged binaries cannot see the cwd's file in all
// deployment styles, so "beside the exe" is the last resort).
func configFilePaths() []string {
	var paths []string
	if v := os.Getenv("CONFIG_PATH"); v != "" {
		paths = append(paths, v)
	}
	if cwd, err := os.Getwd(); err == nil {
		paths = append(paths, filepath.Join(cwd, "config.yaml"), filepath.Join(cwd, "config.yml"))
	}
	if exe, err := os.Executable(); err == nil {
		paths = append(paths, filepath.Join(filepath.Dir(exe), "config.yaml"))
	}
	return paths
}

// applyYAMLFile reads the first existing config file and applies the
// configurable keys onto cfg. Unknown or fixed keys are reported on stderr,
// matching the TS loader. Missing files are not an error.
func applyYAMLFile(cfg *Config, warn func(string)) {
	applyYAMLFiles(cfg, configFilePaths(), warn)
}

// applyYAMLFiles is the path-injectable core (tests pass explicit files).
func applyYAMLFiles(cfg *Config, paths []string, warn func(string)) {
	for _, cp := range paths {
		data, err := os.ReadFile(cp)
		if err != nil {
			continue // try the next candidate
		}
		var doc map[string]any
		if err := yaml.Unmarshal(data, &doc); err != nil {
			warn(fmt.Sprintf("config file %s is not valid YAML, ignored: %v", cp, err))
			return
		}
		for k, v := range doc {
			applyYAMLKey(cfg, k, v, cp, warn)
		}
		return // first existing file wins
	}
}

func applyYAMLKey(cfg *Config, key string, v any, path string, warn func(string)) {
	setter, known := yamlKeys[key]
	if !known {
		warn(fmt.Sprintf("config file %s: ignoring %q (not configurable - fixed internals cannot be set via config.yaml, see issue #53)", path, key))
		return
	}
	switch setter {
	case "server_url":
		if s, ok := v.(string); ok && s != "" {
			cfg.ServerURL = s
		}
	case "auth_token":
		if s, ok := v.(string); ok && s != "" {
			cfg.AuthToken = s
		}
	case "region":
		if s, ok := v.(string); ok {
			cfg.Region = s
		}
	case "tags":
		if s, ok := v.(string); ok {
			cfg.Tags = s
		}
	case "tls_reject_unauthorized":
		if b, ok := v.(bool); ok {
			cfg.TLSRejectUnauthorized = b
		} else if s, ok := v.(string); ok {
			cfg.TLSRejectUnauthorized = !strings.EqualFold(s, "false")
		}
	}
}
