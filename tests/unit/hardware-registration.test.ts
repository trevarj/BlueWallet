import BIP32Factory from 'bip32';
import { sha256 } from '@noble/hashes/sha256';

import {
  createHardwareWalletRegistration,
  getBhwiLedgerHmac,
  getBhwiLedgerHmacService,
  getBhwiPolicyName,
  matchesBhwiAddressSnapshot,
  requireBhwiDisplayedAddress,
  resolveBhwiAddressSnapshot,
  storeBhwiLedgerHmac,
} from '../../blue_modules/bhwi';
import type { HardwareWalletAssociation } from '../../blue_modules/bhwi';
import { uint8ArrayToHex } from '../../blue_modules/uint8array-extras';
import ecc from '../../blue_modules/noble_ecc';
import { MultisigHDWallet } from '../../class/wallets/multisig-hd-wallet';
import { bitcoinNetwork, coinType, network } from '../../models/bitcoinNetwork';

const Keychain = require('react-native-keychain');
const bip32 = BIP32Factory(ecc);

const makeWallet = () => {
  const path = MultisigHDWallet.PATH_NATIVE_SEGWIT;
  const firstXpub = bip32
    .fromSeed(
      Uint8Array.from({ length: 32 }, () => 1),
      network,
    )
    .derivePath(path)
    .neutered()
    .toBase58();
  const secondXpub = bip32
    .fromSeed(
      Uint8Array.from({ length: 32 }, () => 2),
      network,
    )
    .derivePath(path)
    .neutered()
    .toBase58();
  const wallet = new MultisigHDWallet();
  wallet.setM(2);
  wallet.setDerivationPath(path);
  wallet.addCosigner(secondXpub, 'A1B2C3D4', path);
  wallet.addCosigner(firstXpub, '086EE178', path);
  const association: HardwareWalletAssociation = {
    family: 'ledger',
    fingerprint: '086ee178',
    path,
    xpub: firstXpub,
    format: 'multisig-native',
  };
  wallet.addHardwareWalletAssociation(association);
  return { association, firstXpub, secondXpub, wallet };
};

beforeEach(() => {
  Keychain.__mockKeychainHelpers.reset();
  Keychain.setGenericPassword.mockClear();
  Keychain.getGenericPassword.mockClear();
});

it('exports one canonical sorted public descriptor and a label-independent stable policy name', () => {
  const { firstXpub, secondXpub, wallet } = makeWallet();
  const path = MultisigHDWallet.PATH_NATIVE_SEGWIT;
  const keys = [`[086ee178/${path.slice(2)}]${firstXpub}/<0;1>/*`, `[a1b2c3d4/${path.slice(2)}]${secondXpub}/<0;1>/*`].sort();
  const expected = `wsh(sortedmulti(2,${keys.join(',')}))`;

  expect(wallet.getPublicCosigners()).toEqual([
    { xpub: secondXpub, fingerprint: 'a1b2c3d4', path },
    { xpub: firstXpub, fingerprint: '086ee178', path },
  ]);
  expect(wallet.getPublicDescriptor()).toBe(expected);
  expect(getBhwiPolicyName(expected)).toBe(`bw_${uint8ArrayToHex(sha256(expected)).slice(0, 12)}`);
  expect(getBhwiPolicyName(expected)).toMatch(/^bw_[0-9a-f]{12}$/);
  wallet.setLabel('Renamed after registration');
  expect(wallet.getPublicDescriptor()).toBe(expected);
  expect(getBhwiPolicyName(wallet.getPublicDescriptor())).toBe(getBhwiPolicyName(expected));

  wallet.setWrappedSegwit();
  expect(wallet.getPublicDescriptor()).toBe(`sh(wsh(sortedmulti(2,${keys.join(',')})))`);
  wallet.setLegacy();
  expect(wallet.getPublicDescriptor()).toBe(`sh(sortedmulti(2,${keys.join(',')}))`);
});

