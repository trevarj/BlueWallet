#!/usr/bin/env bash
# script thats used to build & sign release APK in preparation for Detox e2e testing.
# Usage: ./tests/e2e/detox-build-release-apk.sh [mainnet|testnet] [--fastlane]

set -euo pipefail

PROFILE=mainnet
USE_FASTLANE=${USE_FASTLANE:-0}
for argument in "$@"; do
	case "$argument" in
		mainnet|testnet) PROFILE=$argument ;;
		--fastlane) USE_FASTLANE=1 ;;
		*) echo "Usage: $0 [mainnet|testnet] [--fastlane]" >&2; exit 1 ;;
	esac
done
case "$PROFILE" in
	mainnet) FLAVOR=mainnet; VARIANT=Mainnet ;;
	testnet) FLAVOR=bitcoinTestnet; VARIANT=BitcoinTestnet ;;
esac
ARCHITECTURES=${E2E_ANDROID_ARCHS:-x86_64}
case "$ARCHITECTURES" in
	arm64-v8a|x86_64|arm64-v8a,x86_64|x86_64,arm64-v8a) ;;
	*) echo "E2E_ANDROID_ARCHS must contain only arm64-v8a and x86_64" >&2; exit 1 ;;
esac
export E2E_ANDROID_ARCHS=$ARCHITECTURES
RELEASE_APK="android/app/build/outputs/apk/$FLAVOR/release/app-$FLAVOR-release.apk"
TEST_APK="android/app/build/outputs/apk/androidTest/$FLAVOR/release/app-$FLAVOR-release-androidTest.apk"

# Retain one key across profiles; never remove another profile's APKs or rotate its test signer.
if [[ ! -f detox.keystore ]]; then
	keytool -genkeypair -v -keystore detox.keystore -alias detox -keyalg RSA -keysize 2048 -validity 10000 -storepass 123456 -keypass 123456 -dname 'cn=Unknown, ou=Unknown, o=Unknown, c=Unknown'
fi
npm run patches

if [[ "$USE_FASTLANE" == "1" ]]; then
	output_file=$(mktemp)
	trap 'rm -f "$output_file"' EXIT
	KEYSTORE_FILE_HEX=$(xxd -p detox.keystore | tr -d '\n') KEYSTORE_PASSWORD=123456 \
		GITHUB_OUTPUT="$output_file" bundle exec fastlane android build_release_apk "profile:$PROFILE"
	signed_apk=
	while IFS='=' read -r key value; do
		[[ "$key" != apk_output_path ]] || signed_apk=$value
	done < "$output_file"
	[[ -n "$signed_apk" && -f "$signed_apk" ]] || { echo "Fastlane did not emit an APK path" >&2; exit 1; }
	cp "$signed_apk" "$RELEASE_APK"
	(cd android && ./gradlew "assemble${VARIANT}ReleaseAndroidTest" -DtestBuildType=release "-PreactNativeArchitectures=$ARCHITECTURES")
else
	bash scripts/build-bhwi-android.sh
	(cd android && ./gradlew "assemble${VARIANT}Release" "assemble${VARIANT}ReleaseAndroidTest" -DtestBuildType=release "-PreactNativeArchitectures=$ARCHITECTURES")
	cp "android/app/build/outputs/apk/$FLAVOR/release/app-$FLAVOR-release-unsigned.apk" "$RELEASE_APK"
fi

# signing both APKs with the same keystore so they can be installed together (pick latest available apksigner)
ANDROID_SDK_ROOT=${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}
if [[ -z "$ANDROID_SDK_ROOT" ]]; then
	echo "ANDROID_HOME or ANDROID_SDK_ROOT must be set" >&2
	exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
	echo "python3 is required to locate apksigner" >&2
	exit 1
fi

APKSIGNER_BIN=$(python3 - "$ANDROID_SDK_ROOT" <<'PY'
import pathlib
import sys

sdk_root = pathlib.Path(sys.argv[1])
build_tools = sdk_root / "build-tools"

def version_key(path: pathlib.Path):
	# split version components so 34.0.0 < 35.0.0 < 36.0.0
	parts = []
	for part in path.parent.name.split('.'):
		parts.append(int(part) if part.isdigit() else part)
	return parts

candidates = sorted(build_tools.glob('*/apksigner'), key=version_key)
if not candidates:
	raise SystemExit(f"apksigner not found under {build_tools}")

print(candidates[-1])
PY
)

if [[ ! -x "$APKSIGNER_BIN" ]]; then
	echo "apksigner not found or not executable at $APKSIGNER_BIN" >&2
	exit 1
fi

"$APKSIGNER_BIN" sign --ks detox.keystore --ks-pass=pass:123456 "$RELEASE_APK"
"$APKSIGNER_BIN" sign --ks detox.keystore --ks-pass=pass:123456 "$TEST_APK"
"$APKSIGNER_BIN" verify "$RELEASE_APK"
"$APKSIGNER_BIN" verify "$TEST_APK"
