#!/bin/bash
#
# Stress an EC2 instance's CPU up to ~95% utilization.
# Works on Amazon Linux 2/2023, Ubuntu, and other major distros.
#
# Usage (run on the target EC2 instance):
#   curl -fsSL https://your-bucket/stress-cpu.en.sh | bash
#   or
#   ./stress-cpu.en.sh                 # default: run for 10 minutes
#   ./stress-cpu.en.sh 5               # run for 5 minutes
#   ./stress-cpu.en.sh 0               # run forever (Ctrl+C to stop)
#
# How it works:
#   - Spawns one stress worker per CPU core
#   - If `stress` is missing, tries to install it automatically
#   - If installation fails, falls back to a pure-bash busy loop
#
# Chinese version: stress-cpu.sh
#

set -e

DURATION_MIN="${1:-10}"
DURATION_SEC=$((DURATION_MIN * 60))
CORES=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 1)

G="\033[0;32m"
Y="\033[1;33m"
R="\033[0;31m"
N="\033[0m"

echo -e "${G}▶ EC2 CPU stress test${N}"
echo "  CPU cores: ${CORES}"
if [ "${DURATION_MIN}" -eq 0 ]; then
  echo "  Duration:  ∞ (Ctrl+C to stop)"
else
  echo "  Duration:  ${DURATION_MIN} minute(s)"
fi
echo

# Graceful shutdown handler
cleanup() {
  echo
  echo -e "${Y}Stop signal received, terminating worker processes...${N}"
  pkill -P $$ 2>/dev/null || true
  echo -e "${G}Stopped${N}"
  exit 0
}
trap cleanup INT TERM

# Detect / install the stress tool
install_stress() {
  if command -v stress >/dev/null 2>&1; then
    return 0
  fi

  echo -e "${Y}stress not found, attempting to install automatically...${N}"

  if command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y stress-ng || sudo dnf install -y stress || return 1
  elif command -v yum >/dev/null 2>&1; then
    sudo amazon-linux-extras enable epel >/dev/null 2>&1 || true
    sudo yum install -y epel-release >/dev/null 2>&1 || true
    sudo yum install -y stress 2>/dev/null || sudo yum install -y stress-ng 2>/dev/null || return 1
  elif command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -y >/dev/null
    sudo apt-get install -y stress 2>/dev/null || sudo apt-get install -y stress-ng 2>/dev/null || return 1
  else
    return 1
  fi

  return 0
}

# Stress test using stress / stress-ng
run_stress() {
  local timeout_arg=""
  if [ "${DURATION_SEC}" -gt 0 ]; then
    timeout_arg="--timeout ${DURATION_SEC}s"
  fi

  if command -v stress >/dev/null 2>&1; then
    echo -e "${G}▶ Using stress on ${CORES} core(s)${N}"
    if [ "${DURATION_SEC}" -gt 0 ]; then
      stress --cpu "${CORES}" --timeout "${DURATION_SEC}s"
    else
      stress --cpu "${CORES}"
    fi
  elif command -v stress-ng >/dev/null 2>&1; then
    echo -e "${G}▶ Using stress-ng on ${CORES} core(s)${N}"
    if [ "${DURATION_SEC}" -gt 0 ]; then
      stress-ng --cpu "${CORES}" --cpu-load 95 --timeout "${DURATION_SEC}s"
    else
      stress-ng --cpu "${CORES}" --cpu-load 95
    fi
  else
    return 1
  fi
}

# Fallback: pure-bash busy loop (no package required)
run_bash_loop() {
  echo -e "${Y}▶ Fallback: spawning ${CORES} pure-bash busy-loop worker(s)${N}"

  for i in $(seq 1 "${CORES}"); do
    (
      # busy loop
      while :; do
        : $((1+1))
      done
    ) &
  done

  if [ "${DURATION_SEC}" -gt 0 ]; then
    echo -e "${G}Started; will auto-stop after ${DURATION_MIN} minute(s)${N}"
    sleep "${DURATION_SEC}"
    pkill -P $$ 2>/dev/null || true
  else
    echo -e "${G}Started; press Ctrl+C to stop${N}"
    wait
  fi
}

# Main flow
if install_stress && run_stress; then
  echo -e "${G}✅ Stress test complete${N}"
else
  echo -e "${Y}stress tool unavailable, falling back to bash loop${N}"
  run_bash_loop
  echo -e "${G}✅ Stress test complete${N}"
fi

echo
echo -e "${G}What to watch:${N}"
echo "  • EC2 console → CPUUtilization metric should approach 95%"
echo "  • Your CPU alarm should transition to ALARM state"
echo "  • The Feishu group should receive an RCA card (about 30 seconds to 2 minutes later)"
