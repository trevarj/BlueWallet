import BIP32Factory from 'bip32';
import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import { transactionBytes } from 'coinselect/utils';

import ecc from '../../blue_modules/noble_ecc';
import { HDSegwitBech32Transaction } from '../../class/hd-segwit-bech32-transaction';
import { HDSegwitBech32Wallet } from '../../class/wallets/hd-segwit-bech32-wallet';
import { convertExtendedKey } from '../../class/wallets/extended-key';
import type { CreateTransactionResult } from '../../class/wallets/types';
import { WatchOnlyWallet } from '../../class/wallets/watch-only-wallet';
import { coinType, network } from '../../models/bitcoinNetwork';

const bip32 = BIP32Factory(ecc);
const unsignedResult = (fee: number): CreateTransactionResult => ({
  fee,
  inputs: [{ txid: '00'.repeat(32), vout: 0, value: 100_000, script: { length: 27 } }],
  outputs: [{ address: 'bc1qtest', value: 100_000 - fee, script: { length: 25 } }],
  psbt: new bitcoin.Psbt({ network }),
});

function mockHelper(createTransaction: jest.Mock, parentFee: number) {
  const parent = new bitcoin.Transaction();
  const wallet = {
    type: HDSegwitBech32Wallet.type,
    secret: '',
    getChangeAddressAsync: jest.fn(async () => 'bc1qchange'),
    createTransaction,
  } as unknown as HDSegwitBech32Wallet;
  const helper = new HDSegwitBech32Transaction(parent.toHex(), null, wallet);
  Object.assign(helper, { _remoteTx: {} });
  jest.spyOn(helper, 'getInfo').mockResolvedValue({
    fee: parentFee,
    feeRate: Math.floor(parentFee / parent.virtualSize()),
    parentVsize: parent.virtualSize(),
    targets: [],
    changeAmount: 0,
    utxos: [],
    unconfirmedUtxos: [{ txid: parent.getId(), vout: 0, value: 100_000, address: 'bc1qowned' }],
  });
  return helper;
}

function realWatchOnlyFixture() {
  const accountPath = `m/84'/${coinType}'/0'`;
  const root = bip32.fromSeed(
    Uint8Array.from({ length: 32 }, (_, index) => index + 71),
    network,
  );
  const fingerprint = Buffer.from(root.fingerprint).toString('hex');
  const account = root.derivePath(accountPath);
  const watchOnly = new WatchOnlyWallet();
  watchOnly.setSecret(convertExtendedKey(account.neutered().toBase58(), 'native')).init();
  watchOnly.setDerivationPath(accountPath);
  watchOnly.setMasterFingerprintFromHex(fingerprint);
  const wallet = watchOnly._hdWalletInstance;
  if (!(wallet instanceof HDSegwitBech32Wallet)) throw new Error('Expected BIP84 watch-only inner wallet');
  jest.spyOn(wallet, 'getChangeAddressAsync').mockResolvedValue(wallet._getInternalAddressByIndex(0));

  const ownedAddress = wallet._getExternalAddressByIndex(0);
  const parentFee = 0;
  const parent = new bitcoin.Transaction();
  parent.addInput(
    Uint8Array.from({ length: 32 }, () => 1),
    0,
  );
  parent.addOutput(bitcoin.address.toOutputScript(ownedAddress, network), 100_000n);
  const helper = new HDSegwitBech32Transaction(parent.toHex(), null, wallet, watchOnly.getMasterFingerprint());
  Object.assign(helper, { _remoteTx: {} });
  jest.spyOn(helper, 'getInfo').mockResolvedValue({
    fee: parentFee,
    feeRate: 1,
    parentVsize: parent.virtualSize(),
    targets: [],
    changeAmount: 100_000,
    utxos: [],
    unconfirmedUtxos: [{ txid: parent.getId(), vout: 0, value: 100_000, address: ownedAddress }],
  });
  return { fingerprint, helper, parent, parentFee, wallet };
}