it('persists only the public binding, invalidates it on policy change, and never serializes a Ledger HMAC', async () => {
  const { association, wallet } = makeWallet();
  const descriptor = wallet.getPublicDescriptor();
  const registration = createHardwareWalletRegistration(association, descriptor, 'complete');
  const hmacHex = 'ab'.repeat(32);
  await storeBhwiLedgerHmac(registration.hmacService!, hmacHex);
  wallet.addHardwareWalletRegistration(registration);
  const pendingAssociation: HardwareWalletAssociation = { ...association, family: 'coldcard' };
  wallet.addHardwareWalletAssociation(pendingAssociation);
  wallet.addHardwareWalletRegistration(createHardwareWalletRegistration(pendingAssociation, descriptor, 'pending'));
  expect(() => createHardwareWalletRegistration({ ...association, family: 'trezor' }, descriptor, 'complete')).toThrow();

  const serialized = JSON.stringify(wallet);
  expect(serialized).toContain(registration.hmacService!);
  expect(serialized).toContain(`"network":"${bitcoinNetwork}"`);
  expect(serialized).not.toContain(hmacHex);
  expect(serialized).not.toContain('hmacHex');

  const restored = MultisigHDWallet.fromJson(serialized);
  expect(restored.getHardwareWalletRegistration(association)).toEqual(registration);
  expect(restored.getHardwareWalletRegistration(pendingAssociation)?.status).toBe('pending');
  const edited = new MultisigHDWallet().setSecret(restored.getSecret());
  for (const hardwareAssociation of restored.getHardwareWalletAssociations()) {
    edited.addHardwareWalletAssociation(hardwareAssociation);
  }
  for (const hardwareRegistration of restored.getHardwareWalletRegistrations()) {
    edited.addHardwareWalletRegistration(hardwareRegistration);
  }
  expect(edited.getHardwareWalletRegistration(association)).toEqual(registration);

  restored.setM(1);
  expect(restored.getHardwareWalletRegistrations()).toEqual([]);
  restored.setM(2);
  expect(restored.getHardwareWalletRegistrations()).toEqual([]);
  const wrapperChanged = MultisigHDWallet.fromJson(serialized);
  wrapperChanged.setWrappedSegwit();
  expect(wrapperChanged.getHardwareWalletRegistrations()).toEqual([]);
  const originChanged = MultisigHDWallet.fromJson(serialized);
  originChanged.setDerivationPath(`m/48'/${coinType}'/1'/2'`);
  expect(originChanged.getHardwareWalletRegistrations()).toEqual([]);
  const keyChanged = MultisigHDWallet.fromJson(serialized);
  keyChanged.deleteCosigner('A1B2C3D4');
  expect(keyChanged.getHardwareWalletRegistrations()).toEqual([]);
});

it('preserves an exact hardware association and registration when its matching seed replaces the public cosigner', () => {
  const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const path = MultisigHDWallet.PATH_NATIVE_SEGWIT;
  const xpub = MultisigHDWallet.seedToXpub(mnemonic, path);
  const fingerprint = MultisigHDWallet.mnemonicToFingerprint(mnemonic).toLowerCase();
  const association: HardwareWalletAssociation = {
    family: 'ledger',
    fingerprint,
    path,
    xpub,
    format: 'multisig-native',
  };
  const wallet = new MultisigHDWallet();
  wallet.setM(1);
  wallet.setDerivationPath(path);
  wallet.addCosigner(xpub, fingerprint, path);
  wallet.addHardwareWalletAssociation(association);
  const registration = createHardwareWalletRegistration(association, wallet.getPublicDescriptor(), 'complete');
  wallet.addHardwareWalletRegistration(registration);

  wallet.replaceCosignerXpubWithSeed(1, mnemonic);

  expect(wallet.getHardwareWalletAssociations()).toEqual([association]);
  expect(wallet.getHardwareWalletRegistration(association)).toEqual(registration);
});

