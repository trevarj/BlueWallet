import assert from 'assert';
import BIP32Factory from 'bip32';
import { networks } from 'bitcoinjs-lib';

import {
  BHWI_MAX_ACCOUNT_INDEX,
  getBhwiAccountPath,
  isBhwiReconnectMatch,
  parseHardwareWalletAssociation,
  isBhwiXpubAtPath,
  supportsBhwiAccountFormat,
  verifyBhwiAccount,
} from '../../blue_modules/bhwi';
import type { HardwareWalletAssociation } from '../../blue_modules/bhwi';
import ecc from '../../blue_modules/noble_ecc';
import { WatchOnlyWallet } from '../../class/wallets/watch-only-wallet';
import { MultisigHDWallet } from '../../class/wallets/multisig-hd-wallet';
import { convertExtendedKey } from '../../class/wallets/extended-key';
import type { Account, DeviceInfo } from '../../codegen/NativeBhwi';

const bip32 = BIP32Factory(ecc);
const fingerprint = '086ee178';
const path = "m/84'/0'/0'";
const xpub = 'xpub6CqWTnie1ut9ZDD9xDeCn1VXk83VdAPSm8ZPfPNbb8w5z1e7jyy8zuX721uKj8u4GNxXqAevgEZjciUansnyz6ZhnSKyQWZwx2dpAxuCuDe';
const otherXpub = bip32
  .fromSeed(
    Uint8Array.from({ length: 32 }, (_, index) => index + 2),
    networks.bitcoin,
  )
  .derivePath(path)
  .neutered()
  .toBase58();
const rootXpub = bip32.fromSeed(
  Uint8Array.from({ length: 32 }, (_, index) => index + 4),
  networks.bitcoin,
);
const wrongDepthXpub = rootXpub.derivePath("m/84'/0'").neutered().toBase58();
const wrongChildXpub = rootXpub.derivePath("m/84'/0'/1'").neutered().toBase58();
const serializedRootXpub = rootXpub.neutered().toBase58();
const testnetXpub = bip32
  .fromSeed(
    Uint8Array.from({ length: 32 }, (_, index) => index + 1),
    networks.testnet,
  )
  .derivePath("m/84'/1'/0'")
  .neutered()
  .toBase58();
const info: DeviceInfo = { family: 'ledger', fingerprint, version: '1', model: null };
const account: Account = {
  family: 'ledger',
  fingerprint,
  path,
  xpub,
  format: 'native-segwit',
  descriptor: `wpkh([${fingerprint}/84h/0h/0h]${xpub}/<0;1>/*)#mthwej8w`,
};

it('derives bounded mainnet and Testnet3 account paths for every supported import form', () => {
  expect(getBhwiAccountPath('legacy', 0, 0)).toBe("m/44'/0'/0'");
  expect(getBhwiAccountPath('nested-segwit', 7, 1)).toBe("m/49'/1'/7'");
  expect(getBhwiAccountPath('native-segwit', BHWI_MAX_ACCOUNT_INDEX, 0)).toBe("m/84'/0'/2147483647'");
  expect(getBhwiAccountPath('taproot', '3', 1)).toBe("m/86'/1'/3'");
  expect(getBhwiAccountPath('multisig-wrapped', 2, 0)).toBe("m/48'/0'/2'/1'");
  expect(getBhwiAccountPath('multisig-native', 2, 1)).toBe("m/48'/1'/2'/2'");
  for (const invalid of [-1, 1.5, '01', '1e2', '', BHWI_MAX_ACCOUNT_INDEX + 1]) {
    expect(() => getBhwiAccountPath('native-segwit', invalid)).toThrow();
  }
  expect(() => getBhwiAccountPath('native-segwit', 0, 2)).toThrow();
});

it('mirrors source family/model format capabilities without offering unsupported forms', () => {
  expect(supportsBhwiAccountFormat({ family: 'ledger', model: null }, 'taproot')).toBe(true);
  expect(supportsBhwiAccountFormat({ family: 'bitbox02', model: null }, 'legacy')).toBe(false);
  expect(supportsBhwiAccountFormat({ family: 'bitbox02', model: null }, 'multisig-native')).toBe(true);
  expect(supportsBhwiAccountFormat({ family: 'jade', model: null }, 'taproot')).toBe(false);
  expect(supportsBhwiAccountFormat({ family: 'trezor', model: '1' }, 'taproot')).toBe(false);
  expect(supportsBhwiAccountFormat({ family: 'trezor', model: 'T' }, 'taproot')).toBe(true);
});

