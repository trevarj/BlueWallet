import assert from 'assert';
import BIP32Factory from 'bip32';
import type { BIP32Interface } from 'bip32';
import * as bitcoin from 'bitcoinjs-lib';
import { Buffer } from 'buffer';
import { decode, encode, encodingLength } from 'varuint-bitcoin';

import { MultisigHDWallet } from '../../class/wallets/multisig-hd-wallet';
import { WatchOnlyWallet } from '../../class/wallets/watch-only-wallet';
import { convertExtendedKey } from '../../class/wallets/extended-key';
import ecc from '../../blue_modules/noble_ecc';
import { validateBhwiPsbt, validateBhwiPsbtOriginal } from '../../blue_modules/validateBhwiPsbt';
import { network } from '../../models/bitcoinNetwork';

bitcoin.initEccLib(ecc);
const bip32 = BIP32Factory(ecc);
const CHANGED = 'Hardware wallet changed the transaction';
const INVALID_SIGNATURE = 'Invalid hardware-wallet signature';
const UNSUPPORTED = 'Unsupported hardware-wallet signing input';
const NO_SIGNATURE = 'Hardware wallet returned no signature';
const singlesigPath = network === bitcoin.networks.bitcoin ? "m/84'/0'/0'" : "m/84'/1'/0'";
const multisigPath = network === bitcoin.networks.bitcoin ? "m/48'/0'/0'/2'" : "m/48'/1'/0'/2'";

type Signer = { fingerprint: string; path: string; xpub: string };
type SinglesigFixture = {
  wallet: WatchOnlyWallet;
  signer: Signer;
  psbt: bitcoin.Psbt;
  children: BIP32Interface[];
  parents: bitcoin.Transaction[];
};
type RawEntry = { key: Buffer; value: Buffer };

type ParsedRaw = {
  globals: RawEntry[];
  inputs: RawEntry[][];
  outputs: RawEntry[][];
  transaction: bitcoin.Transaction;
};

const fingerprint = (root: BIP32Interface): string => Buffer.from(root.fingerprint).toString('hex');
const asBuffer = (value: Uint8Array): Buffer => Buffer.from(value.buffer, value.byteOffset, value.byteLength);
const expectMessage = (callback: () => unknown, message: string): void => {
  assert.throws(callback, error => error instanceof Error && error.message === message);
};

function required<Value>(value: Value | null | undefined): Value {
  assert.ok(value);
  return value;
}

function makeParent(script: Uint8Array, value: bigint, marker: number): bitcoin.Transaction {
  const transaction = new bitcoin.Transaction();
  const hash = new Uint8Array(32);
  hash[0] = marker;
  transaction.addInput(hash, 0xffffffff);
  transaction.addOutput(script, value);
  return transaction;
}

function makeSinglesigFixture(inputCount = 1, value = 100_000n): SinglesigFixture {
  const root = bip32.fromSeed(
    Uint8Array.from({ length: 32 }, (_, index) => index + 1),
    network,
  );
  const account = root.derivePath(singlesigPath);
  const signer = { fingerprint: fingerprint(root), path: singlesigPath, xpub: account.neutered().toBase58() };
  const wallet = new WatchOnlyWallet();
  wallet.setSecret(convertExtendedKey(signer.xpub, 'native')).init();
  wallet.setDerivationPath(singlesigPath);
  wallet.setMasterFingerprintFromHex(signer.fingerprint);
  const psbt = new bitcoin.Psbt({ network });
  const children: BIP32Interface[] = [];
  const parents: bitcoin.Transaction[] = [];
  for (let index = 0; index < inputCount; index++) {
    const child = account.derive(0).derive(index);
    const output = required(bitcoin.payments.p2wpkh({ pubkey: child.publicKey, network }).output);
    const parent = makeParent(output, value, index + 1);
    psbt.addInput({
      hash: parent.getId(),
      index: 0,
      nonWitnessUtxo: parent.toBuffer(),
      witnessUtxo: { script: output, value },
      bip32Derivation: [
        {
          masterFingerprint: Buffer.from(signer.fingerprint, 'hex'),
          path: `${singlesigPath}/0/${index}`,
          pubkey: child.publicKey,
        },
      ],
    });
    children.push(child);
    parents.push(parent);
  }
  const destination = required(bitcoin.payments.p2wpkh({ pubkey: account.derive(1).derive(0).publicKey, network }).output);
  psbt.addOutput({ script: destination, value: value * BigInt(inputCount) - 1_000n });
  return { wallet, signer, psbt, children, parents };
}

