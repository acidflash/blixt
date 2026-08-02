#!/usr/bin/env bash
set -euo pipefail

LOG_FILE=/data/access.log

usage() {
  echo "Usage: $0 [cat|tail]"
  echo "  cat   skriv ut hela loggen"
  echo "  tail  följ loggen live (tail -f)"
  exit 1
}

mode="${1:-}"

if [ -z "$mode" ]; then
  echo "Vad vill du göra?"
  select choice in "cat (visa hela loggen)" "tail (följ live)"; do
    case "$REPLY" in
      1) mode=cat; break ;;
      2) mode=tail; break ;;
      *) echo "Ogiltigt val" ;;
    esac
  done
fi

case "$mode" in
  cat)  docker compose exec app cat "$LOG_FILE" ;;
  tail) docker compose exec app tail -f "$LOG_FILE" ;;
  *) usage ;;
esac
