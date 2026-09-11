#!/bin/sh
# =============================================================================
# Container entrypoint for the Node-Proxy client: an out-of-process liveness
# supervisor.
#
# The client writes a beacon file every 10s from a dedicated interval that is
# independent of the connection state, so the beacon means exactly one thing:
# "this process is still running its event loop". A stalled event loop cannot
# keep it fresh, and no in-process watchdog can notice - they all run on the
# very loop that is stuck. Such a stall leaves the node silently offline: TCP
# still up, panel shows disconnected, no logs, no reconnect, manual restart.
#
# Why this runs as PID 1:
#   A process inside a PID namespace can never terminate its own namespace init.
#   `kill -TERM 1` is dropped for a PID 1 that installed no handler, and
#   `kill -KILL 1` is discarded outright (verified on a real container: the
#   signal reports success and the process lives on). Only an ancestor
#   namespace - the Docker daemon - can force it, which is why `docker stop`
#   works and a health check inside the container cannot. So a HEALTHCHECK can
#   never restart a stalled client, whatever it sends.
#   Being the *parent* of the client instead makes it trivial: the supervisor
#   kills its child, the container exits, and the restart policy
#   (restart: always / unless-stopped) starts a fresh one. Make sure the
#   container actually has a restart policy.
#
# Knobs (environment):
#   LIVENESS_FILE            beacon path (default /tmp/node-proxy-liveness)
#   WATCHDOG_STALE_SECONDS   beacon age that counts as stalled (default 180,
#                            0 = disable the watchdog)
#   WATCHDOG_CHECK_SECONDS   how often to check (default 5)
# =============================================================================
set -u

BEACON="${LIVENESS_FILE:-/tmp/node-proxy-liveness}"
STALE="${WATCHDOG_STALE_SECONDS:-180}"
CHECK="${WATCHDOG_CHECK_SECONDS:-5}"

# Fall back to the image's default command when none was given.
if [ "$#" -eq 0 ]; then
  set -- node client.ts
fi

# A beacon left behind by an earlier run in the *same* container (a restart
# reuses the filesystem) would look stalled at once and cause a restart loop.
rm -f "$BEACON" 2>/dev/null || true

"$@" &
child=$!
started=$(date +%s)
echo "[watchdog] supervising pid $child: $*"

stopping=0
forward_stop() {
  stopping=1
  kill -TERM "$child" 2>/dev/null || true
}
trap forward_stop TERM INT

while :; do
  sleep "$CHECK"

  # The client exited on its own: propagate its status so the restart policy
  # behaves exactly as it did when the client was PID 1 itself.
  if ! kill -0 "$child" 2>/dev/null; then
    wait "$child"
    exit $?
  fi

  [ "$stopping" -eq 1 ] && break

  # No beacon yet counts as the beacon age since startup, so a client that never
  # writes one is restarted too instead of being trusted forever.
  last="$(cat "$BEACON" 2>/dev/null)"
  case "$last" in
    '' | *[!0-9]*) last="$started" ;;
  esac
  age=$(( $(date +%s) - last ))

  if [ "$STALE" -gt 0 ] && [ "$age" -gt "$STALE" ]; then
    echo "[watchdog] liveness beacon is ${age}s old (> ${STALE}s): event loop stalled, killing pid $child"
    kill -KILL "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
    exit 1
  fi
done

# Graceful stop: the client has been asked to shut down, so exit with its status.
wait "$child"
exit $?
