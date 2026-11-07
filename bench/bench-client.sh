#!/usr/bin/env bash
# Measures latency (p50/p95 of 150 small proxied GETs), single-stream
# download throughput (48MB), and the client process RSS.
# Usage: bench-client.sh <label> <target_pid_arg...>
set -eu
LABEL="$1"; shift
PROXY=http://127.0.0.1:8080
RUNS=150
SAMPLES_DIR=$(mktemp -d)

echo "== $LABEL =="

# --- RSS before (idle) ---
for pid in "$@"; do
  WS=$(powershell -NoProfile -Command "[math]::Round((Get-Process -Id $pid -ErrorAction SilentlyContinue).WorkingSet64/1MB,1)" 2>/dev/null || echo "")
  if [ -n "$WS" ]; then echo "rss-idle: ${WS} MB (pid $pid)"; fi
done

# --- latency ---
for i in $(seq 1 $RUNS); do
  curl -s -o /dev/null --max-time 10 --proxy $PROXY -w "%{time_total}\n" http://127.0.0.1:9999/64 >> "$SAMPLES_DIR/lat.txt"
done
python - "$SAMPLES_DIR/lat.txt" << 'PYEOF'
import sys, statistics
xs = sorted(float(l) for l in open(sys.argv[1]) if l.strip())
p = lambda q: xs[min(len(xs)-1, int(len(xs)*q))]
print(f"latency: p50={p(0.50)*1000:.1f}ms p95={p(0.95)*1000:.1f}ms mean={statistics.mean(xs)*1000:.1f}ms n={len(xs)}")
PYEOF

# --- throughput (48MB single connection) ---
T=$(curl -s -o /dev/null --max-time 120 --proxy $PROXY -w "%{time_total}" http://127.0.0.1:9999/48000000)
python -c "print(f'throughput: {48*8/float('$T')/1000:.2f} Gbps ({48/float('$T'):.1f} MB/s, {float('$T'):.2f}s)')"

# --- RSS of client process(es) passed as extra args ---
for pid in "$@"; do
  WS=$(powershell -NoProfile -Command "[math]::Round((Get-Process -Id $pid -ErrorAction SilentlyContinue).WorkingSet64/1MB,1)" 2>/dev/null || echo "")
  if [ -n "$WS" ]; then echo "rss: ${WS} MB (pid $pid)"; fi
done
rm -rf "$SAMPLES_DIR"
