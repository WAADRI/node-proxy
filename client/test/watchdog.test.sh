#!/usr/bin/env bash
# =============================================================================
# Behaviour tests for client/docker-entrypoint.sh - the liveness supervisor that
# runs as PID 1 and restarts the client when its event loop stalls.
#
# These run the real script under `sh` with a fake client, so they work without
# Docker (the container case at the end is skipped when Docker is unavailable
# and exercises busybox ash and real container semantics).
#
# Usage: bash client/test/watchdog.test.sh [path/to/docker-entrypoint.sh]
# =============================================================================
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENTRY="${1:-$SCRIPT_DIR/../docker-entrypoint.sh}"

if [ ! -f "$ENTRY" ]; then
  echo "supervisor script not found: $ENTRY" >&2
  exit 2
fi

WORK="$(mktemp -d)"
sup=""
child_pid_file="$WORK/child.pid"

cleanup() {
  [ -n "$sup" ] && kill -KILL "$sup" 2>/dev/null
  if [ -f "$child_pid_file" ]; then
    kill -KILL "$(cat "$child_pid_file" 2>/dev/null)" 2>/dev/null
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

export LIVENESS_FILE="$WORK/liveness"
export WATCHDOG_CHECK_SECONDS=1

fail=0
pass() { echo "PASS  $1"; }
bad() { echo "FAIL  $1"; fail=1; }

# Start the supervisor in the background with a fake client.
# `start_supervisor <stale seconds> <client command...>`
start_supervisor() {
  stale="$1"
  shift
  rm -f "$child_pid_file" "$WORK/out"
  WATCHDOG_STALE_SECONDS="$stale" sh "$ENTRY" "$@" >"$WORK/out" 2>&1 &
  sup=$!
}

# Wait up to $1 seconds for the supervisor to exit; sets sup_code.
wait_supervisor() {
  local limit="$1" i=0
  sup_code=""
  while [ "$i" -lt "$limit" ]; do
    if ! kill -0 "$sup" 2>/dev/null; then
      wait "$sup"
      sup_code=$?
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  return 1
}

echo "--- a client that keeps its beacon fresh is left alone"
start_supervisor 2 sh -c 'echo $$ > '"$child_pid_file"'; while :; do date +%s > "$LIVENESS_FILE"; sleep 1; done'
sleep 4
if kill -0 "$sup" 2>/dev/null; then
  pass "supervisor still running after 4s"
else
  bad "supervisor exited on a healthy client: $(cat "$WORK/out")"
fi
kill -TERM "$sup" 2>/dev/null
sleep 2
kill -KILL "$sup" 2>/dev/null
wait "$sup" 2>/dev/null
sup=""

echo "--- a stalled client is killed and the supervisor fails so the container restarts"
echo "$(( $(date +%s) - 600 ))" > "$LIVENESS_FILE"
start_supervisor 2 sh -c 'echo $$ > '"$child_pid_file"'; sleep 300'
if wait_supervisor 15; then
  if [ "$sup_code" -ne 0 ]; then
    pass "supervisor exited non-zero (code $sup_code)"
  else
    bad "supervisor exited 0, so the restart policy would not fire"
  fi
else
  bad "supervisor never acted on the stalled client"
fi
if grep -q "event loop stalled" "$WORK/out"; then
  pass "reported the stall: $(grep 'stalled' "$WORK/out")"
else
  bad "no stall report in: $(cat "$WORK/out")"
fi
if [ -f "$child_pid_file" ] && kill -0 "$(cat "$child_pid_file")" 2>/dev/null; then
  bad "stalled client survived"
else
  pass "stalled client was killed"
fi
sup=""

echo "--- a client that never writes a beacon is restarted too"
rm -f "$LIVENESS_FILE"
start_supervisor 2 sh -c 'echo $$ > '"$child_pid_file"'; sleep 300'
if wait_supervisor 15; then
  if [ "$sup_code" -ne 0 ]; then
    pass "supervisor exited non-zero (code $sup_code)"
  else
    bad "supervisor exited 0 for a client that never reported"
  fi
else
  bad "a client that never writes a beacon was trusted forever"
fi
sup=""

echo "--- a leftover beacon from an earlier run must not cause a restart loop"
echo "$(( $(date +%s) - 600 ))" > "$LIVENESS_FILE"
start_supervisor 2 sh -c 'echo $$ > '"$child_pid_file"'; while :; do date +%s > "$LIVENESS_FILE"; sleep 1; done'
sleep 4
if kill -0 "$sup" 2>/dev/null; then
  pass "fresh client survived a stale beacon from a previous run"
else
  bad "stale leftover beacon caused a restart loop: $(cat "$WORK/out")"
fi
kill -TERM "$sup" 2>/dev/null
sleep 2
kill -KILL "$sup" 2>/dev/null
wait "$sup" 2>/dev/null
sup=""

echo "--- WATCHDOG_STALE_SECONDS=0 disables the watchdog"
echo "$(( $(date +%s) - 600 ))" > "$LIVENESS_FILE"
start_supervisor 0 sh -c 'echo $$ > '"$child_pid_file"'; sleep 300'
sleep 4
if kill -0 "$sup" 2>/dev/null; then
  pass "stalled client left alone while disabled"
else
  bad "watchdog acted although disabled: $(cat "$WORK/out")"
fi
kill -TERM "$sup" 2>/dev/null
sleep 2
kill -KILL "$sup" 2>/dev/null
wait "$sup" 2>/dev/null
sup=""

echo "--- a client that exits on its own keeps its exit status"
start_supervisor 300 sh -c 'exit 7'
if wait_supervisor 10; then
  if [ "$sup_code" -eq 7 ]; then
    pass "propagated the client's exit status (7)"
  else
    bad "exit status $sup_code, want 7"
  fi
else
  bad "supervisor did not follow the client out"
fi
sup=""

echo "--- stopping the container is forwarded to the client (graceful shutdown)"
start_supervisor 300 sh -c 'echo $$ > '"$child_pid_file"'; trap "exit 0" TERM; while :; do date +%s > "$LIVENESS_FILE"; sleep 1; done'
sleep 2
kill -TERM "$sup"
if wait_supervisor 10; then
  if [ "$sup_code" -eq 0 ]; then
    pass "clean stop (exit 0)"
  else
    bad "stop exit status $sup_code, want 0"
  fi
else
  bad "supervisor ignored the stop signal"
fi
sup=""

echo "--- end to end in a real container (busybox ash, real PID 1)"
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  if ! docker pull alpine >/dev/null 2>&1; then
    echo "SKIP  cannot pull the alpine image"
  else
    ctx="$(cd "$SCRIPT_DIR/.." && pwd)"
    e2e_out=$(docker run --rm \
      -e LIVENESS_FILE=/tmp/liveness \
      -e WATCHDOG_STALE_SECONDS=2 \
      -e WATCHDOG_CHECK_SECONDS=1 \
      -v "$ctx:/app:ro" \
      alpine sh /app/docker-entrypoint.sh \
      sh -c 'echo $(( $(date +%s) - 600 )) > /tmp/liveness; sleep 300' 2>&1)
    e2e_code=$?
    case "$e2e_out" in
      *"event loop stalled"*) pass "container reported the stall" ;;
      *) bad "no stall report: ${e2e_out}" ;;
    esac
    if [ "$e2e_code" -ne 0 ]; then
      pass "container exited non-zero (code $e2e_code) so the restart policy fires"
    else
      bad "container exited 0, so nothing would have restarted"
    fi
  fi
else
  echo "SKIP  docker not available"
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "ALL PASS"
else
  echo "SOME FAILED"
fi
exit "$fail"
