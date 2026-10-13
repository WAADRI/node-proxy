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

# Validate the two knobs BEFORE use. A typo used to disable the watchdog SILENTLY:
# `[ abc -gt 0 ]` reports an error, the `&&` on that line short-circuits, and the
# supervisor simply never kills a stalled client - self-healing gone, no message.
# `sleep abc` is the other half: it fails immediately, so the loop became a busy
# spin. Fail fast with a clear message instead (issue #123).
case "$STALE" in
  ''|*[!0-9]*)
    echo "[watchdog] WATCHDOG_STALE_SECONDS must be a non-negative integer, got '$WATCHDOG_STALE_SECONDS'" >&2
    exit 1
    ;;
esac
case "$CHECK" in
  ''|*[!0-9]*)
    echo "[watchdog] WATCHDOG_CHECK_SECONDS must be a non-negative integer, got '$WATCHDOG_CHECK_SECONDS'" >&2
    exit 1
    ;;
esac

# Fall back to the image's default command when none was given.
if [ "$#" -eq 0 ]; then
  set -- node client.ts
fi

# Hand the resolved path to the client explicitly: it reads LIVENESS_FILE, and its own default
# goes through os.tmpdir(), which honours TMPDIR - so without this export the two sides can end up
# watching different files.
export LIVENESS_FILE="$BEACON"

# A beacon left behind by an earlier run in the *same* container (a restart
# reuses the filesystem) would look stalled at once and cause a restart loop.
if ! rm -f "$BEACON" 2>/dev/null; then
  echo "[watchdog] warning: could not remove the stale beacon $BEACON (a leftover owned by another user?)"
fi
if [ -e "$BEACON" ]; then
  echo "[watchdog] warning: $BEACON still exists after cleanup: $(ls -l "$BEACON" 2>&1)"
fi

"$@" &
child=$!
started=$(date +%s)
echo "[watchdog] supervising pid $child: $*"

stopping=0
missing=0
seen=0
# Missing/unreadable beacon checks tolerated before acting, but ONLY once a beacon has been readable
# at least once during this run (36 x 5s = 180s). A client that never writes one keeps the original
# contract: it is restarted after STALE seconds instead of being trusted forever.
GRACE=36
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

  # A beacon that WAS readable and then stopped being readable is not proof of a stalled event loop:
  # the client writes it every 10s and only stops on a write failure (ELOOP from its O_NOFOLLOW
  # guard, EACCES, ENOSPC). Substituting $started in that case reported the container's uptime as a
  # "stalled loop" - two real kills said 631s and 63554s while the client was serving tunnels
  # microseconds earlier. Warn, wait out a grace window, and only then act; the kill line keeps the
  # phrase the supervisor's own tests match on, but now prints the beacon content and the container
  # uptime so the real cause is visible. A beacon that was NEVER readable keeps the original
  # behaviour: a client that writes none must still be restarted, not trusted forever.
  last="$(cat "$BEACON" 2>/dev/null)"
  case "$last" in
    '' | *[!0-9]*)
      if [ "$seen" -eq 0 ]; then
        age=$(( $(date +%s) - started ))
        last="(none)"
      else
        missing=$((missing + 1))
        if [ "$missing" -eq 1 ] || [ $((missing % 12)) -eq 0 ]; then
          echo "[watchdog] beacon $BEACON unreadable/absent (check #${missing}, content='${last}')"
        fi
        if [ "$missing" -le "$GRACE" ]; then
          continue
        fi
        age=$((missing * CHECK))
        last="(unreadable for ${missing} checks)"
      fi
      ;;
    *)
      seen=1
      missing=0
      age=$(( $(date +%s) - last ))
      ;;
  esac

  if [ "$STALE" -gt 0 ] && [ "$age" -gt "$STALE" ]; then
    echo "[watchdog] liveness beacon is ${age}s old (> ${STALE}s): event loop stalled, killing pid $child (beacon='$BEACON' content=$last, container up $(( $(date +%s) - started ))s)"
    kill -KILL "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
    exit 1
  fi
done

# Graceful stop: the client has been asked to shut down, so exit with its status.
wait "$child"
exit $?
