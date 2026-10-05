/* eslint-env jest */
/* global device */

// Ignore long-lived subscriptions and unrelated external services so Detox
// synchronization covers app work rather than Internet availability. Apply
// the launch argument before Android idling resources register; re-apply
// after launch because the iOS blacklist is process-scoped.
const URL_BLACKLIST = [
  '.*arkade\\.computer/v1/indexer/script/subscription.*',
  '.*groundcontrol-bluewallet\\.herokuapp\\.com.*',
  '.*api\\.kraken\\.com/0/public/Ticker.*',
];

beforeAll(async () => {
  if (typeof device === 'undefined' || !device?.launchApp) return;

  const originalLaunchApp = device.launchApp.bind(device);
  device.launchApp = async (args = {}) => {
    const result = await originalLaunchApp({
      ...args,
      launchArgs: { ...args.launchArgs, detoxURLBlacklistRegex: URL_BLACKLIST },
    });
    try {
      await device.setURLBlacklist(URL_BLACKLIST);
    } catch (e) {
      console.log('[detox-setup] setURLBlacklist after launchApp failed:', e?.message ?? e);
    }
    return result;
  };

  // Detox auto-launches the app before the first beforeAll; cover that launch too.
  try {
    await device.setURLBlacklist(URL_BLACKLIST);
  } catch (e) {
    console.log('[detox-setup] initial setURLBlacklist failed:', e?.message ?? e);
  }
});
