#!/usr/bin/env bash
# =============================================================================
# Logic tests for client/healthcheck.sh - the container liveness watchdog.
#
# The watchdog restarts a container when the client's event loop stalls. A false
# positive would bounce a healthy production node, so these tests pin down both
# sides: what counts as healthy, what must never trigger a restart, and that a
# genuinely stalled beacon does signal PID 1.
#
# Requires bash (the destructive path is stubbed with an exported shell function
# because `kill` is a shell builtin and a PATH stub would be ignored).
#
# Usage: bash client/test/healthcheck.test.sh [path/to/healthcheck.sh]
# =============================================================================
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HC="${1:-$SCRIPT_DIR/../healthcheck.sh}"

if [ ! -f "$HC" ]; then
  echo "healthcheck script not found: $HC" >&2
  exit 2
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

export LIVENESS_FILE="$WORK/liveness"
KILL_LOG="$WORK/kill.calls"

fail=0
pass() { echo "PASS  $1"; }
bad() { echo "FAIL  $1"; fail=1; }

# Run the watchdog and compare the exit status.
run() { # expected_exit [env assignment...]
  local want="$1"
  shift
  local out code
  out="$(env "$@" sh "$HC" 2>&1)"
  code=$?
  if [ "$code" -eq "$want" ]; then
    echo "PASS  (exit $code) ${out}"
  else
    echo "FAIL  exit $code, want $want | out: ${out}"
    fail=1
  fi
}

echo "--- no beacon yet: the client is still starting, leave it alone"
rm -f "$LIVENESS_FILE" "$KILL_LOG"
run 0
if [ -f "$KILL_LOG" ]; then bad "acted on a missing beacon"; else pass "no action on missing beacon"; fi

echo "--- fresh beacon: healthy"
date +%s > "$LIVENESS_FILE"
run 0

echo "--- malformed beacon: never act on a value we cannot trust"
echo "not-a-number" > "$LIVENESS_FILE"
rm -f "$KILL_LOG"
run 0
if [ -f "$KILL_LOG" ]; then bad "acted on a malformed beacon"; else pass "no action on malformed beacon"; fi

echo "--- empty beacon: treated as unknown"
: > "$LIVENESS_FILE"
run 0

echo "--- stale beacon: signal PID 1 so the restart policy brings it back"
echo "$(( $(date +%s) - 300 ))" > "$LIVENESS_FILE"
rm -f "$KILL_LOG"
# The stub reads its log path from an exported variable: inside the function $1
# is the function's own argument (-TERM), not the script's.
export KILL_STUB_LOG="$KILL_LOG"
out=$(bash -c '
  kill() { echo "kill $*" >> "$KILL_STUB_LOG"; return 0; }
  export -f kill
  sh "$1"
' _ "$HC" 2>&1)
code=$?
if [ "$code" -eq 1 ]; then
  echo "PASS  (exit 1) ${out}"
else
  echo "FAIL  exit $code, want 1 | out: ${out}"
  fail=1
fi
if grep -q "TERM 1" "$KILL_LOG" 2>/dev/null; then
  pass "signalled PID 1 ($(cat "$KILL_LOG"))"
else
  bad "did not signal PID 1"
fi

echo "--- stale but disabled: report only, never restart"
rm -f "$KILL_LOG"
run 1 WATCHDOG_STALE_SECONDS=0
if [ -f "$KILL_LOG" ]; then bad "restarted even though the watchdog was disabled"; else pass "no restart when disabled"; fi

echo "--- stale threshold raised above the beacon age: healthy"
run 0 WATCHDOG_STALE_SECONDS=10000

echo "--- age exactly at the threshold is still healthy (boundary is inclusive)"
echo "$(( $(date +%s) - 180 ))" > "$LIVENESS_FILE"
rm -f "$KILL_LOG"
run 0 WATCHDOG_STALE_SECONDS=180
if [ -f "$KILL_LOG" ]; then bad "restarted at the threshold boundary"; else pass "boundary is inclusive"; fi

echo
if [ "$fail" -eq 0 ]; then
  echo "ALL PASS"
else
  echo "SOME FAILED"
fi
exit "$fail"
