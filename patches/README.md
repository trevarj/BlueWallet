# patches

Local patches applied to `node_modules` by [`patch-package`](https://github.com/ds300/patch-package)
on `postinstall` (see `package.json` → `scripts.patches`).

When upstream ships an equivalent fix, drop the patch here and bump the dependency.

---
## `electrum-client+3.1.1.patch`

**What:** lets callers explicitly pass `rejectUnauthorized: true` to the
Electrum client's existing options argument. Omitted and false values retain
the package's legacy trust-all behavior, so existing mainnet callers are
unchanged.

**Why:** version 3.1.1 hardcodes `rejectUnauthorized: false` when constructing
every TLS socket, ignoring its saved constructor options. The immutable
Testnet4 profile must opt into the platform trust store rather than accepting
an arbitrary server certificate.

**Upstream:** [the pinned constructor and TLS socket implementation](https://github.com/BlueWallet/rn-electrum-client/blob/83420b861bac2c0ea343f1d8503104a49e9654a3/lib/client.js)
and the downstream transport's [hostname-verification issue #239](https://github.com/Rapsssito/react-native-tcp-socket/issues/239).
No electrum-client-specific issue has been filed. Remove this patch when the
pinned dependency can forward strict TLS trust without changing its legacy
default.

---

## `react-native-tcp-socket+6.4.2.patch`

**What:** for explicit `rejectUnauthorized: true` Android connections, retains
the originally requested host, layers the platform-default TLS socket over the
connected transport, enables `HTTPS` endpoint identification, and applies
finite connect and TLS-handshake read deadlines. The read timeout is reset to
zero immediately after a successful handshake, before listening for
application data. Both initial TLS and later `startTLS` use the original host
rather than a resolved IP. Writes fail closed while a strict upgrade is in
progress, so application bytes cannot reach the raw socket before trust and
hostname verification complete. Native `destroy` becomes idempotent and
closes the owned socket without waiting behind the connection executor;
queued connection IDs are retired, and queued `end` work captures and checks
its exact owner so it cannot throw after retirement or close a replacement.
The option is also added to the shipped JS/TypeScript TLS declarations. Legacy
false branches retain their existing blind-trust behavior. BlueElectrum
separately enforces one wall-clock deadline over each complete
version/chain/tip handshake.

**Why:** 6.4.2 validates a strict connection's CA chain but does not enable
hostname verification, and its upgrade path substitutes the resolved IP as
the peer identity. It also permits writes to race an asynchronous upgrade and
queues close behind the same bounded executor whose threads may be blocked in
connect/TLS work. The test-network profile therefore could not authenticate the
requested Electrum host, prevent pre-verification plaintext, or promptly cancel stalled
native work.

**Upstream:** [hostname-verification issue #239](https://github.com/Rapsssito/react-native-tcp-socket/issues/239),
[proposed identity fix #240](https://github.com/Rapsssito/react-native-tcp-socket/pull/240),
[idempotent-destroy work #241](https://github.com/Rapsssito/react-native-tcp-socket/pull/241),
[Android client source at 6.4.2](https://github.com/Rapsssito/react-native-tcp-socket/blob/v6.4.2/android/src/main/java/com/asterinet/react/tcpsocket/TcpSocketClient.java),
and Android's [`SSLParameters.setEndpointIdentificationAlgorithm`](https://developer.android.com/reference/javax/net/ssl/SSLParameters#setEndpointIdentificationAlgorithm(java.lang.String)).
Remove this patch when upstream preserves the logical host for standard-trust
endpoint verification and exposes executor-independent cancellation on both
TLS paths.

---


## `react-native-background-fetch+4.4.2.patch`

Uses the package's bundled `TSBackgroundFetch.xcframework`, which includes
Mac Catalyst, instead of the standalone `TSBackgroundFetch` 4.1.x pod, which
only includes iOS device and simulator binaries. Without this patch, Catalyst
builds fail to import `TSBackgroundFetch/TSBackgroundFetch.h`.

Remove when the upstream pod dependency includes a Catalyst slice. When
upgrading, verify the bundled framework still supports all three destinations.

---

## `react-native-notifications+5.2.2.patch`

**What:** rewrites `FcmToken.sendTokenToJS()` (Android) to obtain the
`ReactContext` from `ReactHost` first (bridgeless / New Architecture),
falling back to `ReactInstanceManager` only if that fails — and wraps
both lookups in `try/catch`.

**Why:** under the New Architecture (bridgeless, RN 0.76+) there is no
`ReactInstanceManager`. The stock code calls
`getReactNativeHost().getReactInstanceManager()` first, which throws
`UnsupportedOperationException: ReactInstanceManager.createReactContext
is unsupported` and crashes the app when the FCM push token is
delivered.

**Upstream:** https://github.com/wix/react-native-notifications/issues/1071 (open)

Added in BlueWallet PR https://github.com/BlueWallet/BlueWallet/pull/8424
during a React Native bump. When `react-native-notifications` ships
New-Architecture-safe token delivery, remove those token-delivery hunks
but retain the experimental identity gate below.

**BHWI identity isolation:** also gates `RNNotificationsModule.startFcmIntentService()`
for exactly `io.bluewallet.bluewallet.bhwi` and `io.bluewallet.bluewallet.bhwi.testnet4`.
Without a Firebase client for those experimental IDs, the native module's automatic
app-init refresh would otherwise call `FirebaseMessaging.getInstance().getToken()`
and crash before the JavaScript remote-push guard runs. Local notification posting,
drawer initialization, received/opened events and initial-notification retrieval
remain active; other Android identities and iOS retain their existing behavior.

**Upstream source:** [native initialization and refresh entry](https://github.com/wix/react-native-notifications/blob/aa5a0f3acf31f6f09b8785defc3805c1af1296db/lib/android/app/src/main/java/com/wix/reactnativenotifications/RNNotificationsModule.java),
[explicit token retrieval](https://github.com/wix/react-native-notifications/blob/aa5a0f3acf31f6f09b8785defc3805c1af1296db/lib/android/app/src/main/java/com/wix/reactnativenotifications/fcm/FcmToken.java).
No upstream issue is filed for this app-specific identity gate; retain it while
these experimental IDs have no Firebase configuration.

---

## `react-native-context-menu-view+1.21.0.patch`

**What:** Android-only changes to `ContextMenuView.java`:

- in `dropdownMenuMode`, a single tap opens a `PopupMenu` (new
  `showDropdownMenu()`) instead of the floating `ContextMenu`. The popup is
  anchored to the view rather than to the touch point, the old
  `SDK_INT >= N` guard is gone, icons are shown via `setMenuIconDisplay()`
  plus `setForceShowIcon(true)` on Android Q+, and `onCancel` is still
  emitted on dismiss;
- menu building is shared through a new `populateMenu()`; both it and
  `showDropdownMenu()` return early when `actions` is null;
- actions with a `selected` key are rendered as checkable items
  (`setCheckable` / `setChecked`);
- `onPress` always includes `indexPath` (`[i]` for top-level items,
  `[parentIndex, i]` for submenu items) instead of only for submenus;
- `icon` is read only when the key is present (`action.hasKey("icon")`).
  Defensive only: `getString` already returns null for a missing key and
  `getResourceWithName` tolerates null.

**Why:** the floating `ContextMenu` does not draw checkable/`selected`
items, so toggle entries (e.g. the passphrase switch in the Add Wallet
header menu) showed no state on Android. `components/TooltipMenu.tsx`
resolves the pressed action by `indexPath` (two actions may share the same
title); it already falls back to `[index]` when `indexPath` is missing, so
always sending it only makes Android consistent with iOS and submenus.

**Upstream:** no issue filed yet. The dependency is installed from the
BlueWallet fork (`github:BlueWallet/react-native-context-menu-view`, see
`package.json`), so these changes can be committed to the fork instead —
then drop this patch and bump the pinned commit.

Added in BlueWallet PR https://github.com/BlueWallet/BlueWallet/pull/8867.
When bumping `react-native-context-menu-view`, rename this patch to the new
version and re-confirm the hunks still apply (`npx patch-package`).

---

## `react-native-screens+4.27.0.patch`

**What:** two hunks in `RNSBarButtonItem.mm`:

- `initWithConfig:` also sets `self.accessibilityIdentifier` when the JS
  `identifier` is provided (one line, alongside the existing
  `self.identifier = identifier`);
- `createActionItemFromConfig:` reads `dict[@"identifier"]` and passes it to
  `[UIAction actionWithTitle:image:identifier:handler:]` instead of `nil`, so
  menu actions carry their JS `identifier` too.

**Why:** the iOS 26 glass header builds nav-bar buttons through
`unstable_headerRightItems`. The native `identifier` is not exposed as an
accessibility identifier, so Detox/XCUITest could not target those bar
buttons. Mirroring it onto `accessibilityIdentifier` makes them reachable
from e2e tests.

**Upstream:** no issue filed yet — local accessibility enhancement.

Added in BlueWallet PR https://github.com/BlueWallet/BlueWallet/pull/8508.
When bumping `react-native-screens`, rename this patch to the new version
and re-confirm the hunks still apply (`npx patch-package`).
