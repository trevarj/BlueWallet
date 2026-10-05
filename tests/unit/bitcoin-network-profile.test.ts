import { address, payments } from 'bitcoinjs-lib';
import { Platform } from 'react-native';
import type * as BitcoinProfile from '../../models/bitcoinNetwork';

jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  Object.defineProperty(actual, 'Platform', { value: actual.Platform, configurable: true });
  return actual;
});
jest.mock('../../codegen/NativeSettingsModule', () => ({
  __esModule: true,
  get default() {
    return mockNativeModule;
  },
}));

let mockNativeModule: unknown;

function loadProfile(os: 'android' | 'ios' | 'web', nativeModule: unknown): typeof BitcoinProfile {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
  mockNativeModule = nativeModule;
  let profile: typeof BitcoinProfile | undefined;
  jest.isolateModules(() => {
    profile = require('../../models/bitcoinNetwork');
  });
  if (!profile) throw new Error('Profile did not load');
  return profile;
}

it('binds address encoding, coin type and genesis to each immutable native profile', () => {
  const mainnetConstants = jest.fn(() => ({ bitcoinNetwork: 'bitcoin' }));
  const mainnet = loadProfile('android', { getConstants: mainnetConstants });
  const testnet = loadProfile('android', { getConstants: jest.fn(() => ({ bitcoinNetwork: 'testnet' })) });
  const hash = Buffer.alloc(20, 1);
  const mainnetAddress = payments.p2wpkh({ hash, network: mainnet.network }).address!;
  const testnetAddress = payments.p2wpkh({ hash, network: testnet.network }).address!;

  expect(mainnetAddress).toMatch(/^bc1/);
  expect(testnetAddress).toMatch(/^tb1/);
  expect(address.toOutputScript(mainnetAddress, mainnet.network)).toEqual(address.toOutputScript(testnetAddress, testnet.network));
  expect(() => address.toOutputScript(testnetAddress, mainnet.network)).toThrow();
  expect(() => address.toOutputScript(mainnetAddress, testnet.network)).toThrow();
  expect([mainnet.bitcoinNetwork, mainnet.coinType, mainnet.genesisHash]).toEqual([
    'bitcoin',
    0,
    '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
  ]);
  expect([testnet.bitcoinNetwork, testnet.coinType, testnet.genesisHash]).toEqual([
    'testnet',
    1,
    '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943',
  ]);

  mainnetConstants.mockReturnValue({ bitcoinNetwork: 'testnet' });
  expect(payments.p2wpkh({ hash, network: mainnet.network }).address).toBe(mainnetAddress);
  expect(mainnet.bitcoinNetwork).toBe('bitcoin');
  expect(mainnetConstants).toHaveBeenCalledTimes(1);
});

it.each([null, undefined, {}, { getConstants: undefined }, { getConstants: 1 }])(
  'fails closed for missing Android bindings: %p',
  nativeModule => {
    expect(() => loadProfile('android', nativeModule)).toThrow();
  },
);

it.each([
  undefined,
  null,
  {},
  { bitcoinNetwork: undefined },
  { bitcoinNetwork: null },
  { bitcoinNetwork: 1 },
  { bitcoinNetwork: 'mainnet' },
  { bitcoinNetwork: 'testnet3' },
  { bitcoinNetwork: 'signet' },
  { bitcoinNetwork: 'testnet4' },
])('fails closed for invalid Android constants: %p', constants => {
  expect(() => loadProfile('android', { getConstants: () => constants })).toThrow(
    'Missing or invalid Android bitcoinNetwork build constant',
  );
});

it.each(['ios', 'web'] as const)('keeps %s on mainnet without reading Android constants', os => {
  const getConstants = jest.fn(() => {
    throw new Error('Android constants must not be read');
  });
  const profile = loadProfile(os, { getConstants });
  expect(profile.bitcoinNetwork).toBe('bitcoin');
  expect(profile.network.bech32).toBe('bc');
  expect(profile.coinType).toBe(0);
  expect(getConstants).not.toHaveBeenCalled();
  expect(loadProfile(os, null).bitcoinNetwork).toBe('bitcoin');
});
