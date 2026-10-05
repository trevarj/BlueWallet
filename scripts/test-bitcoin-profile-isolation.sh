#!/usr/bin/env bash
set -euo pipefail

# Require ownership acknowledgement before Detox can allocate or touch any device.
[[ ${ANDROID_SERIAL:-} =~ ^emulator-[0-9]+$ ]] || {
  echo 'Set ANDROID_SERIAL to the exact serial of an owned emulator (emulator-<port>).' >&2
  exit 1
}
configuration=${1:-}
case "$configuration" in
  android.testnet.debug|android.testnet.debug.device|android.testnet.release|android.testnet.release.device) ;;
  *) echo 'Expected an android.testnet debug/release smoke configuration.' >&2; exit 1 ;;
esac
shift

# Only observational/test-run options may pass through; config/device overrides must never reach Detox.
args=()
while (( $# )); do
  case "$1" in
    --device-name)
      [[ ${2:-} == "$ANDROID_SERIAL" ]] || { echo '--device-name must equal ANDROID_SERIAL.' >&2; exit 1; }
      shift 2 ;;
    --reuse|--headless)
      # Already-running attached emulators need no launcher options; reuse is forced below.
      shift ;;
    --runInBand)
      args+=("$1"); shift ;;
    -d|--debug-synchronization|--loglevel|--record-videos|--record-logs|--take-screenshots|--retries|--artifacts-location|--testNamePattern)
      [[ $# -ge 2 && $2 != -* ]] || { echo "Missing value for $1." >&2; exit 1; }
      args+=("$1" "$2"); shift 2 ;;
    *) echo "Unsupported profile-smoke option: $1" >&2; exit 1 ;;
  esac
done

exec ./node_modules/.bin/detox test "${args[@]}" --config-path ./.detoxrc.json \
  --configuration "$configuration" --device-name "^${ANDROID_SERIAL}$" --reuse
