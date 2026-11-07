package streammux

// Transport is the message-oriented link the session runs over. In production
// this is a WebSocket (gorilla/coder adapter); tests use an in-memory pipe.
//
// Semantics required by the mux, matching ws in the TS implementation:
//   - messages are delivered whole (no byte-stream splitting)
//   - WriteMessage blocks until the message is handed off, providing natural
//     backpressure (the TS mux instead polls ws.bufferedAmount; see the
//     writer loop in session.go)
//   - ReadMessage returns message payloads with an isText flag; the session
//     routes text frames to Options.OnText (JSON control plane in the real
//     deployment) and parses only binary frames
//   - a Transport used by a session that calls SendText must also implement
//     TextWriter; the session writer goroutine is the only caller
type Transport interface {
	ReadMessage() (data []byte, isText bool, err error)
	WriteMessage(data []byte) error
	Close() error
}

// TextWriter is the optional text-half of a Transport. Both production
// transports implement it; the session detects it via a type assertion.
type TextWriter interface {
	WriteTextMessage(data []byte) error
}

// Logger is the minimal logging surface the session and client need. Match
// it with zap/zerolog adapters in the CLI layer.
type Logger interface {
	Debugf(format string, args ...any)
	Infof(format string, args ...any)
	Warnf(format string, args ...any)
	Errorf(format string, args ...any)
	Info(message string)
	Warn(message string)
	Error(message string)
}
