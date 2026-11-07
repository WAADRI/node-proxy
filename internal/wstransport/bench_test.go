package wstransport

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/WAADRI/node-proxy-go/internal/streammux"
)

// BenchmarkWSLoopbackThroughput pushes 48MB through one stream between two Go
// sessions over a real WebSocket, measuring the mux write path in isolation
// (no TS server in the middle). Run: go test -bench WSLoopback -benchtime 1x
func BenchmarkWSLoopbackThroughput(b *testing.B) {
	up := websocket.Upgrader{}
	serverT := make(chan *Transport, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		serverT <- Wrap(c)
		select {}
	}))
	defer srv.Close()

	clientT0, _, err := websocket.DefaultDialer.Dial("ws"+srv.URL[len("http"):]+"/", nil)
	if err != nil {
		b.Fatal(err)
	}
	clientT := Wrap(clientT0)
	serverT0 := <-serverT

	var received int64
	done := make(chan struct{})
	server := streammux.NewConn(serverT0, streammux.Options{
		OnStream: func(s *streammux.Stream) {
			s.OnData(func(chunk []byte) { received += int64(len(chunk)) })
			s.OnEnd(func() { close(done) })
		},
	})
	client := streammux.NewConn(clientT, streammux.Options{})
	defer func() {
		client.Close()
		server.Close()
	}()

	payload := make([]byte, 48*1024*1024)
	b.ResetTimer()
	st := client.OpenTunnel("bench", 1, streammux.DefaultPriority)
	if st == nil {
		b.Fatal("OpenTunnel nil")
	}
	if !st.SendData(payload, true) {
		b.Fatal("SendData failed")
	}
	select {
	case <-done:
	case <-time.After(60 * time.Second):
		b.Fatal("timeout")
	}
	b.StopTimer()
	if received != int64(len(payload)) {
		b.Fatalf("received %d, want %d", received, len(payload))
	}
	mb := float64(len(payload)) / 1024 / 1024
	b.ReportMetric(mb/b.Elapsed().Seconds(), "MB/s")
	_ = io.Discard
}
