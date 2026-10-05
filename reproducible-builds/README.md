# Reproducible Builds

Reproducible builds for BlueWallet. Build the same APK twice and verify they're byte-for-byte identical.

## Requirements

- Docker
- Python `3.12` or higher
- [uv](https://docs.astral.sh/uv/getting-started/installation/) (An extremely fast Python package and project manager, written in Rust - _as per the website_)
- Network access to the pinned Nix inputs, BHWI source and dependency repositories

## Building the APK

```sh
cd reproducible-builds && ./build-apk.sh
```

The signed `Bluewallet-latest.apk` will be saved to `reproducible-builds/build/`. It installs as `io.bluewallet.bluewallet.bhwi` (BlueWallet BHWI PoC), not production BlueWallet, and supports only arm64-v8a/x86_64 on API 28+.

Docker installs checksum-pinned Nix 2.31.2 and builds the consumer through this project's `flake.lock` (Node 24, JDK 17, SDK/build tools 36, NDK 28.2.13676358). Before the Android build, `scripts/build-bhwi-android.sh` fetches the exact `bhwi-ffi.commit` revision and generates/publishes its versioned AAR in the producer's separate JDK 21/SDK 35 Nix shell. Host `.bhwi-build`, `.bhwi-maven` and direnv caches are excluded from the Docker context; no host AAR or global Maven cache supplies the hardware library.

Set `KEYSTORE_FILE_HEX` and `KEYSTORE_PASSWORD` to sign with your own key. Without them, the existing disposable development key is used; the script verifies the APK signature before exporting it. Never install an unsigned release APK. For the direct Fastlane source-build path, enter `nix develop`, run `npm ci` and `BUNDLE_PATH=vendor/bundle bundle install`, then use `bash scripts/build-release-apk.sh` with those signing variables. The Ruby requirement accepts pinned 3.4.9 and CI's 3.4.10 without changing gem versions.

> [!NOTE]
>  `build-apk.sh` clears the `build/` directory before each build. To compare two builds, copy the first APK elsewhere before running the script again.

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
