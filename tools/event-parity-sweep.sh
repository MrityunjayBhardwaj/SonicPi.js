#!/bin/bash
# Re-capture every fixture in the event-diff corpus through event-parity.ts so
# the event-diff dashboard (build-event-diff.ts) reflects the CURRENT engine.
# This is the missing pool the compare sweep never ran: build-event-diff reads
# `.captures/eventparity_*.json` (written ONLY by event-parity.ts), NOT the
# compare sweep's `compare_*.md` (SP151). Run it alongside the compare pools and
# event-diff refreshes with the rest.
#
# RESUMABLE / IDEMPOTENT, same contract as official-book-sweep.sh: the headed-
# Chromium capture loop is signal-killed after ~12-17 fixtures, so this
# processes a small BATCH per invocation, prints POOL-SETTLED, and a supervisor
# (full-sweep-run.sh's run_pool, or event-parity-sweep-run.sh) re-launches it
# until every fixture settles. NO `set -e`.
#
# A fixture is SETTLED when EITHER:
#   - it has a fresh eventparity_<TS>_<name>.json newer than this run's epoch, OR
#   - it has been attempted EP_MAX_ATTEMPTS times (a reliable killer gives up).
#
# On the FIRST invocation of a fresh run (stored epoch id != EP_RUN_EPOCH) it
# rebuilds the work manifest via event-parity-prep.ts (latest capture per name
# → temp .rb + duration). Resume invocations reuse the manifest + epoch so prior
# passes' captures keep counting as settled.
#
# Env: EP_RUN_EPOCH (supervisor sets; default now) · EP_MAX_ATTEMPTS (3)
#      EP_TIMEOUT_SEC (140) · EP_RESTART_INTERVAL (6) · EP_BATCH (8)

REPO=/Users/mrityunjaybhardwaj/Documents/projects/sonicPiWeb
cd "$REPO"
WORK="$REPO/.captures/.ep-sweep"
MANIFEST="$WORK/manifest.tsv"
EPOCH_ID_FILE="$WORK/.epoch.id"
EPOCH_FILE="$WORK/.epoch"          # mtime = run start; fresh captures are -newer
STATE_DIR="$WORK/state"
MAX_ATTEMPTS="${EP_MAX_ATTEMPTS:-3}"
TIMEOUT_SEC="${EP_TIMEOUT_SEC:-140}"
RESTART_INTERVAL="${EP_RESTART_INTERVAL:-6}"
BATCH="${EP_BATCH:-8}"
RUN_EPOCH="${EP_RUN_EPOCH:-$(date +%s)}"

mkdir -p "$WORK" "$STATE_DIR"

restart_sonic_pi() {
  echo "  ↻ restarting Sonic Pi.app (SP60 mitigation)..."
  pkill -f "Sonic Pi.app" 2>/dev/null || true
  sleep 1.5
  open -a "Sonic Pi"
  for _ in {1..30}; do
    sleep 0.5
    if pgrep -f "scsynth -u" >/dev/null 2>&1; then
      sleep 2.5
      echo "  ↻ ready"; return 0
    fi
  done
  echo "  ✗ Sonic Pi.app failed to relaunch"; return 1
}

cleanup_capture_orphans() {
  pkill -f "ms-playwright" 2>/dev/null || true
  pkill -f "node .*tsx.*tools/event-parity.ts" 2>/dev/null || true
  pkill -f "node .*tsx.*tools/capture" 2>/dev/null || true
}

# (Re)build the manifest + stamp the epoch ONLY when the run epoch changes (new
# run) or the manifest is missing — so resume passes keep the same epoch and
# earlier captures stay "fresh this run".
STORED=$(cat "$EPOCH_ID_FILE" 2>/dev/null || echo "")
if [ "$STORED" != "$RUN_EPOCH" ] || [ ! -f "$MANIFEST" ]; then
  echo "▶ preparing event-parity manifest (epoch $RUN_EPOCH)…"
  rm -rf "$STATE_DIR"; mkdir -p "$STATE_DIR"
  npx tsx tools/event-parity-prep.ts || { echo "  ✗ prep failed"; echo "POOL-SETTLED event-parity 0 1"; exit 1; }
  echo "$RUN_EPOCH" > "$EPOCH_ID_FILE"
  touch "$EPOCH_FILE"