function compact(value: number): Buffer {
  const output = Buffer.alloc(encodingLength(value));
  encode(value, output);
  return output;
}

function record(key: Uint8Array, value: Uint8Array): Buffer {
  return Buffer.concat([compact(key.length), asBuffer(key), compact(value.length), asBuffer(value)]);
}

function parseRaw(base64: string): ParsedRaw {
  const buffer = Buffer.from(base64, 'base64');
  let offset = 5;
  const readMap = (): RawEntry[] => {
    const entries: RawEntry[] = [];
    for (;;) {
      const keyLength = decode(buffer, offset);
      offset += decode.bytes;
      if (keyLength === 0) return entries;
      const key = buffer.subarray(offset, offset + keyLength);
      offset += keyLength;
      const valueLength = decode(buffer, offset);
      offset += decode.bytes;
      const value = buffer.subarray(offset, offset + valueLength);
      offset += valueLength;
      entries.push({ key, value });
    }
  };
  const globals = readMap();
  const unsignedEntry = required(globals.find(entry => entry.key.length === 1 && entry.key[0] === 0));
  const transaction = bitcoin.Transaction.fromBuffer(unsignedEntry.value);
  const inputs = transaction.ins.map(readMap);
  const outputs = transaction.outs.map(readMap);
  assert.strictEqual(offset, buffer.length);
  return { globals, inputs, outputs, transaction };
}

function serializeRaw(transaction: bitcoin.Transaction, globals: RawEntry[], inputs: RawEntry[][], outputs: RawEntry[][]): string {
  const unsigned: RawEntry[] = globals.map(entry =>
    entry.key.length === 1 && entry.key[0] === 0 ? { key: entry.key, value: asBuffer(transaction.toBuffer()) } : entry,
  );
  const map = (entries: RawEntry[]): Buffer => Buffer.concat([...entries.map(entry => record(entry.key, entry.value)), Buffer.of(0)]);
  return Buffer.concat([Buffer.from('70736274ff', 'hex'), map(unsigned), ...inputs.map(map), ...outputs.map(map)]).toString('base64');
}

function makeMultisigFixture(
  keyCount = 2,
  threshold = 2,
): {
  wallet: MultisigHDWallet;
  signers: Signer[];
  children: BIP32Interface[];
  psbt: bitcoin.Psbt;
} {
  const roots = Array.from({ length: keyCount }, (_unusedKey, keyIndex) =>
    bip32.fromSeed(
      Uint8Array.from({ length: 32 }, (_unusedByte, byteIndex) => 11 + keyIndex * 11 + byteIndex),
      network,
    ),
  );
  const accounts = roots.map(root => root.derivePath(multisigPath));
  const signers = accounts.map((account, index) => {
    const root = required(roots[index]);
    return {
      fingerprint: fingerprint(root),
      path: multisigPath,
      xpub: account.neutered().toBase58(),
    };
  });
  const wallet = new MultisigHDWallet();
  wallet.setM(threshold);
  wallet.setDerivationPath(multisigPath);
  for (const signer of signers) wallet.addCosigner(signer.xpub, signer.fingerprint, signer.path);
  const children = accounts.map(account => account.derive(0).derive(0));
  const pubkeys = children.map(child => child.publicKey).sort((left, right) => Buffer.compare(asBuffer(left), asBuffer(right)));
  const witnessScript = required(bitcoin.payments.p2ms({ m: threshold, pubkeys, network }).output);
  const output = required(bitcoin.payments.p2wsh({ redeem: { output: witnessScript }, network }).output);
  const parent = makeParent(output, 150_000n, 90);
  const psbt = new bitcoin.Psbt({ network });
  psbt.addInput({
    hash: parent.getId(),
    index: 0,
    nonWitnessUtxo: parent.toBuffer(),
    witnessUtxo: { script: output, value: 150_000n },
    witnessScript,
    bip32Derivation: children.map((child, index) => {
      const signer = required(signers[index]);
      return {
        masterFingerprint: Buffer.from(signer.fingerprint, 'hex'),
        path: `${multisigPath}/0/0`,
        pubkey: child.publicKey,
      };
    }),
  });
  const firstAccount = required(accounts[0]);
  const destination = required(bitcoin.payments.p2wpkh({ pubkey: firstAccount.derive(1).derive(0).publicKey, network }).output);
  psbt.addOutput({ script: destination, value: 149_000n });
  return { wallet, signers, children, psbt };
}