it('accepts only the exact selected-chain public account and complete origin descriptor', () => {
  expect(verifyBhwiAccount(info, path, 'native-segwit', account)).toEqual({
    family: 'ledger',
    fingerprint,
    path,
    xpub,
    format: 'native-segwit',
  });
  const invalidAccounts: Account[] = [
    { ...account, fingerprint: fingerprint.toUpperCase() },
    { ...account, path: "m/84'/0'/1'" },
    { ...account, xpub: testnetXpub, descriptor: `wpkh([${fingerprint}/84'/0'/0']${testnetXpub})` },
    { ...account, descriptor: null },
    { ...account, descriptor: `pkh([${fingerprint}/84'/0'/0']${xpub})` },
    { ...account, descriptor: `wpkh([${fingerprint}/84'/0'/1']${xpub})` },
    { ...account, descriptor: `wpkh([${fingerprint}/84h/0h/0h]${xpub})#x9ekshv0` },
    { ...account, descriptor: `wpkh([${fingerprint}/84h/0h/0h]${xpub}/0/*)#mqks9am8` },
    { ...account, descriptor: `wpkh([${fingerprint}/84h/0h/0h]${xpub}/1/*)#25n3cgtl` },
    { ...account, descriptor: `wpkh([${fingerprint}/84h/0h/0h]${xpub}/{0,1}/*)#yzk69rxa` },
    { ...account, descriptor: `wpkh([${fingerprint}/84'/0'/0']${otherXpub})` },
    { ...account, descriptor: account.descriptor!.replace(/.$/, 'q') },
  ];
  for (const invalid of invalidAccounts) expect(() => verifyBhwiAccount(info, path, 'native-segwit', invalid)).toThrow();
});

it('binds extended-key depth and final hardened child to the canonical account path', () => {
  expect(isBhwiXpubAtPath(xpub, path)).toBe(true);
  expect(isBhwiXpubAtPath(serializedRootXpub, path)).toBe(false);
  expect(isBhwiXpubAtPath(wrongDepthXpub, path)).toBe(false);
  expect(isBhwiXpubAtPath(wrongChildXpub, path)).toBe(false);
  for (const invalidXpub of [serializedRootXpub, wrongDepthXpub, wrongChildXpub]) {
    expect(
      parseHardwareWalletAssociation({
        family: 'ledger',
        fingerprint,
        path,
        xpub: invalidXpub,
        format: 'native-segwit',
      }),
    ).toBeUndefined();
  }
});

it('requires exact family, fingerprint, path, xpub and format for reconnect', () => {
  const association = verifyBhwiAccount(info, path, 'native-segwit', account);
  expect(isBhwiReconnectMatch(association, info, account)).toBe(true);
  expect(isBhwiReconnectMatch(association, { ...info, family: 'jade' }, account)).toBe(false);
  expect(isBhwiReconnectMatch(association, info, { ...account, family: 'jade' })).toBe(false);
  expect(isBhwiReconnectMatch(association, info, { ...account, fingerprint: '00000000' })).toBe(false);
  expect(isBhwiReconnectMatch(association, { ...info, fingerprint: '00000000' }, account)).toBe(false);
  expect(isBhwiReconnectMatch(association, info, { ...account, path: "m/84'/0'/1'" })).toBe(false);
  expect(isBhwiReconnectMatch(association, info, { ...account, xpub: otherXpub })).toBe(false);
  expect(isBhwiReconnectMatch(association, info, { ...account, format: 'legacy' })).toBe(false);
});

