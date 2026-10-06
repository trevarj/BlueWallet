# BlueWallet - A Bitcoin & Lightning Wallet

[![GitHub tag](https://img.shields.io/badge/dynamic/json.svg?url=https://raw.githubusercontent.com/BlueWallet/BlueWallet/master/package.json&query=$.version&label=Version)](https://github.com/BlueWallet/BlueWallet)
[![code style: prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg?style=flat-square)](https://github.com/prettier/prettier)
![](https://img.shields.io/github/license/BlueWallet/BlueWallet.svg)

Thin Bitcoin Wallet.
Built with React Native and Electrum.

[![Appstore](https://bluewallet.io/uploads/app-store-badge-blue.svg)](https://itunes.apple.com/us/app/bluewallet-bitcoin-wallet/id1376878040?l=ru&ls=1&mt=8)
[![Playstore](https://bluewallet.io/uploads/play-store-badge-blue.svg)](https://play.google.com/store/apps/details?id=io.bluewallet.bluewallet)

Website: [bluewallet.io](https://bluewallet.io)

Community: [telegram group](https://t.me/bluewallet)

- Private keys never leave your device
- Lightning Network supported
- SegWit-first. Replace-By-Fee support
- Encryption. Plausible deniability
- And many more [features...](https://bluewallet.io/features)

<img src="https://i.imgur.com/hHYJnMj.png" width="100%">

## BUILD & RUN IT

Please refer to the engines field in package.json file for the minimum required versions of Node and npm. It is preferred that you use an even-numbered version of Node as these are LTS versions.

To view the version of Node and npm in your environment, run the following in your console:

```
node --version && npm --version
```

- In your console:

```
git clone --branch trevarj/bhwi-integration https://github.com/trevarj/BlueWallet.git
cd BlueWallet
npm install
```

Please make sure that your console is running the most stable versions of npm and node (even-numbered versions).

- To run on Android:

This branch has two isolated Android profiles: **BHWI PoC** (`mainnet`, `io.bluewallet.bluewallet.bhwi`) and **BHWI PoC Testnet3** (`testnet`, `io.bluewallet.bluewallet.bhwi.testnet`). Both require API 28+ and arm64-v8a or x86_64; the Kotlin namespace, React Native component and private `${applicationId}.provider` are unchanged. Remote push is unavailable for both Android identities; iOS and local notifications are unchanged.

The Android BHWI module supports Ledger, BitBox02, Coldcard, Trezor and KeepKey over their exact USB packet interfaces, Jade over explicitly approved allowlisted USB serial adapters, Specter-DIY over an explicitly approved CDC adapter, and Ledger/Jade over BLE. These are source-supported transport paths, not claims of physical certification. USB host and BLE are optional device features: USB access, Android 12+ Bluetooth scan/connect, and pre-Android 12 scan location permission are requested only when a hardware-wallet action needs them. Disconnecting or backgrounding an owned session cancels its discovery, secure native prompts and transport work; hardware-wallet handles, passphrases and BitBox02 pairing material are not persisted.

Import Wallet can connect through that module and persist a verified singlesig hardware public account as a watch-only wallet. Multisig vault creation uses the same connection screen for BIP48 wrapped/native SegWit public cosigners; neither flow imports private key material. Wallet details can register supported multisig policies, with Ledger policy HMACs kept in Android Keychain, receive addresses can be confirmed directly on the associated device, and associated watch-only wallets can review and sign on-chain PSBTs directly on the device before the existing explicit broadcast step.

The external profile selector remains `testnet`, but its internal Gradle flavor is `bitcoinTestnet`: AGP reserves flavor names starting with `test`. Tasks/modes use `BitcoinTestnet`/`bitcoinTestnet`, and generated APK directories/basenames use `bitcoinTestnet`. Mainnet is unchanged. This internal name does not change the application ID, Testnet3 label, scheme or native `testnet` value.

Install Nix with flakes enabled, then enter the pinned consumer shell (Node 24, JDK 17, SDK/build tools 36 and NDK 28.2.13676358). Android library modules use the same NDK pin rather than AGP's default version:

```sh
nix develop --max-jobs 1 --cores 2
bluewallet-android # Linux only: enter the private build environment
npm ci
bash scripts/build-bhwi-android.sh
```

Outside that environment, the Nix shell normalizes dependency executable shebangs before npm lifecycle commands. Inside it, npm uses `/bin/bash` directly. Neither path modifies host system files or disables install scripts. Native gem builds use pinned Bash through GNU make's `SHELL` override, with libffi and pkg-config supplied by the same shell.
Bundler is pinned to 2.6.9 to match `Gemfile.lock`. The project records narrow native-install-script approvals in `package.json`; no blanket script trust or disabled lifecycle scripts are required.

Build defaults favor desktop responsiveness over throughput: Gradle uses two workers, no parallel projects, a 3 GiB heap/768 MiB metaspace, and in-process Kotlin compilation. CMake, Cargo, Bundler, Make and Metro use two jobs; Node has a 2 GiB old-space limit and two-thread V8/libuv pools; nested JVMs see two processors. The producer applies the same limits, with Nix realization at one job/two cores; both ABIs and provenance checks remain. These limits do not hard-cap total RSS. On Linux, prefix the consumer command below with `nice -n 10 taskset -c CPU_A,CPU_B`, selecting two CPUs from your allowed affinity set.

On Linux, run Android builds inside `bluewallet-android` from that shell, for example `nice -n 10 taskset -c 0,1 bluewallet-android -c 'bash android/gradlew -p android --no-daemon --max-workers=2 --no-parallel :app:assembleMainnetDebug'` (use allowed CPUs if 0/1 are unavailable). Use `:app:assembleBitcoinTestnetDebug` for the other profile. This private FHS environment supplies the shell/loader paths required by AGP Prefab and NDK tools without changing host system paths. Ubuntu CI and Docker already have normal FHS paths and do not need this wrapper.

The producer fetches the exact public source revision in `bhwi-ffi.commit` from canonical `https://github.com/wizardsardine/bhwi-ffi.git`, generates native bindings in its own JDK 21/SDK 35 Nix shell, and publishes `com.wizardsardine:bhwi-ffi-android:0.1.0-bluewallet.d420872fb11f6620d5d60a45ea6fdad1fe74a47b` to ignored `.bhwi-maven`. A temporary consumer-owned Gradle init script outside the clean source checkout overrides only the library's release publication version to `0.1.0-bluewallet.<full-source-SHA>`, leaving upstream files unchanged and avoiding a floating artifact coordinate. The temporary script and source checkout are removed on exit. Gradle resolves this group only there, never from a developer Maven cache or a remote fallback. The consumer producer records source/publication/lock/binding identity and verifies both published AAR ABIs against the generated native inputs; upstream no longer provides a `--provenance` command. Do not copy a sibling checkout's AAR. `.envrc` enables the same shell with direnv.

You will now need to either connect an Android device to your computer or run an emulated Android device using AVD Manager which comes shipped with Android Studio. To run an emulator using AVD Manager:

1. Download and run Android Studio
2. Click on "Open an existing Android Studio Project"
3. Open `build.gradle` file under `BlueWallet/android/` folder
4. Android Studio will take some time to set things up. Once everything is set up, go to `Tools` -> `AVD Manager`.
   - 📝 This option [may take some time to appear in the menu](https://stackoverflow.com/questions/47173708/why-avd-manager-options-are-not-showing-in-android-studio) if you're opening the project in a freshly-installed version of Android Studio.
5. Click on "Create Virtual Device..." and go through the steps to create a virtual device
6. Launch your newly created virtual device by clicking the `Play` button under `Actions` column

Once you connected an Android device or launched an emulator, run this:

```
nice -n 10 taskset -c 0,1 bluewallet-android -c 'npm run android' # Linux, mainnetDebug
nice -n 10 taskset -c 0,1 bluewallet-android -c 'npm run android:testnet' # Linux, bitcoinTestnetDebug
# On macOS, run npm run android / npm run android:testnet directly in the consumer shell.
```

The default command builds and installs mainnet; Testnet3 is an explicit build, not a runtime preference or Metro environment flag. Start Metro with `npm start` in another consumer-shell terminal. App-owned Android links and wallet shortcuts use `bluewallet-bhwi:` / `bluewallet-bhwi-testnet:` and reject the other profile's scheme; iOS retains `bluewallet:`. Bitcoin, Lightning, file/content and legacy `blue:`/`lapp:` handlers remain shared protocols and may offer both installed apps. `android:relaunch`, `android:restart` and `android:uninstall` target mainnet; their `android:testnet:*` counterparts target only Testnet3.

The fixed native `SettingsModule.getConstants().bitcoinNetwork` is `bitcoin` or `testnet` in Debug and Release. `models/bitcoinNetwork.ts` validates it on Android and exports `bitcoinNetwork`, the bitcoinjs `network`, BIP44 `coinType` (0/1), and `genesisHash`; missing/invalid Android configuration throws. iOS/web remain mainnet without reading Android constants. The Testnet3 build owns Testnet3 on-chain wallet data: keys, addresses, descriptors, PSBTs and UR accounts are derived and validated against Testnet3 and cannot be mixed with mainnet wallet material. Its Electrum connection uses standard CA and original-host verification, validates the exact Testnet3 genesis and hash function before accepting a tip, and defaults to `blackie.c3-soft.com:57006` over TLS; its default explorer is `https://blockstream.info/testnet`. Mainnet peers and explorer presets are unchanged. Testnet3 disables Lightning, Ark/Boltz, Payjoin, production push, purchase/redemption, BIP47, Silent Payments, and Android fee/market widgets at their side-effect boundaries; restored service wallets remain visible but unavailable, and test coins are shown only as BTC or sats without fiat values.

Release tasks are `assembleMainnetRelease` / `assembleBitcoinTestnetRelease`, with unsigned APKs at `android/app/build/outputs/apk/<flavor>/release/app-<flavor>-release-unsigned.apk`, where `<flavor>` is `mainnet` or `bitcoinTestnet`. Never install unsigned releases. `bash scripts/build-release-apk.sh [mainnet|testnet]` defaults to mainnet and uses Fastlane's existing signing variables; Fastlane lanes accept `profile:testnet`, map it to the internal flavor, include the external profile in signed filenames, and emit the exact `apk_output_path`. Release CI builds both profiles separately. The source producer and source-qualified Maven coordinate are the same for both.

Detox defaults (`e2e:debug-*`, `e2e:release-*`) explicitly select mainnet and retain the existing mainnet wallet vectors. `e2e:testnet:debug-build` / `e2e:testnet:release-build` build both profiles for a separate side-by-side profile-isolation smoke; their `*-test` and `*-test-device` counterparts run only that smoke, not wallet vectors. It checks app-owned routes and private settings persistence without spending. Run consumer builds through the Linux FHS environment above. `tests/e2e/detox-build-release-apk.sh [mainnet|testnet] [--fastlane]` maps the external profile to its Gradle flavor and signs the exact app and instrumentation APK with one retained `detox.keystore`, without removing the other profile's artifacts. Signed Detox paths are `outputs/apk/<flavor>/release/app-<flavor>-release.apk` and `outputs/apk/androidTest/<flavor>/release/app-<flavor>-release-androidTest.apk` under `android/app/build/`, where `<flavor>` is `mainnet` or `bitcoinTestnet`. `scripts/deeplink-to-emusim.sh [mainnet|testnet]` selects the Android identity/scheme while retaining iOS links; its existing payment examples remain mainnet fixtures.

All four `e2e:testnet:*-test*` commands require `ANDROID_SERIAL=emulator-<port>` acknowledging an explicitly owned, already-running emulator **before Detox starts**. They select that exact serial via an anchored `--device-name`, force `--reuse`, and disable `behavior.init.reinstallApp` in every smoke configuration. Both the normal and `-device` smoke variants attach to the selected emulator, never launch/select an AVD by name or fall back to hardware. An optional `--device-name` must exactly equal `ANDROID_SERIAL`; wildcard/mismatched selectors, configuration overrides and unsupported CLI flags fail before allocation. Do not invoke these smoke configurations directly through Detox.

Preinstall all four matching app/instrumentation APKs on that owned emulator. For Release, first build/sign both profiles with the retained `detox.keystore` using `e2e:release-build` and `e2e:testnet:release-build`; use their exact signed outputs, never unsigned or differently signed APKs. The following runs inside the pinned consumer shell on Linux:

```bash
export ANDROID_SERIAL=emulator-5560 # only an emulator you explicitly own
nice -n 10 taskset -c 0,1 bluewallet-android -c '
  set -e
  adb -s "$ANDROID_SERIAL" install -r android/app/build/outputs/apk/mainnet/release/app-mainnet-release.apk
  adb -s "$ANDROID_SERIAL" install -r android/app/build/outputs/apk/androidTest/mainnet/release/app-mainnet-release-androidTest.apk
  adb -s "$ANDROID_SERIAL" install -r android/app/build/outputs/apk/bitcoinTestnet/release/app-bitcoinTestnet-release.apk
  adb -s "$ANDROID_SERIAL" install -r android/app/build/outputs/apk/androidTest/bitcoinTestnet/release/app-bitcoinTestnet-release-androidTest.apk
'
nice -n 10 taskset -c 0,1 bluewallet-android -c 'npm run e2e:testnet:release-test-device -- --device-name "$ANDROID_SERIAL" --reuse'
```

For Debug, preinstall the corresponding four `debug/app-<flavor>-debug.apk` and `androidTest/<flavor>/debug/app-<flavor>-debug-androidTest.apk` outputs with the same `adb -s "$ANDROID_SERIAL" install -r` contract, run Metro, then use `e2e:testnet:debug-test-device`. Any target mismatch or install/signature error must stop the run; **never uninstall, clear data, or retry on another target**. CI explicitly launches its runner-owned emulator on port 5554, checks the action-provided `ANDROID_SERIAL=emulator-5554`, installs all four restored signed Release APKs with `install -r`, then uses the same guarded entrypoint.

These no-device rejection checks must exit nonzero before Detox allocation (no ADB operation is needed):

```bash
nice -n 10 taskset -c 0,1 env -u ANDROID_SERIAL npm run e2e:testnet:release-test-device
nice -n 10 taskset -c 0,1 env ANDROID_SERIAL=not-an-emulator npm run e2e:testnet:release-test-device
nice -n 10 taskset -c 0,1 env ANDROID_SERIAL=emulator-5560 npm run e2e:testnet:release-test-device -- --device-name '.*'
nice -n 10 taskset -c 0,1 env ANDROID_SERIAL=emulator-5560 npm run e2e:testnet:release-test-device -- --configuration android.mainnet.release.device
```

The in-test non-emulator `device.id` rejection remains independent defense in depth. The smoke never deletes/resets app data, snapshots both existing Clipboard settings before flipping mainnet, and restores the original mainnet setting in `finally`. Owned Electrum links are exercised on a ready app; their native confirmation is canceled before asserting the settings screen, without applying or saving a server.

BrowserStack CI passes `profile:mainnet` / `profile:testnet` to `upload_to_browserstack_and_comment`, validated by the same Fastlane profile helper as builds. Its PR comment header is `### APK Successfully Uploaded to BrowserStack (<profile>)`: replacement deletes only previous comments starting with that profile-specific header. Thus a testnet upload preserves an existing mainnet result and replaces only testnet results (and vice versa), even when the two matrix jobs fetch comments at different times.

- To run on iOS:

```
npx pod-install
npm start
```

In another terminal window within the BlueWallet folder:

```
npx react-native run-ios
```

**To debug BlueWallet on the iOS Simulator, you must choose a Rosetta-compatible iOS Simulator. This can be done by navigating to the Product menu in Xcode, selecting Destination Architectures, and then opting for "Show Both." This action will reveal the simulators that support Rosetta.
**

- To run on macOS using Mac Catalyst:

```
npx pod-install
npm start
```

Open ios/BlueWallet.xcworkspace. Once the project loads, select the scheme/target BlueWallet. Click Run.

## TESTS

```bash
npm run test
```

## LICENSE

MIT

## WANT TO CONTRIBUTE?

Grab an issue from [the backlog](https://github.com/BlueWallet/BlueWallet/issues), try to start or submit a PR, any doubts we will try to guide you. Contributors have a private telegram group, request access by email bluewallet@bluewallet.io

## Translations

We accept translations via [Transifex](https://explore.transifex.com/bluewallet/bluewallet/)

To participate you need to:

1. Sign up to Transifex
2. Find BlueWallet project
3. Send join request
4. After we accept your request you will be able to start translating! That's it!

Please note the values in curly braces should not be translated. These are the names of the variables that will be inserted into the translated string. For example, the original string `"{number} of {total}"` in Russian will be `"{number} из {total}"`.

Transifex automatically creates Pull Request when language reaches 100% translation. We also trigger this by hand before each release, so don't worry if you can't translate everything, every word counts.

### Vocabulary glossaries

[`loc/vocabulary.md`](loc/vocabulary.md) + the per-language files under [`loc/vocabulary/`](loc/vocabulary/) are the canonical glossary of Bitcoin/Lightning terms (Wallet, Vault, Seed, Mnemonic, Passphrase, Multisig, Payment Code, Coin Control, …) and their chosen rendering in each locale, with the reasoning behind each choice and ⚠️ anti-meaning callouts (e.g. Passcode ≠ Password, Change-output ≠ verb "to change"). Use them as ground truth when translating by hand or when feeding `loc/<lang>.json` to an LLM — terminology consistency across screens is the difference between "looks translated" and "is correct for a Bitcoin wallet". When you change a shipped string, update the matching row in the same PR.

## Q&A

Builds automated and tested with BrowserStack

<a href="https://www.browserstack.com/"><img src="https://i.imgur.com/syscHCN.png" width="160px"></a>

Bugs reported via BugSnag

<a href="https://www.bugsnag.com"><img src="https://images.typeform.com/images/QKuaAssrFCq7/image/default" width="160px"></a>

## RESPONSIBLE DISCLOSURE

Found critical bugs/vulnerabilities? Please email them bluewallet@bluewallet.io
Thanks!