function makeTaprootFixture(): {
  wallet: WatchOnlyWallet;
  signer: Signer;
  psbt: bitcoin.Psbt;
  tweakedSigner: bitcoin.Signer;
} {
  const path = network === bitcoin.networks.bitcoin ? "m/86'/0'/0'" : "m/86'/1'/0'";
  const root = bip32.fromSeed(
    Uint8Array.from({ length: 32 }, (_, index) => 151 + index),
    network,
  );
  const account = root.derivePath(path);
  const child = account.derive(0).derive(0);
  const internalPubkey = child.publicKey.subarray(1);
  const payment = bitcoin.payments.p2tr({ internalPubkey, network });
  const taprootOutput = required(payment.output);
  const parent = makeParent(taprootOutput, 80_000n, 121);
  const signer = { fingerprint: fingerprint(root), path, xpub: account.neutered().toBase58() };
  const wallet = new WatchOnlyWallet();
  wallet.setSecret(signer.xpub);
  wallet.segwitType = 'p2tr';
  wallet.init();
  wallet.setDerivationPath(path);
  wallet.setMasterFingerprintFromHex(signer.fingerprint);
  const psbt = new bitcoin.Psbt({ network });
  psbt.addInput({
    hash: parent.getId(),
    index: 0,
    witnessUtxo: { script: taprootOutput, value: 80_000n },
    tapInternalKey: internalPubkey,
    tapBip32Derivation: [
      {
        masterFingerprint: Buffer.from(signer.fingerprint, 'hex'),
        path: `${path}/0/0`,
        pubkey: internalPubkey,
        leafHashes: [],
      },
    ],
  });
  const destination = required(bitcoin.payments.p2wpkh({ pubkey: account.derive(1).derive(0).publicKey, network }).output);
  psbt.addOutput({ script: destination, value: 79_000n });
  const childPrivateKey = required(child.privateKey);
  const privateKey = child.publicKey[0] === 3 ? ecc.privateNegate(childPrivateKey) : childPrivateKey;
  const tweakedPrivateKey = required(ecc.privateAdd(privateKey, bitcoin.crypto.taggedHash('TapTweak', internalPubkey)));
  const publicKey = required(ecc.pointFromScalar(tweakedPrivateKey));
  const signSchnorr = ecc.signSchnorr;
  if (!signSchnorr) throw new Error('Schnorr signing is unavailable');
  return {
    wallet,
    signer,
    psbt,
    tweakedSigner: {
      publicKey,
      sign: hash => ecc.sign(hash, tweakedPrivateKey),
      signSchnorr: hash => signSchnorr(hash, tweakedPrivateKey),
    },
  };
}

test('binds key-path Taproot verification to the observed signature sighash byte', () => {
  const fixture = makeTaprootFixture();
  const signed = fixture.psbt.clone();
  signed.signTaprootInput(0, fixture.tweakedSigner);
  const result = validateBhwiPsbt(fixture.psbt.toBase64(), signed.toBase64(), fixture.wallet, fixture.signer);
  assert.ok(result.tx);

  const explicitZero = signed.clone();
  const explicitZeroInput = required(explicitZero.data.inputs[0]);
  const tapKeySig = required(explicitZeroInput.tapKeySig);
  explicitZeroInput.tapKeySig = Uint8Array.from([...tapKeySig, 0]);
  expectMessage(
    () => validateBhwiPsbt(fixture.psbt.toBase64(), explicitZero.toBase64(), fixture.wallet, fixture.signer),
    INVALID_SIGNATURE,
  );

  const defaultLabeledAll = signed.clone();
  const mislabeledInput = required(defaultLabeledAll.data.inputs[0]);
  const defaultSignature = required(mislabeledInput.tapKeySig);
  mislabeledInput.tapKeySig = Uint8Array.from([...defaultSignature, bitcoin.Transaction.SIGHASH_ALL]);
  expectMessage(
    () => validateBhwiPsbt(fixture.psbt.toBase64(), defaultLabeledAll.toBase64(), fixture.wallet, fixture.signer),
    INVALID_SIGNATURE,
  );

  const explicitAll = fixture.psbt.clone();
  const explicitAllInput = required(explicitAll.data.inputs[0]);
  const witnessUtxo = required(explicitAllInput.witnessUtxo);
  const unsignedEntry = required(parseRaw(explicitAll.toBase64()).globals.find(entry => entry.key.length === 1 && entry.key[0] === 0));
  const unsigned = bitcoin.Transaction.fromBuffer(unsignedEntry.value);
  const hash = unsigned.hashForWitnessV1(0, [witnessUtxo.script], [witnessUtxo.value], bitcoin.Transaction.SIGHASH_ALL);
  const signSchnorr = required(fixture.tweakedSigner.signSchnorr);
  explicitAllInput.tapKeySig = Uint8Array.from([...signSchnorr(hash), bitcoin.Transaction.SIGHASH_ALL]);
  const explicitAllResult = validateBhwiPsbt(fixture.psbt.toBase64(), explicitAll.toBase64(), fixture.wallet, fixture.signer);
  assert.ok(explicitAllResult.tx);
});

