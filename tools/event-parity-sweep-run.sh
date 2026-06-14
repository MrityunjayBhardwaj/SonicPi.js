#!/bin/bash
# Standalone supervisor for the event-parity pool: re-launch event-parity-sweep.sh
# until every fixture settles (surviving the ~12-17-fixture signal-kill), then
# rebuild the event-diff dashboard. Use this to refresh event-diff WITHOUT
# re-running the expensive compare sweep (compare WAVs are unrelated to
# event-parity captures — SP151).
#
#   FRESH_EP=1 bash tools/event-parity-sweep-run.sh   # new run (re-prep manifest)
#   bash tools/event-parity-sweep-run.sh              # resume after a death
#
# The full compare+event sweep wires this same pool into full-sweep-run.sh, so
# you normally only need THIS script for an event-diff-only refresh.

REPO=/Users/mrityunjaybhardwaj/Documents/projects/sonicPiWeb
cd "$REPO"
WORK="$REPO/.captures/.ep-sweep"
EPOCH_ID_FILE="$WORK/.epoch.id"
LOG="$REPO/.captures/event-parity-sweep.log"
MAX_PASSES="${MAX_PASSES:-40}"
mkdir -p "$WORK"

if [ "${FRESH_EP:-0}" = "1" ] || [ ! -f "$EPOCH_ID_FILE" ]; then
  RUN_EPOCH=$(date +%s)
  rm -f "$EPOCH_ID_FILE"          # force event-parity-sweep.sh to re-prep + stamp
  : > "$LOG"
  echo "EP-SWEEP START (fresh, epoch=$RUN_EPOCH) $(date)" | tee -a "$LOG"
else
  RUN_EPOCH=$(cat "$EPOCH_ID_FILE")
  echo "EP-SWEEP RESUME (epoch=$RUN_EPOCH) $(date)" | tee -a "$LOG"
fi

pass=0 settled=0 total=0
while [ "$pass" -lt "$MAX_PASSES" ]; do
  pass=$((pass + 1))
  echo "EP-PASS #$pass $(date)" | tee -a "$LOG"
  EP_RUN_EPOCH="$RUN_EPOCH" bash tools/event-parity-sweep.sh 2>&1 | tee -a "$LOG"
  line=$(grep "POOL-SETTLED event-parity " "$LOG" | tail -1)
  settled=$(echo "$line" | awk '{print $3}')
  total=$(echo "$line" | awk '{print $4}')
  if [ -n "$settled" ] && [ -n "$total" ] && [ "$settled" -ge "$total" ]; then
    echo "EP-SWEEP DONE ($settled/$total) after $pass passes $(date)" | tee -a "$LOG"
    break
  fi
  echo "EP-SWEEP INCOMPLETE (${settled:-?}/${total:-?}) — relaunch" | tee -a "$LOG"
done

if [ -z "$settled" ] || [ -z "$total" ] || [ "$settled" -lt "$total" ]; then
  echo "EP-SWEEP GAVEUP after $MAX_PASSES passes (${settled:-?}/${total:-?}) $(date)" | tee -a "$LOG"
fi

echo "▶ rebuilding event-diff dashboard…" | tee -a "$LOG"
npx tsx tools/build-event-diff.ts 2>&1 | tee -a "$LOG"
echo "EP-SWEEP+DASHBOARD DONE $(date)" | tee -a "$LOG"
