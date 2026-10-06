# Reproducible Builds

Reproducible builds for BlueWallet. Build the same APK twice and verify they're byte-for-byte identical.

## Requirements

- Docker
- Python `3.12` or higher
- [uv](https://docs.astral.sh/uv/getting-started/installation/) (An extremely fast Python package and project manager, written in Rust - _as per the website_)
- Network access to the pinned Nix inputs, BHWI source and dependency repositories

## Building the APK

```sh
cd reproducible-builds
./build-apk.sh mainnet # default if omitted
./build-apk.sh testnet # separate immutable Testnet4 profile
```

Signed outputs are `reproducible-builds/build/mainnet/BlueWallet-mainnet.apk` and `reproducible-builds/build/testnet/BlueWallet-testnet.apk`. They install as `io.bluewallet.bluewallet.bhwi` (BHWI PoC) and `io.bluewallet.bluewallet.bhwi.testnet4` (BHWI PoC Testnet4), not production BlueWallet, and support only arm64-v8a/x86_64 on API 28+. Both Debug profiles retain the exact label `Bluewallet (bhwi debug)`. The wrapper passes `BITCOIN_BUILD_PROFILE` into Docker; only the selected profile's exported APK is replaced. BuildConfig and native SettingsModule supply `bitcoin` / `testnet4`, never a Metro environment variable. Testnet4 retains test key/address encoding and the BHWI/Jade `testnet` wire family while app-owned bindings use its explicit chain profile. The default backend is the host-probed standard-trust TLS `blackie.c3-soft.com:57010`, verified against Testnet4 genesis; the explorer is `https://mempool.space/testnet4`. Source/build configuration is not proof of Android TLS or physical signing acceptance.

The external selector/output directory remains `testnet`; it maps to internal Gradle flavor `bitcoinTestnet` because AGP reserves names starting with `test`. Docker builds `assembleBitcoinTestnetRelease` and signs `app/build/outputs/apk/bitcoinTestnet/release/app-bitcoinTestnet-release-unsigned.apk` before exporting the logical-profile filename above. Mainnet uses `assembleMainnetRelease` and the unchanged `mainnet` paths.

The Testnet4 source profile replaces Testnet3; no third flavor or migration alias is built. Its new package isolates the previously installed `io.bluewallet.bluewallet.bhwi.testnet` app and its 5,500 Testnet3 sats. Never copy/reset/uninstall that app or treat its balance as Testnet4 funds. Install only the signed new package using `adb -s "$ANDROID_SERIAL" install -r` on an explicitly owned serial; stop on any signer/target mismatch without clearing data.

Docker installs checksum-pinned Nix 2.31.2 and builds the consumer through this project's `flake.lock` (Node 24, JDK 17, SDK/build tools 36, NDK 28.2.13676358). Before the Android build, `scripts/build-bhwi-android.sh` fetches the exact `bhwi-ffi.commit` revision and generates/publishes its versioned AAR in the producer's separate JDK 21/SDK 35 Nix shell. Host `.bhwi-build`, `.bhwi-maven` and direnv caches are excluded from the Docker context; no host AAR or global Maven cache supplies the hardware library.

Set `KEYSTORE_FILE_HEX` and `KEYSTORE_PASSWORD` to sign with your own key. Without them, the existing disposable development key is used; the script verifies the APK signature before exporting it. Never install an unsigned release APK. For the direct Fastlane source-build path, enter `nix develop --max-jobs 1 --cores 2`, run `npm ci` and `BUNDLE_PATH=vendor/bundle bundle install --jobs 2`, then use `bash scripts/build-release-apk.sh [mainnet|testnet]` with those signing variables. On Linux run these consumer commands inside `bluewallet-android` (with `nice -n 10 taskset -c 0,1`); the Docker/Ubuntu filesystem already supplies normal FHS paths. Fastlane defaults to mainnet and emits its exact signed `apk_output_path`, with the selected profile in the filename. The Ruby requirement accepts pinned 3.4.9 and CI's 3.4.10 without changing gem versions.

> [!NOTE]
>  Each build replaces only `build/<profile>/BlueWallet-<profile>.apk`, preserving the other profile. Compare the same profile from the same source revision and inputs; copy the first APK elsewhere before rebuilding that profile.

## Comparing APKs

Use the `apkdiff.py` tool to verify two APKs are identical:

```sh
cd apkdiff
uv run apkdiff.py <first-apk> <second-apk>
```

**Example:**

```sh
uv run apkdiff.py ../build/app-1.apk ../build/app-2.apk
```

**Exit codes:**

- `0` = APKs match (build is _reproducible_)
- `1` = APKs differ
- `2` = File not found or invalid APK

If differences are found, mismatched files are extracted to `apkdiff/mismatches/` for further inspection.

### What `apkdiff` Checks

`apkdiff.py` compares APK files and ignores expected differences:

- App signing metadata (certificates, signatures)
- Bugsnag `BUILD_UUID` values
- Play Store bundle artifacts

It performs byte-by-byte comparison of all other files, with special handling for Android binary formats (manifests, resources). See [`apkdiff/apkdiff.py`](apkdiff/apkdiff.py) for implementation.

<!-- 
TODO:: write tests for apkdiff
## Running Tests

Test the apkdiff tool:

```sh
cd apkdiff
uv run pytest
```

Verbose output:

```sh
uv run pytest -v
```

See [`apkdiff/tests/test_utils.py`](apkdiff/tests/test_utils.py) for test cases. -->