it('serializes only validated public association data without changing wallet identity', () => {
  const wallet = WatchOnlyWallet.fromBhwiAccount(info, account, path, 'native-segwit');
  const samePublicWallet = new WatchOnlyWallet().setSecret(account.descriptor!).init();
  samePublicWallet.setMasterFingerprintFromHex(fingerprint);
  const id = wallet.getID();
  assert.strictEqual(id, samePublicWallet.getID());

  const serialized = JSON.stringify(wallet);
  const stored = JSON.parse(serialized) as { hardwareWalletAssociation: HardwareWalletAssociation };
  expect(stored.hardwareWalletAssociation).toEqual({ family: 'ledger', fingerprint, path, xpub, format: 'native-segwit' });
  expect(serialized).not.toContain('sessionId');
  expect(serialized).not.toContain('deviceId');
  expect(serialized).not.toContain('passphrase');
  expect(serialized).not.toContain('pin');
  expect(serialized).not.toMatch(/xprv|zprv|yprv|tprv|vprv|mnemonic/i);

  const restored = WatchOnlyWallet.fromJson(serialized).init();
  expect(restored.getHardwareWalletAssociation()).toEqual(stored.hardwareWalletAssociation);
  expect(restored.getID()).toBe(id);

  const tainted = JSON.parse(serialized);
  tainted.hardwareWalletAssociation = { ...tainted.hardwareWalletAssociation, fingerprint: 'D34DB33F', sessionId: 'live-owner' };
  const invalidFingerprint = WatchOnlyWallet.fromJson(JSON.stringify(tainted)).init();
  expect(invalidFingerprint.useWithHardwareWalletEnabled()).toBe(false);
  expect(invalidFingerprint.getHardwareWalletAssociation()).toBeUndefined();

  tainted.hardwareWalletAssociation = { ...stored.hardwareWalletAssociation, xpub: testnetXpub };
  const invalidChain = WatchOnlyWallet.fromJson(JSON.stringify(tainted)).init();
  expect(invalidChain.getHardwareWalletAssociation()).toBeUndefined();
  expect(invalidChain.useWithHardwareWalletEnabled()).toBe(false);
});

it('binds a multisig hardware cosigner by public account identity rather than slot index', () => {
  const multisigPath = MultisigHDWallet.PATH_NATIVE_SEGWIT;
  const multisigXpub = bip32
    .fromSeed(
      Uint8Array.from({ length: 32 }, (_, index) => index + 3),
      networks.bitcoin,
    )
    .derivePath(multisigPath)
    .neutered()
    .toBase58();
  const association: HardwareWalletAssociation = {
    family: 'ledger',
    fingerprint,
    path: multisigPath,
    xpub: multisigXpub,
    format: 'multisig-native',
  };
  const wallet = new MultisigHDWallet();
  wallet.setM(1);
  wallet.setNativeSegwit();
  wallet.setDerivationPath(multisigPath);
  wallet.addCosigner(convertExtendedKey(multisigXpub, 'multisigNative'), fingerprint, multisigPath);
  const id = wallet.getID();
  wallet.addHardwareWalletAssociation(association);

  expect(wallet.getID()).toBe(id);
  expect(wallet.getHardwareWalletAssociations()).toEqual([association]);
  const restored = MultisigHDWallet.fromJson(JSON.stringify(wallet));
  expect(restored.getID()).toBe(id);
  expect(restored.getHardwareWalletAssociations()).toEqual([association]);

  const mismatchedStorage = JSON.parse(JSON.stringify(wallet));
  mismatchedStorage._isNativeSegwit = false;
  mismatchedStorage._isWrappedSegwit = true;
  const mismatchedWrapper = MultisigHDWallet.fromJson(JSON.stringify(mismatchedStorage));
  expect(mismatchedWrapper.getHardwareWalletAssociations()).toEqual([]);
});

it('sanitizes unknown metadata fields instead of ever restoring live or secret state', () => {
  const parsed = parseHardwareWalletAssociation({
    family: 'ledger',
    fingerprint,
    path,
    xpub,
    format: 'native-segwit',
    sessionId: 'owner',
    deviceId: 'transport',
    pin: '1234',
    passphrase: 'secret',
  });
  expect(parsed).toEqual({ family: 'ledger', fingerprint, path, xpub, format: 'native-segwit' });
  expect(JSON.stringify(parsed)).not.toMatch(/owner|transport|1234|secret/);
});
