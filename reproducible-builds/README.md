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
./build-apk.sh testnet # separate immutable Testnet3 profile
```

Signed outputs are `reproducible-builds/build/mainnet/BlueWallet-mainnet.apk` and `reproducible-builds/build/testnet/BlueWallet-testnet.apk`. They install as `io.bluewallet.bluewallet.bhwi` (BHWI PoC) and `io.bluewallet.bluewallet.bhwi.testnet` (BHWI PoC Testnet3), not production BlueWallet, and support only arm64-v8a/x86_64 on API 28+. The wrapper passes `BITCOIN_BUILD_PROFILE` into Docker; only the selected profile's exported APK is replaced. BuildConfig and native SettingsModule supply the fixed chain value, never a Metro environment variable. Testnet wallet, network and service propagation is not included yet; these builds do not establish Testnet3 spending support.

The external selector/output directory remains `testnet`; it maps to internal Gradle flavor `bitcoinTestnet` because AGP reserves names starting with `test`. Docker builds `assembleBitcoinTestnetRelease` and signs `app/build/outputs/apk/bitcoinTestnet/release/app-bitcoinTestnet-release-unsigned.apk` before exporting the logical-profile filename above. Mainnet uses `assembleMainnetRelease` and the unchanged `mainnet` paths.

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
