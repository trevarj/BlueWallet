#!/usr/bin/env bash
set -euo pipefail

umask 022

PROFILE=${BITCOIN_BUILD_PROFILE:-mainnet}
case "$PROFILE" in
  mainnet) FLAVOR=mainnet; VARIANT=Mainnet ;;
  testnet) FLAVOR=bitcoinTestnet; VARIANT=BitcoinTestnet ;;
  *) echo "BITCOIN_BUILD_PROFILE must be mainnet or testnet" >&2; exit 1 ;;
esac
npm config set fetch-timeout 600000
npm config set fetch-retries 5
npm config set fetch-retry-mintimeout 20000
npm config set fetch-retry-maxtimeout 120000

npm ci --omit=dev
bash scripts/build-bhwi-android.sh

cd android
./gradlew --no-daemon --no-build-cache --max-workers=2 --no-parallel "assemble${VARIANT}Release"

APK_UNSIGNED="app/build/outputs/apk/$FLAVOR/release/app-$FLAVOR-release-unsigned.apk"
APK_SIGNED="/tmp/app-$PROFILE-release-signed.apk"
KEYSTORE="/tmp/keystore.jks"

if [ -n "${KEYSTORE_FILE_HEX:-}" ] && [ -n "${KEYSTORE_PASSWORD:-}" ]; then
  printf "%s" "$KEYSTORE_FILE_HEX" | xxd -r -p > "$KEYSTORE"

  apksigner sign \
    --ks "$KEYSTORE" \
    --ks-pass env:KEYSTORE_PASSWORD \
    --key-pass env:KEYSTORE_PASSWORD \
    --deterministic-dsa-signing \
    --out "$APK_SIGNED" \
    "$APK_UNSIGNED"
else
  keytool -genkeypair \
    -keystore "$KEYSTORE" \
    -storepass password \
    -keypass password \
    -alias temp-key \
    -keyalg RSA \
    -keysize 2048 \
    -validity 1 \
    -dname "CN=Temporary,O=Build,C=US"

  apksigner sign \
    --ks "$KEYSTORE" \
    --ks-key-alias temp-key \
    --ks-pass pass:password \
    --key-pass pass:password \
    --deterministic-dsa-signing \
    --out "$APK_SIGNED" \
    "$APK_UNSIGNED"
fi

apksigner verify --verbose "$APK_SIGNED"

cp "$APK_SIGNED" "/build/BlueWallet-$PROFILE.apk"