test('accepts real singlesig partial and finalized signatures', () => {
  const partialFixture = makeSinglesigFixture();
  const partial = partialFixture.psbt.clone();
  partial.signInput(0, partialFixture.children[0]);
  const partialResult = validateBhwiPsbt(partialFixture.psbt.toBase64(), partial.toBase64(), partialFixture.wallet, partialFixture.signer);
  assert.ok(partialResult.tx);
  assert.strictEqual(partialResult.tx.getId(), partialResult.psbt.extractTransaction().getId());

  const finalFixture = makeSinglesigFixture();
  const finalized = finalFixture.psbt.clone();
  finalized.signInput(0, finalFixture.children[0]).finalizeAllInputs();
  const finalResult = validateBhwiPsbt(finalFixture.psbt.toBase64(), finalized.toBase64(), finalFixture.wallet, finalFixture.signer);
  assert.ok(finalResult.tx);
  assert.strictEqual(finalResult.tx.toHex(), finalized.extractTransaction().toHex());
});

test('accepts real multisig partial and independently checks a finalized return', () => {
  const partialFixture = makeMultisigFixture();
  const partial = partialFixture.psbt.clone();
  partial.signInput(0, required(partialFixture.children[0]));
  const partialResult = validateBhwiPsbt(
    partialFixture.psbt.toBase64(),
    partial.toBase64(),
    partialFixture.wallet,
    required(partialFixture.signers[0]),
  );
  assert.strictEqual(partialResult.tx, undefined);
  assert.strictEqual(partialResult.psbt.data.inputs[0].partialSig?.length, 1);

  const finalFixture = makeMultisigFixture();
  const first = finalFixture.psbt.clone();
  first.signInput(0, required(finalFixture.children[0]));
  const finalized = first.clone();
  finalized.signInput(0, required(finalFixture.children[1])).finalizeAllInputs();
  const finalResult = validateBhwiPsbt(first.toBase64(), finalized.toBase64(), finalFixture.wallet, required(finalFixture.signers[1]));
  assert.ok(finalResult.tx);
  assert.strictEqual(finalResult.tx.toHex(), finalized.extractTransaction().toHex());
});

test('accepts a real finalized 16-of-16 P2WSH witness with 18 stack items', () => {
  const fixture = makeMultisigFixture(16, 16);
  const firstFifteen = fixture.psbt.clone();
  for (const child of fixture.children.slice(1)) firstFifteen.signInput(0, child);
  const finalized = firstFifteen.clone();
  finalized.signInput(0, required(fixture.children[0])).finalizeAllInputs();
  const finalizedInput = required(finalized.data.inputs[0]);
  const finalWitness = required(finalizedInput.finalScriptWitness);
  assert.strictEqual(finalWitness[0], 18);
  const result = validateBhwiPsbt(firstFifteen.toBase64(), finalized.toBase64(), fixture.wallet, required(fixture.signers[0]));
  assert.ok(result.tx);
  assert.strictEqual(result.tx.toHex(), finalized.extractTransaction().toHex());
});

