#!/usr/bin/env bash
set -euo pipefail

profile=${1:-mainnet}
case "$profile" in
  mainnet|testnet) ;;
  *) echo "Usage: $0 [mainnet|testnet]" >&2; exit 1 ;;
esac
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"
exec bundle exec fastlane android build_release_apk "profile:$profile"