fi

# Exact-name fresh-capture check (SP151): `[^_]+` matches the underscore-free
# timestamp, so `idm_breakbeat` does NOT match `10_idm_breakbeat`'s file.
fresh_exists() {
  local name="$1"
  find "$REPO/.captures" -maxdepth 1 -name "eventparity_*_${name}.json" -newer "$EPOCH_FILE" 2>/dev/null \
    | grep -Eq "/eventparity_[^_]+_${name}\.json$"
}
attempts_of() { local f="$STATE_DIR/$1.attempts"; [ -f "$f" ] && cat "$f" || echo 0; }
bump_attempts() { local f="$STATE_DIR/$1.attempts"; echo $(( $(attempts_of "$1") + 1 )) > "$f"; }
is_settled() {
  local name="$1"
  fresh_exists "$name" && return 0
  [ "$(attempts_of "$name")" -ge "$MAX_ATTEMPTS" ] && return 0
  return 1
}

n_total=$(grep -c . "$MANIFEST" 2>/dev/null || echo 0)
echo "▶ Event-parity sweep (resumable): $n_total fixtures, ${TIMEOUT_SEC}s timeout, max ${MAX_ATTEMPTS} attempts, RUN_EPOCH=$RUN_EPOCH"

idx=0; processed=0
while IFS=$'\t' read -r name dur rb; do
  [ -z "$name" ] && continue
  idx=$((idx + 1))

  is_settled "$name" && continue

  if [ "$processed" -ge "$BATCH" ]; then
    echo "  ⏸ batch limit ($BATCH) reached — exit cleanly, supervisor re-launches"
    break
  fi
  processed=$((processed + 1))

  if [ $idx -gt 1 ] && [ $((idx % RESTART_INTERVAL)) -eq 1 ]; then
    restart_sonic_pi
  fi
  att=$(( $(attempts_of "$name") + 1 ))
  echo ""
  echo "[$idx/$n_total] $name (attempt $att/$MAX_ATTEMPTS, dur=${dur}ms)"
  bump_attempts "$name"

  npx tsx tools/event-parity.ts --file "$rb" --name "$name" --duration "$dur" \
    > /tmp/ep_sweep.log 2>&1 </dev/null &
  cpid=$!
  waited=0
  while kill -0 "$cpid" 2>/dev/null; do
    sleep 3; waited=$((waited + 3))
    if [ "$waited" -ge "$TIMEOUT_SEC" ]; then
      echo "  ⏱ TIMEOUT ${TIMEOUT_SEC}s — killing event-parity subtree for $name"
      pkill -P "$cpid" 2>/dev/null || true
      kill -9 "$cpid" 2>/dev/null || true
      break
    fi
  done
  wait "$cpid" 2>/dev/null || true
  tail -4 /tmp/ep_sweep.log 2>/dev/null
  cleanup_capture_orphans

  if fresh_exists "$name"; then
    echo "  ✓ fresh eventparity capture for $name"
  else
    echo "  ✗ no fresh capture for $name (attempt $att)"
    restart_sonic_pi || true
  fi
done < "$MANIFEST"

# Settled tally — supervisor parses this to decide whether to re-launch.
n_settled=0
while IFS=$'\t' read -r name dur rb; do
  [ -z "$name" ] && continue
  is_settled "$name" && n_settled=$((n_settled + 1))
done < "$MANIFEST"
echo ""
echo "=== event-parity pass complete ==="
echo "POOL-SETTLED event-parity $n_settled $n_total"
