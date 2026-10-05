#!/usr/bin/env bash
set -euo pipefail

PROFILE=${1:-mainnet}
case "$PROFILE" in
  mainnet|testnet) ;;
  *) echo "Usage: $0 [mainnet|testnet]" >&2; exit 1 ;;
esac
IMAGE_NAME="android-build-env"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT="$REPO_ROOT/reproducible-builds/build/$PROFILE"



log() {
  printf "\n[%s] %s\n" "$(date +'%H:%M:%S')" "$*" >&2
}

mkdir -p "$OUT"
chmod 775 "$OUT"
rm -f "$OUT/BlueWallet-$PROFILE.apk"

log "Building Docker image..."

docker build --platform linux/amd64 -f "$SCRIPT_DIR/Dockerfile" -t "$IMAGE_NAME" "$REPO_ROOT"

log "Running build inside container..."

docker run --platform linux/amd64 --rm \
  -e BITCOIN_BUILD_PROFILE="$PROFILE" \
  -e KEYSTORE_FILE_HEX \
  -e KEYSTORE_PASSWORD \
  -v "$OUT":/build \
  "$IMAGE_NAME" \
  nix develop --no-write-lock-file path:/app -c bash /app/reproducible-builds/inside-docker.sh

log "Signed $PROFILE APK saved in $OUT/BlueWallet-$PROFILE.apk"