test('rejects changed unsigned transactions and immutable input metadata', () => {
  const fixture = makeSinglesigFixture();
  const changedTransaction = fixture.psbt.clone();
  changedTransaction.setLocktime(1).signInput(0, fixture.children[0]);
  expectMessage(() => validateBhwiPsbt(fixture.psbt.toBase64(), changedTransaction.toBase64(), fixture.wallet, fixture.signer), CHANGED);

  const added = fixture.psbt.clone();
  added.addUnknownKeyValToInput(0, { key: Uint8Array.of(0xfc, 1), value: Uint8Array.of(1) });
  added.signInput(0, fixture.children[0]);
  expectMessage(() => validateBhwiPsbt(fixture.psbt.toBase64(), added.toBase64(), fixture.wallet, fixture.signer), CHANGED);

  const deleted = fixture.psbt.clone();
  delete deleted.data.inputs[0].bip32Derivation;
  deleted.signInput(0, fixture.children[0]);
  expectMessage(() => validateBhwiPsbt(fixture.psbt.toBase64(), deleted.toBase64(), fixture.wallet, fixture.signer), CHANGED);

  const replaced = fixture.psbt.clone();
  const replacedInput = required(replaced.data.inputs[0]);
  const replacedWitnessUtxo = required(replacedInput.witnessUtxo);
  replacedInput.witnessUtxo = { ...replacedWitnessUtxo, value: 99_999n };
  replaced.signInput(0, fixture.children[0]);
  expectMessage(() => validateBhwiPsbt(fixture.psbt.toBase64(), replaced.toBase64(), fixture.wallet, fixture.signer), CHANGED);
});

test('strictly rejects noncanonical, duplicate, and trailing PSBT framing', () => {
  const fixture = makeSinglesigFixture();
  const base64 = fixture.psbt.toBase64();
  const original = Buffer.from(base64, 'base64');
  const noncanonical = Buffer.concat([original.subarray(0, 5), Buffer.from('fd0100', 'hex'), original.subarray(6)]).toString('base64');
  expectMessage(() => validateBhwiPsbtOriginal(noncanonical, fixture.wallet, fixture.signer), UNSUPPORTED);

  const parsed = parseRaw(base64);
  const duplicate = serializeRaw(parsed.transaction, [parsed.globals[0], parsed.globals[0]], parsed.inputs, parsed.outputs);
  expectMessage(() => validateBhwiPsbtOriginal(duplicate, fixture.wallet, fixture.signer), UNSUPPORTED);

  const trailing = Buffer.concat([original, Buffer.of(0)]).toString('base64');
  expectMessage(() => validateBhwiPsbtOriginal(trailing, fixture.wallet, fixture.signer), UNSUPPORTED);

  const truncated = original.subarray(0, original.length - 1).toString('base64');
  expectMessage(() => validateBhwiPsbtOriginal(truncated, fixture.wallet, fixture.signer), UNSUPPORTED);
});

test('rejects mismatched parents, conflicting UTXOs, duplicate outpoints, excessive values, and negative fees', () => {
  const mismatchFixture = makeSinglesigFixture();
  const mismatchInput = required(mismatchFixture.psbt.data.inputs[0]);
  const mismatchWitnessUtxo = required(mismatchInput.witnessUtxo);
  mismatchInput.nonWitnessUtxo = makeParent(mismatchWitnessUtxo.script, 100_000n, 44).toBuffer();
  expectMessage(
    () => validateBhwiPsbtOriginal(mismatchFixture.psbt.toBase64(), mismatchFixture.wallet, mismatchFixture.signer),
    UNSUPPORTED,
  );

  const conflictFixture = makeSinglesigFixture();
  const conflictInput = required(conflictFixture.psbt.data.inputs[0]);
  const conflictWitnessUtxo = required(conflictInput.witnessUtxo);
  conflictInput.witnessUtxo = { ...conflictWitnessUtxo, value: 99_999n };
  expectMessage(
    () => validateBhwiPsbtOriginal(conflictFixture.psbt.toBase64(), conflictFixture.wallet, conflictFixture.signer),
    UNSUPPORTED,
  );

  const duplicateFixture = makeSinglesigFixture();
  const parsed = parseRaw(duplicateFixture.psbt.toBase64());
  const duplicateTransaction = parsed.transaction.clone();
  const firstInput = required(duplicateTransaction.ins[0]);
  duplicateTransaction.addInput(firstInput.hash, firstInput.index, firstInput.sequence);
  const duplicate = serializeRaw(duplicateTransaction, parsed.globals, [parsed.inputs[0], parsed.inputs[0]], parsed.outputs);
  expectMessage(() => validateBhwiPsbtOriginal(duplicate, duplicateFixture.wallet, duplicateFixture.signer), UNSUPPORTED);

  const excessiveFixture = makeSinglesigFixture(1, 2_100_000_000_000_001n);
  expectMessage(
    () => validateBhwiPsbtOriginal(excessiveFixture.psbt.toBase64(), excessiveFixture.wallet, excessiveFixture.signer),
    UNSUPPORTED,
  );

  const feeFixture = makeSinglesigFixture();
  const feeParsed = parseRaw(feeFixture.psbt.toBase64());
  const feeOutput = required(feeParsed.transaction.outs[0]);
  feeOutput.value = 100_001n;
  const negativeFee = serializeRaw(feeParsed.transaction, feeParsed.globals, feeParsed.inputs, feeParsed.outputs);
  expectMessage(() => validateBhwiPsbtOriginal(negativeFee, feeFixture.wallet, feeFixture.signer), UNSUPPORTED);
});