function realHotFixture() {
  const wallet = new HDSegwitBech32Wallet();
  wallet.setSecret('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
  jest.spyOn(wallet, 'getChangeAddressAsync').mockResolvedValue(wallet._getInternalAddressByIndex(0));

  const ownedAddress = wallet._getExternalAddressByIndex(0);
  const parentFee = 0;
  const parent = new bitcoin.Transaction();
  parent.addInput(
    Uint8Array.from({ length: 32 }, () => 2),
    0,
  );
  parent.addOutput(bitcoin.address.toOutputScript(ownedAddress, network), 100_000n);
  const helper = new HDSegwitBech32Transaction(parent.toHex(), null, wallet);
  Object.assign(helper, { _remoteTx: {} });
  jest.spyOn(helper, 'getInfo').mockResolvedValue({
    fee: parentFee,
    feeRate: 1,
    parentVsize: parent.virtualSize(),
    targets: [],
    changeAmount: 100_000,
    utxos: [],
    unconfirmedUtxos: [{ txid: parent.getId(), vout: 0, value: 100_000, address: ownedAddress }],
  });
  return { helper, parent, parentFee, wallet };
}

test('builds a real BIP84 watch-only PSBT with exact fingerprint and sizing metadata in two bounded attempts', async () => {
  const { fingerprint, helper, parent, parentFee, wallet } = realWatchOnlyFixture();
  const createTransaction = jest.spyOn(wallet, 'createTransaction');
  const result = await helper.createCPFPbumpFee(2);

  expect(result.tx).toBeUndefined();
  expect(result.psbt).toBeInstanceOf(bitcoin.Psbt);
  expect(Buffer.from(result.psbt.data.inputs[0]!.bip32Derivation![0]!.masterFingerprint).toString('hex')).toBe(fingerprint);
  expect(result.inputs[0]!.script?.length).toBe(27);
  expect(result.outputs[0]!.script?.length).toBe(25);
  expect(createTransaction.mock.calls.map(call => call[2])).toEqual([2, 4]);

  const childVsize = transactionBytes(result.inputs, result.outputs);
  const packageFeeRate = (parentFee + result.fee) / (parent.virtualSize() + childVsize);
  expect(packageFeeRate).toBeGreaterThanOrEqual(2);
});

test('builds and finalizes a deterministic hot BIP84 child with its exact PSBT and package fees', async () => {
  const { helper, parent, parentFee, wallet } = realHotFixture();
  const createTransaction = jest.spyOn(wallet, 'createTransaction');
  const result = await helper.createCPFPbumpFee(2);
  if (!result.tx) throw new Error('Expected finalized hot-wallet CPFP transaction');

  expect(result.tx).toBeInstanceOf(bitcoin.Transaction);
  expect(createTransaction.mock.calls.map(call => call[5])).toEqual([false, false]);
  const psbtInputValue = result.psbt.data.inputs.reduce((sum, input) => sum + (input.witnessUtxo?.value ?? 0n), 0n);
  const psbtOutputValue = result.psbt.txOutputs.reduce((sum, output) => sum + output.value, 0n);
  expect(BigInt(result.fee)).toBe(psbtInputValue - psbtOutputValue);
  const packageFeeRate = (parentFee + result.fee) / (parent.virtualSize() + result.tx.virtualSize());
  expect(packageFeeRate).toBeGreaterThanOrEqual(2);
});

test.each([
  ['NaN target', Number.NaN, 0],
  ['infinite target', Number.POSITIVE_INFINITY, 0],
  ['target safe-integer overflow', Number.MAX_SAFE_INTEGER + 1, 0],
  ['parent fee safe-integer overflow', 1, Number.MAX_SAFE_INTEGER + 1],
])('rejects invalid CPFP arithmetic: %s', async (_label, target, parentFee) => {
  const createTransaction = jest.fn(() => unsignedResult(1));
  await expect(mockHelper(createTransaction, parentFee).createCPFPbumpFee(target)).rejects.toThrow('Invalid CPFP fee calculation');
  expect(createTransaction).not.toHaveBeenCalled();
});

test('rejects insufficient value and an eight-attempt target miss', async () => {
  const insufficient = jest.fn(() => {
    throw new Error('Insufficient balance');
  });
  await expect(mockHelper(insufficient, 0).createCPFPbumpFee(1)).rejects.toThrow('Insufficient balance');

  const neverEnough = jest.fn(() => unsignedResult(0));
  await expect(mockHelper(neverEnough, 0).createCPFPbumpFee(1)).rejects.toThrow('Unable to reach CPFP fee target');
  expect(neverEnough).toHaveBeenCalledTimes(8);
});