it('round-trips mixed explicit and global-fallback origins without changing hardware bindings', () => {
  const globalPath = MultisigHDWallet.PATH_NATIVE_SEGWIT;
  const customPath = `m/48'/${coinType}'/1'/2'`;
  const customXpub = bip32
    .fromSeed(
      Uint8Array.from({ length: 32 }, () => 3),
      network,
    )
    .derivePath(customPath)
    .neutered()
    .toBase58();
  const fallbackXpub = bip32
    .fromSeed(
      Uint8Array.from({ length: 32 }, () => 4),
      network,
    )
    .derivePath(globalPath)
    .neutered()
    .toBase58();
  const wallet = new MultisigHDWallet();
  wallet.setM(2);
  wallet.setDerivationPath(globalPath);
  wallet.addCosigner(customXpub, 'A1B2C3D4', customPath);
  wallet.addCosigner(fallbackXpub, '086EE178');
  const association: HardwareWalletAssociation = {
    family: 'ledger',
    fingerprint: '086ee178',
    path: globalPath,
    xpub: fallbackXpub,
    format: 'multisig-native',
  };
  wallet.addHardwareWalletAssociation(association);
  const descriptor = wallet.getPublicDescriptor();
  const registration = createHardwareWalletRegistration(association, descriptor, 'complete');
  wallet.addHardwareWalletRegistration(registration);

  const restored = new MultisigHDWallet().setSecret(wallet.getSecret());
  expect(restored.getPublicDescriptor()).toBe(descriptor);
  for (const hardwareAssociation of wallet.getHardwareWalletAssociations()) {
    restored.addHardwareWalletAssociation(hardwareAssociation);
  }
  for (const hardwareRegistration of wallet.getHardwareWalletRegistrations()) {
    restored.addHardwareWalletRegistration(hardwareRegistration);
  }
  expect(restored.getHardwareWalletAssociations()).toEqual([association]);
  expect(restored.getHardwareWalletRegistration(association)).toEqual(registration);
});

it('uses one deterministic per-policy/device-account Keychain service and retrieves only canonical HMAC data', async () => {
  const { association, wallet } = makeWallet();
  const descriptor = wallet.getPublicDescriptor();
  const service = getBhwiLedgerHmacService(descriptor, association);
  expect(getBhwiLedgerHmacService(descriptor, association)).toBe(service);
  const otherAccount = { ...association, fingerprint: 'a1b2c3d4', xpub: wallet.getPublicCosigners()[0].xpub };
  expect(getBhwiLedgerHmacService(descriptor, otherAccount)).not.toBe(service);
  expect(getBhwiLedgerHmacService(descriptor.replace('sortedmulti(2', 'sortedmulti(1'), association)).not.toBe(service);

  const hmacHex = 'CD'.repeat(32);
  await storeBhwiLedgerHmac(service, hmacHex);
  expect(Keychain.setGenericPassword).toHaveBeenCalledWith(service, hmacHex.toLowerCase(), {
    service,
    accessible: 'AccessibleWhenUnlockedThisDeviceOnly',
  });
  expect(await getBhwiLedgerHmac(service)).toBe(hmacHex.toLowerCase());
  expect(Keychain.__mockKeychainHelpers.store.get(service).password).toBe(hmacHex.toLowerCase());
});

it('snapshots exact current, historical, and change origins and fails closed on unknown, mismatch, and stale results', () => {
  let generation = 'a';
  const wallet = {
    next_free_address_index: 3,
    next_free_change_address_index: 2,
    gap_limit: 1,
    external_addresses_cache: {},
    internal_addresses_cache: {},
    _getExternalAddressByIndex: (index: number) => `${generation}-receive-${index}`,
    _getInternalAddressByIndex: (index: number) => `${generation}-change-${index}`,
  };

  const current = resolveBhwiAddressSnapshot(wallet, 'a-receive-3');
  const historical = resolveBhwiAddressSnapshot(wallet, 'a-receive-1', { index: 1, isInternal: false });
  const change = resolveBhwiAddressSnapshot(wallet, 'a-change-2', { index: 2, isInternal: true });
  expect(current).toEqual({ address: 'a-receive-3', index: 3, isInternal: false });
  expect(historical).toEqual({ address: 'a-receive-1', index: 1, isInternal: false });
  expect(change).toEqual({ address: 'a-change-2', index: 2, isInternal: true });
  expect(resolveBhwiAddressSnapshot(wallet, 'unknown')).toBeUndefined();
  expect(resolveBhwiAddressSnapshot(wallet, 'a-receive-1', { index: 0, isInternal: false })).toBeUndefined();
  expect(() => requireBhwiDisplayedAddress(historical!, historical!.address)).not.toThrow();
  expect(() => requireBhwiDisplayedAddress(historical!, 'device-returned-a-different-address')).toThrow();

  generation = 'b';
  expect(matchesBhwiAddressSnapshot(wallet, historical!)).toBe(false);
});
