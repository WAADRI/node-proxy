#!/bin/sh
# =============================================================================
# Out-of-process liveness watchdog for the Node-Proxy client (container
# HEALTHCHECK).
#
# client.ts writes $LIVENESS_FILE every 10s from a dedicated interval that is
# independent of the connection state, so the beacon means exactly one thing:
# "this process is still running its event loop". A blocked or stalled loop
# cannot keep it fresh - and that is a failure an in-process watchdog cannot
# detect, because it runs on the very loop that is stuck. It leaves the node
# silently offline: TCP still up, panel shows disconnected, no logs, no
# reconnect, manual restart required.
#
# Docker does not restart a container just because it is unhealthy, so this
# check self-heals: it signals PID 1, the container exits, and the restart
# policy (restart: always / unless-stopped) brings the client back as a fresh
# process. Make sure the container actually has a restart policy.
#
# Knobs (environment):
#   LIVENESS_FILE            beacon path (default /tmp/node-proxy-liveness)
#   WATCHDOG_STALE_SECONDS   age that counts as stalled (default 180, 0 = report
#                            only, never restart)
# =============================================================================
set -u

FILE="${LIVENESS_FILE:-/tmp/node-proxy-liveness}"
STALE="${WATCHDOG_STALE_SECONDS:-180}"

# No beacon yet: the client is still starting up, leave it alone.
[ -f "$FILE" ] || exit 0

LAST="$(cat "$FILE" 2>/dev/null)"
# Unreadable or malformed: never act on a value we cannot trust.
case "$LAST" in
  '' | *[!0-9]*) exit 0 ;;
esac

AGE=$(($(date +%s) - LAST))
[ "$AGE" -le "$STALE" ] && exit 0

if [ "$STALE" -eq 0 ]; then
  echo "liveness beacon is ${AGE}s old (watchdog disabled, not restarting)"
  exit 1
fi

echo "liveness beacon is ${AGE}s old (> ${STALE}s): event loop stalled, restarting client"
kill -TERM 1 2>/dev/null || true
exit 1
