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
# Missing/unreadable beacon checks tolerated before acting at all (36 x 5s = 180s). The client
# exits by itself after ~60s of write failures, so this window only covers legacy clients.
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

  # An unreadable beacon is NOT proof of a stalled event loop. The client only stops refreshing it
  # when its own write fails (ELOOP from its O_NOFOLLOW guard, EACCES, ENOSPC, a parent that went
  # away), and substituting $started for a missing value made `age` equal the container's uptime:
  # two real kills were reported as "event loop stalled" at 631s and 63554s while the client was
  # serving tunnels microseconds earlier. Treat missing/unreadable as unknown, say so, and give it a
  # full grace window before acting; the client now exits by itself on persistent write failure,
  # which is attributable instead of a mystery kill.
  last="$(cat "$BEACON" 2>/dev/null)"
  case "$last" in
    '' | *[!0-9]*)
      missing=$((missing + 1))
      if [ "$missing" -eq 1 ] || [ $((missing % 12)) -eq 0 ]; then
        echo "[watchdog] beacon $BEACON unreadable/absent (check #${missing}, content='${last}')"
      fi
      if [ "$missing" -le "$GRACE" ]; then
        continue
      fi
      echo "[watchdog] beacon $BEACON unreadable for ${missing} checks (> ${GRACE}); the client cannot report liveness"
      age=$((missing * CHECK))
      ;;
    *)
      missing=0
      age=$(( $(date +%s) - last ))
      ;;
  esac

  if [ "$STALE" -gt 0 ] && [ "$age" -gt "$STALE" ]; then
    echo "[watchdog] killing pid $child: liveness unconfirmed for ${age}s (beacon='$BEACON' content='${last}', container up $(( $(date +%s) - started ))s)"
    kill -KILL "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
    exit 1
  fi
done

# Graceful stop: the client has been asked to shut down, so exit with its status.
wait "$child"
exit $?