test('rejects unrelated, invalid, forbidden-sighash, and absent signatures', () => {
  const multisig = makeMultisigFixture();
  const unrelated = multisig.psbt.clone();
  unrelated.signInput(0, required(multisig.children[1]));
  expectMessage(
    () => validateBhwiPsbt(multisig.psbt.toBase64(), unrelated.toBase64(), multisig.wallet, required(multisig.signers[0])),
    INVALID_SIGNATURE,
  );

  const invalidFixture = makeSinglesigFixture();
  const invalid = invalidFixture.psbt.clone();
  const invalidChild = required(invalidFixture.children[0]);
  invalid.signInput(0, invalidChild);
  const invalidInput = required(invalid.data.inputs[0]);
  const invalidPartial = required(invalidInput.partialSig?.[0]);
  invalidPartial.signature[10] = invalidPartial.signature[10] === 0 ? 1 : invalidPartial.signature[10] - 1;
  expectMessage(
    () => validateBhwiPsbt(invalidFixture.psbt.toBase64(), invalid.toBase64(), invalidFixture.wallet, invalidFixture.signer),
    INVALID_SIGNATURE,
  );

  const sighashFixture = makeSinglesigFixture();
  const forbidden = sighashFixture.psbt.clone();
  const sighashChild = required(sighashFixture.children[0]);
  const scriptCode = required(bitcoin.payments.p2pkh({ pubkey: sighashChild.publicKey, network }).output);
  const forbiddenInput = required(forbidden.data.inputs[0]);
  const forbiddenWitnessUtxo = required(forbiddenInput.witnessUtxo);
  const forbiddenUnsigned = required(
    parseRaw(forbidden.toBase64()).globals.find(entry => entry.key.length === 1 && entry.key[0] === 0),
  ).value;
  const hash = bitcoin.Transaction.fromBuffer(forbiddenUnsigned).hashForWitnessV0(
    0,
    scriptCode,
    forbiddenWitnessUtxo.value,
    bitcoin.Transaction.SIGHASH_NONE,
  );
  forbidden.updateInput(0, {
    partialSig: [
      {
        pubkey: sighashChild.publicKey,
        signature: bitcoin.script.signature.encode(sighashChild.sign(hash), bitcoin.Transaction.SIGHASH_NONE),
      },
    ],
  });
  expectMessage(
    () => validateBhwiPsbt(sighashFixture.psbt.toBase64(), forbidden.toBase64(), sighashFixture.wallet, sighashFixture.signer),
    INVALID_SIGNATURE,
  );

  const unchangedFixture = makeSinglesigFixture();
  expectMessage(
    () =>
      validateBhwiPsbt(
        unchangedFixture.psbt.toBase64(),
        unchangedFixture.psbt.toBase64(),
        unchangedFixture.wallet,
        unchangedFixture.signer,
      ),
    NO_SIGNATURE,
  );
});

test('keeps mixed finalized and partial returns exportable without exposing a transaction', () => {
  const fixture = makeSinglesigFixture(2);
  const mixed = fixture.psbt.clone();
  mixed.signInput(0, required(fixture.children[0])).finalizeInput(0);
  const result = validateBhwiPsbt(fixture.psbt.toBase64(), mixed.toBase64(), fixture.wallet, fixture.signer);
  assert.strictEqual(result.tx, undefined);
  assert.ok(result.psbt.data.inputs[0].finalScriptWitness);
  assert.strictEqual(result.psbt.data.inputs[1].finalScriptWitness, undefined);
  assert.ok(result.psbt.toBase64().length > 0);
});
