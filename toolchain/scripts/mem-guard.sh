#!/usr/bin/env bash
# Run a command, but stop it if the machine runs short on memory.
#   scripts/mem-guard.sh <command…>
# Stops (SIGTERM to the process group) when free memory falls below MIN_FREE_PCT
# or swap grows by more than MAX_SWAP_GROWTH_MB while the command runs (swap
# already used by other apps doesn't count). Ninja builds can simply be restarted.
set -uo pipefail
MIN_FREE_PCT="${MIN_FREE_PCT:-15}"
MAX_SWAP_GROWTH_MB="${MAX_SWAP_GROWTH_MB:-4096}"
swap_mb() { sysctl -n vm.swapusage | awk '{gsub("M","",$6); print int($6)}'; }
SWAP_START=$(swap_mb)

set -m
"$@" &
PID=$!
while kill -0 "$PID" 2>/dev/null; do
  free=$(memory_pressure -Q 2>/dev/null | awk -F': ' '/free percentage/ {gsub("%","",$2); print $2}')
  growth=$(( $(swap_mb) - SWAP_START ))
  if [[ -n "$free" && "$free" -lt "$MIN_FREE_PCT" ]] || [[ "$growth" -gt "$MAX_SWAP_GROWTH_MB" ]]; then
    echo "mem-guard: stopping (free=${free}% swap grew ${growth}MB)" >&2
    kill -TERM -- -"$PID" 2>/dev/null
    sleep 5
    kill -KILL -- -"$PID" 2>/dev/null
    exit 99
  fi
  sleep 3
done
wait "$PID"
