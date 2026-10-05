import { by, device, element, expect as detoxExpect, waitFor } from 'detox';

async function openClipboardSettings(profile: 'mainnet' | 'testnet'): Promise<void> {
  await device.selectApp(profile);
  await device.launchApp({ newInstance: true });
  await waitFor(element(by.id('WalletsList')))
    .toBeVisible()
    .withTimeout(30_000);
  await element(by.id('SettingsButton')).tap();
  await element(by.id('GeneralSettings')).tap();
  await waitFor(element(by.id('ClipboardSwitch')))
    .toBeVisible()
    .withTimeout(10_000);
}

async function readClipboardState(): Promise<boolean> {
  const clipboardSwitch = element(by.id('ClipboardSwitch'));
  const attributes = await clipboardSwitch.getAttributes();
  if ('elements' in attributes || !attributes.enabled) {
    throw new Error('Expected one enabled native ClipboardSwitch before reading its state');
  }
  if (typeof attributes.value === 'boolean') {
    await detoxExpect(clipboardSwitch).toHaveToggleValue(attributes.value);
    return attributes.value;
  }
  if (attributes.value !== undefined) {
    throw new Error(`Unexpected native ClipboardSwitch value: ${String(attributes.value)}`);
  }

  // Installed Detox exports value only for CheckBox, not RN's SwitchCompat. Query the native checked matcher instead.
  try {
    await detoxExpect(clipboardSwitch).toHaveToggleValue(true);
    return true;
  } catch {
    // An unavailable/broken view must fail this second assertion, never become an assumed false snapshot.
    await detoxExpect(clipboardSwitch).toHaveToggleValue(false);
    return false;
  }
}

it('keeps both Android profiles isolated without resetting their app data', async () => {
  if (device.getPlatform() !== 'android' || !/^emulator-\d+$/.test(device.id)) {
    throw new Error(`Profile isolation smoke requires an explicitly selected owned Android emulator, not ${device.id}`);
  }

  // Snapshot both profiles before changing either preference; never assume a fresh/default state.
  await openClipboardSettings('mainnet');
  const initialMainnet = await readClipboardState();
  await openClipboardSettings('testnet');
  const initialTestnet = await readClipboardState();
  let mutationAttempted = false;

  try {
    await openClipboardSettings('mainnet');
    mutationAttempted = true;
    await element(by.id('ClipboardSwitch')).tap();
    await detoxExpect(element(by.id('ClipboardSwitch'))).toHaveToggleValue(!initialMainnet);

    await openClipboardSettings('testnet');
    await detoxExpect(element(by.id('ClipboardSwitch'))).toHaveToggleValue(initialTestnet);
    await openClipboardSettings('mainnet');
    await detoxExpect(element(by.id('ClipboardSwitch'))).toHaveToggleValue(!initialMainnet);
    await element(by.id('ClipboardSwitch')).tap();
    await detoxExpect(element(by.id('ClipboardSwitch'))).toHaveToggleValue(initialMainnet);
    mutationAttempted = false;

    for (const [profile, scheme, foreignScheme] of [
      ['mainnet', 'bluewallet-bhwi', 'bluewallet-bhwi-testnet'],
      ['testnet', 'bluewallet-bhwi-testnet', 'bluewallet-bhwi'],
    ]) {
      await device.selectApp(profile);
      await device.launchApp({ newInstance: true });
      await waitFor(element(by.id('WalletsList')))
        .toBeVisible()
        .withTimeout(30_000);
      await device.openURL({ url: `${scheme}:setelectrumserver?server=profile-smoke.invalid:443:s` });

      // ElectrumSettings opens a blocking confirmation on this route. Cancel it; never apply/save the supplied server.
      const cancel = element(by.type('android.widget.Button').and(by.text('Cancel')));
      await waitFor(cancel).toBeVisible().withTimeout(10_000);
      await cancel.tap();
      await waitFor(element(by.id('ElectrumSettingsScrollView')))
        .toBeVisible()
        .withTimeout(10_000);

      // A fresh instrumented launch injects the URI into the selected MainActivity; openURL would resolve the other installed app.
      await device.launchApp({ newInstance: true, url: `${foreignScheme}:setelectrumserver?server=foreign.invalid:443:s` });
      await waitFor(element(by.id('WalletsList')))
        .toBeVisible()
        .withTimeout(30_000);
      await detoxExpect(element(by.id('ElectrumSettingsScrollView'))).not.toExist();
      await detoxExpect(cancel).not.toExist();
      await device.terminateApp();
    }
  } finally {
    if (mutationAttempted) {
      await openClipboardSettings('mainnet');
      if ((await readClipboardState()) !== initialMainnet) {
        await element(by.id('ClipboardSwitch')).tap();
      }
      await detoxExpect(element(by.id('ClipboardSwitch'))).toHaveToggleValue(initialMainnet);
    }
  }
});
