// Package panel carries the built Vue panel (dist/) into the server binary
// via go:embed, so a single node-proxy-server file serves the whole UI.
// Rebuild with: cd panel && npm ci && npm run build
package panel

import "embed"

//go:embed all:dist
var Dist embed.FS

//go:embed views/login.html
var LoginHTML []byte

//go:embed public/login.js
var LoginJS []byte
