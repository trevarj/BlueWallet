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

* Private keys never leave your device
* Lightning Network supported
* SegWit-first. Replace-By-Fee support
* Encryption. Plausible deniability
* And many more [features...](https://bluewallet.io/features)


<img src="https://i.imgur.com/hHYJnMj.png" width="100%">


## BUILD & RUN IT

Please refer to the engines field in package.json file for the minimum required versions of Node and npm. It is preferred that you use an even-numbered version of Node as these are LTS versions.

To view the version of Node and npm in your environment, run the following in your console:

```
node --version && npm --version
```

* In your console:

```
git clone --branch trevarj/bhwi-integration https://github.com/trevarj/BlueWallet.git
cd BlueWallet
npm install
```

Please make sure that your console is running the most stable versions of npm and node (even-numbered versions).

* To run on Android:

This branch installs **BlueWallet BHWI PoC** as `io.bluewallet.bluewallet.bhwi`, separately from production BlueWallet. Android requires API 28+ and arm64-v8a or x86_64; the Kotlin namespace and React Native component are unchanged. Remote push is unavailable for this Android identity; iOS and local notifications are unchanged.

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

On Linux, run Android builds inside `bluewallet-android` from that shell, for example `nice -n 10 taskset -c CPU_A,CPU_B bluewallet-android -c 'bash android/gradlew -p android --no-daemon --max-workers=2 --no-parallel :app:assembleDebug'`. This private FHS environment supplies the shell/loader paths required by AGP Prefab and NDK tools without changing host system paths.

The producer fetches the exact public source revision in `bhwi-ffi.commit` from canonical `https://github.com/wizardsardine/bhwi-ffi.git`, generates native bindings in its own JDK 21/SDK 35 Nix shell, and publishes `com.wizardsardine:bhwi-ffi-android:0.1.0-bluewallet.d420872fb11f6620d5d60a45ea6fdad1fe74a47b` to ignored `.bhwi-maven`. A temporary consumer-owned Gradle init script outside the clean source checkout overrides only the library's release publication version to `0.1.0-bluewallet.<full-source-SHA>`, leaving upstream files unchanged and avoiding a floating artifact coordinate. The temporary script and source checkout are removed on exit. Gradle resolves this group only there, never from a developer Maven cache or a remote fallback. The consumer producer records source/publication/lock/binding identity and verifies both published AAR ABIs against the generated native inputs; upstream no longer provides a `--provenance` command. Do not copy a sibling checkout's AAR. `.envrc` enables the same shell with direnv.

You will now need to either connect an Android device to your computer or run an emulated Android device using AVD Manager which comes shipped with Android Studio. To run an emulator using AVD Manager:

1. Download and run Android Studio
2. Click on "Open an existing Android Studio Project"
3. Open `build.gradle` file under `BlueWallet/android/` folder
4. Android Studio will take some time to set things up. Once everything is set up, go to `Tools` -> `AVD Manager`.
    * 📝 This option [may take some time to appear in the menu](https://stackoverflow.com/questions/47173708/why-avd-manager-options-are-not-showing-in-android-studio) if you're opening the project in a freshly-installed version of Android Studio.
5. Click on "Create Virtual Device..." and go through the steps to create a virtual device
6. Launch your newly created virtual device by clicking the `Play` button under `Actions` column

Once you connected an Android device or launched an emulator, run this:

```
bluewallet-android -c 'npm run android' # Linux; use npm run android directly on macOS
```

The above command builds and installs only the experimental app. Start Metro with `npm start` in another consumer-shell terminal. App-owned Android links and wallet shortcuts use `bluewallet-bhwi:`; iOS retains `bluewallet:`. Bitcoin, Lightning, file/content and legacy `blue:`/`lapp:` handlers remain shared protocols and may offer both installed apps. `android:relaunch`, `android:restart` and `android:uninstall` target only the PoC identity.

* To run on iOS:

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

* To run on macOS using Mac Catalyst:

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
