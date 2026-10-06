import { PermissionsAndroid, Platform } from 'react-native';
import type * as Bhwi from '../../blue_modules/bhwi';

jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  Object.defineProperty(actual, 'Platform', { value: actual.Platform, configurable: true });
  actual.PermissionsAndroid.requestMultiple = jest.fn(async (permissions: readonly string[]) =>
    Object.fromEntries(
      permissions.map(permission => [
        permission,
        mockPermissionGranted ? actual.PermissionsAndroid.RESULTS.GRANTED : actual.PermissionsAndroid.RESULTS.DENIED,
      ]),
    ),
  );
  return actual;
});

let mockNative: Record<string, jest.Mock> | null;
let mockBytes = Uint8Array.from({ length: 16 }, (_, index) => index);
let mockPermissionGranted = true;

jest.mock('../../codegen/NativeBhwi', () => ({
  __esModule: true,
  get default() {
    return mockNative;
  },
}));

jest.mock('../../class/rng', () => ({
  randomBytes: jest.fn(async () => mockBytes),
}));

function nativeModule(): Record<string, jest.Mock> {
  return {
    discover: jest.fn(async () => []),
    connect: jest.fn(),
    getAccount: jest.fn(),
    registerWallet: jest.fn(),
    displaySinglesigAddress: jest.fn(),
    displayDescriptorAddress: jest.fn(),
    displayMultisigAddress: jest.fn(),
    signPsbt: jest.fn(),
    signMessage: jest.fn(),
    disconnect: jest.fn(async () => undefined),
  };
}

function load(os: 'android' | 'ios', native: Record<string, jest.Mock> | null): typeof Bhwi {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
  Object.defineProperty(Platform, 'Version', { value: os === 'android' ? 35 : 'test', configurable: true });
  mockNative = native;
  let loaded: typeof Bhwi | undefined;
  jest.isolateModules(() => {
    loaded = require('../../blue_modules/bhwi');
  });
  if (!loaded) throw new Error('BHWI wrapper did not load');
  return loaded;
}

beforeEach(() => {
  mockBytes = Uint8Array.from({ length: 16 }, (_, index) => index);
  mockPermissionGranted = true;
  jest.clearAllMocks();
});

it.each([
  ['ios', nativeModule()],
  ['android', null],
] as const)('fails only the hardware action when the %s native module is absent', async (os, native) => {
  const bhwi = load(os, native);
  const selection = { walletId: 'wallet', accountId: null };

  expect(bhwi.isBhwiAvailable()).toBe(false);
  await expect(bhwi.startBhwiSession(selection, () => selection)).rejects.toMatchObject({ code: 'BHWI_UNAVAILABLE' });
  if (native) expect(native.discover).not.toHaveBeenCalled();
});

it('creates one 16-byte owner and leaves network selection to the immutable native profile', async () => {
  const native = nativeModule();
  const bhwi = load('android', native);
  const selection = { walletId: 'wallet', accountId: 'account' };
  const session = await bhwi.startBhwiSession(selection, () => selection);

  await session.discover('usb');

  expect(native.discover).toHaveBeenCalledWith('000102030405060708090a0b0c0d0e0f', 'usb');
  expect(native.discover.mock.calls[0]).toHaveLength(2);
  await expect(bhwi.startBhwiSession(selection, () => selection)).rejects.toMatchObject({ code: 'BHWI_BUSY' });
  await session.disconnect();
});

it('retires the exact owner instead of publishing a stale result after selection changes', async () => {
  const { promise: discovery, resolve: resolveDiscovery } = (
    Promise as typeof Promise & {
      withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void };
    }
  ).withResolvers<unknown[]>();
  const native = nativeModule();
  native.discover = jest.fn(() => discovery);
  const bhwi = load('android', native);
  let current = { walletId: 'wallet-a', accountId: 'account-a' };
  const session = await bhwi.startBhwiSession(current, () => current);
  const pending = session.discover('usb');

  current = { walletId: 'wallet-b', accountId: 'account-b' };
  resolveDiscovery([]);

  await expect(pending).rejects.toMatchObject({ code: 'BHWI_CANCELLED' });
  expect(native.disconnect).toHaveBeenCalledWith('000102030405060708090a0b0c0d0e0f');
  const replacement = await bhwi.startBhwiSession(current, () => current);
  await replacement.disconnect();
});

it('uses the centralized JS permission request and never starts native BLE discovery after denial', async () => {
  mockPermissionGranted = false;
  const native = nativeModule();
  const bhwi = load('android', native);
  const selection = { walletId: 'wallet', accountId: null };
  const session = await bhwi.startBhwiSession(selection, () => selection);

  await expect(session.discover('ble')).rejects.toMatchObject({ code: 'BHWI_PERMISSION_DENIED' });
  expect(PermissionsAndroid.requestMultiple).toHaveBeenCalledWith([
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
  ]);
  expect(PermissionsAndroid.requestMultiple).toHaveBeenCalledTimes(1);
  expect(native.discover).not.toHaveBeenCalled();
  await session.disconnect();
});

it('maps native codes to redacted errors and never falls back from signing', async () => {
  const native = nativeModule();
  native.signPsbt.mockRejectedValue({ code: 'BHWI_DEVICE_ERROR', message: 'secret transport payload' });
  const bhwi = load('android', native);
  const selection = { walletId: 'wallet', accountId: null };
  const session = await bhwi.startBhwiSession(selection, () => selection);

  await expect(session.signPsbt('cHNidP8=', null)).rejects.toEqual(
    expect.objectContaining({ code: 'BHWI_DEVICE_ERROR', message: 'The hardware wallet reported an error.' }),
  );
  expect(native.signPsbt).toHaveBeenCalledTimes(1);
  await session.disconnect();
});

it('forwards the exact message path, legacy format, and message without rewriting the returned header', async () => {
  const native = nativeModule();
  const signature = 'IL3u9GLAzgG5BdtSBqUe0Fo2Zx0UlKwSsYx2TbuVX0VULFgZYRBQCW0W7QOlsB/JgGwWNhl3eYYjXtdfyR7pM+Y=';
  native.signMessage.mockResolvedValue(signature);
  const bhwi = load('android', native);
  const selection = { walletId: 'wallet', accountId: 'account' };
  const session = await bhwi.startBhwiSession(selection, () => selection);

  await expect(session.signMessage("m/44'/0'/0'/1/2", 'legacy', 'message')).resolves.toBe(signature);
  expect(native.signMessage).toHaveBeenCalledWith('000102030405060708090a0b0c0d0e0f', "m/44'/0'/0'/1/2", 'legacy', 'message');
  await session.disconnect();
});
