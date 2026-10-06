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
import {
  BHWI_SIGNING_SESSION_EXPIRED,
  assertBhwiPsbtContinuationToken,
  assertBhwiPsbtAttemptCurrent,
  getBhwiImportedPsbtDestination,
  hydrateBhwiPsbt,
  validateBhwiBoundPsbt,
} from '../../blue_modules/bhwiPsbt';
import type { BhwiPsbtAttemptSnapshot } from '../../blue_modules/bhwiPsbt';
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
  const signer = {
    fingerprint: fingerprint(root),
    path: singlesigPath,
    xpub: account.neutered().toBase58(),
  };
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
  const destination = required(
    bitcoin.payments.p2wpkh({
      pubkey: account.derive(1).derive(0).publicKey,
      network,
    }).output,
  );
  psbt.addOutput({
    script: destination,
    value: value * BigInt(inputCount) - 1_000n,
  });
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
  const destination = required(
    bitcoin.payments.p2wpkh({
      pubkey: firstAccount.derive(1).derive(0).publicKey,
      network,
    }).output,
  );
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
  const signer = {
    fingerprint: fingerprint(root),
    path,
    xpub: account.neutered().toBase58(),
  };
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
  const destination = required(
    bitcoin.payments.p2wpkh({
      pubkey: account.derive(1).derive(0).publicKey,
      network,
    }).output,
  );
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

test('selects only hardware-bound imported PSBT destinations for the selected wallet', () => {
  const singlesig = makeSinglesigFixture();
  assert.strictEqual(getBhwiImportedPsbtDestination(singlesig.wallet), undefined);
  singlesig.wallet.setHardwareWalletAssociation({
    family: 'ledger',
    fingerprint: singlesig.signer.fingerprint,
    path: singlesig.signer.path,
    xpub: singlesig.signer.xpub,
    format: 'native-segwit',
  });
  assert.strictEqual(getBhwiImportedPsbtDestination(singlesig.wallet), 'PsbtWithHardwareWallet');

  const phoneMnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const hardwareRoot = bip32.fromSeed(
    Uint8Array.from({ length: 32 }, (_unused, index) => index + 91),
    network,
  );
  const hardwareAccount = hardwareRoot.derivePath(multisigPath);
  const hardwareAssociation = {
    family: 'ledger' as const,
    fingerprint: fingerprint(hardwareRoot),
    path: multisigPath,
    xpub: hardwareAccount.neutered().toBase58(),
    format: 'multisig-native' as const,
  };
  const hardwareMobile = new MultisigHDWallet();
  hardwareMobile.setM(2);
  hardwareMobile.setDerivationPath(multisigPath);
  hardwareMobile.addCosigner(phoneMnemonic, undefined, multisigPath);
  hardwareMobile.addCosigner(hardwareAssociation.xpub, hardwareAssociation.fingerprint, multisigPath);
  hardwareMobile.addHardwareWalletAssociation(hardwareAssociation);
  assert.strictEqual(getBhwiImportedPsbtDestination(hardwareMobile), 'PsbtMultisig');

  const unrelatedMultisig = makeMultisigFixture();
  const unrelatedSigner = required(unrelatedMultisig.signers[0]);
  unrelatedMultisig.wallet.addHardwareWalletAssociation({
    family: 'ledger',
    fingerprint: unrelatedSigner.fingerprint,
    path: unrelatedSigner.path,
    xpub: unrelatedSigner.xpub,
    format: 'multisig-native',
  });
  assert.strictEqual(getBhwiImportedPsbtDestination(unrelatedMultisig.wallet), undefined);
});

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

test('preserves the first real signature and completes in phone-first and hardware-first order', () => {
  for (const [firstIndex, secondIndex] of [
    [0, 1],
    [1, 0],
  ] as const) {
    const fixture = makeMultisigFixture();
    const first = fixture.psbt.clone();
    first.signInput(0, required(fixture.children[firstIndex]));
    const acceptedFirst = validateBhwiPsbt(
      fixture.psbt.toBase64(),
      first.toBase64(),
      fixture.wallet,
      required(fixture.signers[firstIndex]),
    );
    assert.strictEqual(acceptedFirst.psbt.data.inputs[0]?.partialSig?.length, 1);
    const second = acceptedFirst.psbt.clone();
    second.signInput(0, required(fixture.children[secondIndex]));
    const completed = validateBhwiPsbt(
      acceptedFirst.psbt.toBase64(),
      second.toBase64(),
      fixture.wallet,
      required(fixture.signers[secondIndex]),
    );
    assert.ok(completed.tx);
    assert.strictEqual(completed.psbt.data.inputs[0]?.partialSig, undefined);
    assert.ok(completed.psbt.data.inputs[0]?.finalScriptWitness);
  }
});

test('counts the minimum real signatures per input and returns zero without inputs', () => {
  const fixture = makeMultisigFixture();
  const firstInput = required(fixture.psbt.data.inputs[0]);
  const firstPrevout = required(firstInput.witnessUtxo);
  const parent = makeParent(firstPrevout.script, firstPrevout.value, 91);
  const psbt = fixture.psbt.clone();
  psbt.addInput({
    hash: parent.getId(),
    index: 0,
    nonWitnessUtxo: parent.toBuffer(),
    witnessUtxo: { ...firstPrevout },
    witnessScript: required(firstInput.witnessScript),
    bip32Derivation: required(firstInput.bip32Derivation).map(derivation => ({
      ...derivation,
    })),
  });
  const unsigned = psbt.clone();
  psbt.signInput(0, required(fixture.children[0]));
  psbt.signInput(1, required(fixture.children[0]));
  psbt.signInput(1, required(fixture.children[1])).finalizeInput(1);
  assert.strictEqual(fixture.wallet.calculateHowManySignaturesWeHaveFromPsbt(psbt), 1);
  assert.strictEqual(fixture.wallet.calculateHowManySignaturesWeHaveFromPsbt(new bitcoin.Psbt({ network })), 0);

  const first = unsigned.clone();
  first.signInput(0, required(fixture.children[0]));
  first.signInput(1, required(fixture.children[0]));
  const firstAccepted = validateBhwiPsbt(unsigned.toBase64(), first.toBase64(), fixture.wallet, required(fixture.signers[0]));
  const missingQuorum = firstAccepted.psbt.clone();
  missingQuorum.signInput(0, required(fixture.children[1]));
  const incomplete = validateBhwiPsbt(
    firstAccepted.psbt.toBase64(),
    missingQuorum.toBase64(),
    fixture.wallet,
    required(fixture.signers[1]),
  );
  assert.strictEqual(incomplete.tx, undefined);
  assert.strictEqual(incomplete.selectedSignerSignedAllInputs, false);
  assert.ok(incomplete.psbt.data.inputs[0]?.finalScriptWitness);
  assert.strictEqual(incomplete.continuationPsbt.data.inputs[0]?.finalScriptWitness, undefined);
  assert.strictEqual(incomplete.continuationPsbt.data.inputs[0]?.partialSig?.length, 2);
  assert.strictEqual(fixture.wallet.calculateHowManySignaturesWeHaveFromPsbt(incomplete.psbt), 1);
  const retry = incomplete.continuationPsbt.clone();
  retry.signInput(1, required(fixture.children[1]));
  const completedRetry = validateBhwiPsbt(
    incomplete.continuationPsbt.toBase64(),
    retry.toBase64(),
    fixture.wallet,
    required(fixture.signers[1]),
  );
  assert.strictEqual(completedRetry.selectedSignerSignedAllInputs, true);
  assert.ok(completedRetry.tx);
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

test('accepts only complete canonical parent-witness stripping and retains trusted parents through multisig signing', () => {
  const fixture = makeMultisigFixture();
  const signer = required(fixture.signers[0]);
  const selected = required(fixture.children[0]);
  const phone = required(fixture.children[1]);
  const raw = parseRaw(fixture.psbt.toBase64());
  const parentEntry = required(required(raw.inputs[0]).find(entry => entry.key.length === 1 && entry.key[0] === 0));
  const parent = bitcoin.Transaction.fromBuffer(parentEntry.value);
  parent.setInputScript(0, Uint8Array.of(0x51));
  parent.addInput(new Uint8Array(32).fill(91), 1, 0xfffffffe, Uint8Array.of(0x52));
  parent.addOutput(Uint8Array.of(0x51), 1_000n);
  parent.setWitness(0, [Uint8Array.of(1, 2, 3), selected.publicKey]);
  parent.setWitness(1, [Uint8Array.of(4, 5, 6), phone.publicKey]);
  const fullParentBytes = asBuffer(parent.toBuffer());
  parentEntry.value = fullParentBytes;
  required(raw.transaction.ins[0]).hash = parent.getHash();
  const unsigned = bitcoin.Psbt.fromBase64(serializeRaw(raw.transaction, raw.globals, raw.inputs, raw.outputs), { network });
  const strippedParent = parent.clone();
  strippedParent.stripWitnesses();
  const strippedParentBytes = asBuffer(strippedParent.toBuffer());
  const withParent = (signed: bitcoin.Psbt, value?: Uint8Array): string => {
    const returned = parseRaw(signed.toBase64());
    const input = required(returned.inputs[0]);
    if (value) {
      required(input.find(entry => entry.key.length === 1 && entry.key[0] === 0)).value = asBuffer(value);
    } else {
      returned.inputs[0] = input.filter(entry => entry.key.length !== 1 || entry.key[0] !== 0);
    }
    return serializeRaw(returned.transaction, returned.globals, returned.inputs, returned.outputs);
  };
  const partial = unsigned.clone().signInput(0, selected);
  const phoneSigned = unsigned.clone().signInput(0, phone);
  const fullySigned = phoneSigned.clone().signInput(0, selected);
  const finalized = fullySigned.clone().finalizeAllInputs();
  for (const [original, signed, complete] of [
    [unsigned, partial, false],
    [phoneSigned, fullySigned, true],
    [phoneSigned, finalized, true],
  ] as const) {
    for (const returnedParentBytes of [fullParentBytes, strippedParentBytes]) {
      const result = validateBhwiPsbt(original.toBase64(), withParent(signed, returnedParentBytes), fixture.wallet, signer);
      assert.strictEqual(!!result.tx, complete);
      assert.strictEqual(result.selectedSignerSignedAllInputs, true);
      assert.strictEqual(fixture.wallet.calculateHowManySignaturesWeHaveFromPsbt(result.psbt), complete ? 2 : 1);
      if (result.tx) assert.strictEqual(result.tx.toHex(), finalized.extractTransaction().toHex());
      for (const psbt of [result.psbt, result.continuationPsbt]) {
        assert.deepStrictEqual(asBuffer(required(psbt.data.inputs[0]?.nonWitnessUtxo)), fullParentBytes);
      }
    }
    expectMessage(() => validateBhwiPsbt(original.toBase64(), withParent(signed), fixture.wallet, signer), CHANGED);
  }

  const bodyMutations: Array<(transaction: bitcoin.Transaction) => void> = [
    transaction => {
      transaction.version++;
    },
    transaction => {
      required(transaction.ins[0]).hash = new Uint8Array(32).fill(92);
    },
    transaction => {
      required(transaction.ins[1]).index++;
    },
    transaction => {
      transaction.setInputScript(0, Uint8Array.of(0x53));
    },
    transaction => {
      required(transaction.ins[1]).sequence--;
    },
    transaction => {
      required(transaction.outs[0]).value--;
    },
    transaction => {
      required(transaction.outs[1]).value--;
    },
    transaction => {
      required(transaction.outs[0]).script = Uint8Array.of(0x51);
    },
    transaction => {
      required(transaction.outs[1]).script = Uint8Array.of(0x52);
    },
    transaction => {
      transaction.locktime++;
    },
  ];
  for (const mutate of bodyMutations) {
    const changedParent = strippedParent.clone();
    mutate(changedParent);
    expectMessage(
      () => validateBhwiPsbt(unsigned.toBase64(), withParent(partial, changedParent.toBuffer()), fixture.wallet, signer),
      CHANGED,
    );
  }
  for (const witness of [[Uint8Array.of(9), selected.publicKey], [selected.publicKey], []]) {
    const changedParent = parent.clone();
    changedParent.setWitness(0, witness);
    expectMessage(
      () => validateBhwiPsbt(unsigned.toBase64(), withParent(partial, changedParent.toBuffer()), fixture.wallet, signer),
      CHANGED,
    );
  }

  const noncanonicalReturnedParent = Buffer.concat([
    strippedParentBytes.subarray(0, 4),
    Buffer.from('fd0200', 'hex'),
    strippedParentBytes.subarray(5),
  ]);
  expectMessage(
    () => validateBhwiPsbt(unsigned.toBase64(), withParent(partial, noncanonicalReturnedParent), fixture.wallet, signer),
    CHANGED,
  );
  const noncanonicalOriginalParent = Buffer.concat([
    fullParentBytes.subarray(0, 6),
    Buffer.from('fd0200', 'hex'),
    fullParentBytes.subarray(7),
  ]);
  expectMessage(() => validateBhwiPsbtOriginal(withParent(unsigned, noncanonicalOriginalParent), fixture.wallet, signer), UNSUPPORTED);
  assert.deepStrictEqual(asBuffer(parent.toBuffer()), fullParentBytes);
  assert.deepStrictEqual(asBuffer(required(unsigned.data.inputs[0]?.nonWitnessUtxo)), fullParentBytes);
});

test('rejects changed unsigned transactions and immutable input metadata', () => {
  const fixture = makeSinglesigFixture();
  const changedTransaction = fixture.psbt.clone();
  changedTransaction.setLocktime(1).signInput(0, fixture.children[0]);
  expectMessage(() => validateBhwiPsbt(fixture.psbt.toBase64(), changedTransaction.toBase64(), fixture.wallet, fixture.signer), CHANGED);

  const added = fixture.psbt.clone();
  added.addUnknownKeyValToInput(0, {
    key: Uint8Array.of(0xfc, 1),
    value: Uint8Array.of(1),
  });
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

test('strictly validates original and signed PSBTs when subarray loses the Buffer prototype on Hermes', () => {
  const fixture = makeSinglesigFixture();
  fixture.psbt.addUnknownKeyValToGlobal({
    key: Uint8Array.of(0xfc, 1, 0x61, 0),
    value: Uint8Array.of(1),
  });
  const originalBase64 = fixture.psbt.toBase64();
  const returnedBase64 = fixture.psbt.clone().signInput(0, required(fixture.children[0])).toBase64();
  const buffer = Buffer.from(originalBase64, 'base64');
  const noncanonical = Buffer.concat([buffer.subarray(0, 5), Buffer.from('fd0100', 'hex'), buffer.subarray(6)]).toString('base64');
  const subarray = jest.spyOn<Buffer, 'subarray'>(Buffer.prototype, 'subarray').mockImplementation(function (
    this: Buffer,
    start?: number,
    end?: number,
  ) {
    return new Uint8Array(this.buffer, this.byteOffset, this.byteLength).subarray(start, end) as Buffer;
  });
  try {
    assert.strictEqual(Buffer.isBuffer(buffer.subarray(0, 1)), false);
    const validated = validateBhwiPsbtOriginal(originalBase64, fixture.wallet, fixture.signer);
    assert.strictEqual(validated.toBase64(), originalBase64);
    expectMessage(() => validateBhwiPsbtOriginal(noncanonical, fixture.wallet, fixture.signer), UNSUPPORTED);
    const result = validateBhwiPsbt(originalBase64, returnedBase64, fixture.wallet, fixture.signer);
    assert.ok(result.tx);
  } finally {
    subarray.mockRestore();
  }
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

test('hydrates immutable SegWit parents and rejects remote txid, vout, value, and script conflicts before signing', async () => {
  const fixture = makeSinglesigFixture();
  const source = fixture.psbt.clone();
  delete required(source.data.inputs[0]).nonWitnessUtxo;
  const parent = required(fixture.parents[0]);
  parent.setWitness(0, [Uint8Array.of(1, 2, 3), required(fixture.children[0]).publicKey]);
  const fetchParent = jest.fn(async () => ({
    [parent.getId()]: parent.toHex(),
  }));
  const hydrated = await hydrateBhwiPsbt(source, fetchParent);
  assert.strictEqual(source.data.inputs[0]?.nonWitnessUtxo, undefined);
  assert.ok(hydrated.data.inputs[0]?.nonWitnessUtxo);
  assert.strictEqual(Buffer.from(required(hydrated.data.inputs[0]?.nonWitnessUtxo)).toString('hex'), parent.toHex());
  assert.strictEqual(fetchParent.mock.calls.length, 1);
  validateBhwiPsbtOriginal(hydrated.toBase64(), fixture.wallet, fixture.signer);

  const wrongParent = makeParent(required(parent.outs[0]).script, required(parent.outs[0]).value, 201);
  await assert.rejects(
    hydrateBhwiPsbt(source, async () => ({
      [parent.getId()]: wrongParent.toHex(),
    })),
    error => error instanceof Error && error.message === UNSUPPORTED,
  );

  const missingVout = new bitcoin.Psbt({ network });
  const child = required(fixture.children[0]);
  const parentOutput = required(parent.outs[0]);
  missingVout.addInput({
    hash: parent.getId(),
    index: 1,
    witnessUtxo: { script: parentOutput.script, value: parentOutput.value },
    bip32Derivation: [
      {
        masterFingerprint: Buffer.from(fixture.signer.fingerprint, 'hex'),
        path: `${fixture.signer.path}/0/0`,
        pubkey: child.publicKey,
      },
    ],
  });
  missingVout.addOutput({
    script: parentOutput.script,
    value: parentOutput.value - 1n,
  });
  await assert.rejects(
    hydrateBhwiPsbt(missingVout, async () => ({
      [parent.getId()]: parent.toHex(),
    })),
    error => error instanceof Error && error.message === UNSUPPORTED,
  );

  const wrongValue = source.clone();
  const wrongValueInput = required(wrongValue.data.inputs[0]);
  const witness = required(wrongValueInput.witnessUtxo);
  wrongValueInput.witnessUtxo = { ...witness, value: witness.value - 1n };
  await assert.rejects(
    hydrateBhwiPsbt(wrongValue, async () => ({
      [parent.getId()]: parent.toHex(),
    })),
    error => error instanceof Error && error.message === UNSUPPORTED,
  );

  const wrongScript = source.clone();
  const wrongScriptInput = required(wrongScript.data.inputs[0]);
  wrongScriptInput.witnessUtxo = {
    ...required(wrongScriptInput.witnessUtxo),
    script: Uint8Array.of(0x51),
  };
  await assert.rejects(
    hydrateBhwiPsbt(wrongScript, async () => ({
      [parent.getId()]: parent.toHex(),
    })),
    error => error instanceof Error && error.message === UNSUPPORTED,
  );
});

test('the direct and route hardware-bound consumer accepts verified partial/full returns and rejects altered/raw returns', () => {
  const fixture = makeSinglesigFixture(2);
  const association = {
    ...fixture.signer,
    family: 'ledger' as const,
    format: 'native-segwit' as const,
  };
  const partial = fixture.psbt.clone();
  partial.signInput(0, required(fixture.children[0]));
  const partialResult = validateBhwiBoundPsbt(fixture.psbt.toBase64(), partial.toBase64(), fixture.wallet, association);
  assert.strictEqual(partialResult.tx, undefined);
  assert.ok(partialResult.psbt.data.inputs[0]?.finalScriptWitness);
  assert.strictEqual(partialResult.psbt.data.inputs[1]?.finalScriptWitness, undefined);
  assert.ok(partialResult.psbt.toBase64().length > 0);

  const full = fixture.psbt.clone();
  full.signInput(0, required(fixture.children[0]));
  full.signInput(1, required(fixture.children[1]));
  assert.ok(validateBhwiBoundPsbt(fixture.psbt.toBase64(), full.toBase64(), fixture.wallet, association).tx);

  const altered = fixture.psbt.clone();
  altered.setLocktime(1);
  altered.signInput(0, required(fixture.children[0]));
  expectMessage(() => validateBhwiBoundPsbt(fixture.psbt.toBase64(), altered.toBase64(), fixture.wallet, association), CHANGED);
  const rawTransaction = full.clone().finalizeAllInputs().extractTransaction().toHex();
  expectMessage(() => validateBhwiBoundPsbt(fixture.psbt.toBase64(), rawTransaction, fixture.wallet, association), CHANGED);
  expectMessage(() => validateBhwiBoundPsbt(undefined, full.toBase64(), fixture.wallet, association), BHWI_SIGNING_SESSION_EXPIRED);
});

test('rejects stale, backgrounded, deleted, edited, and replaced hardware signing snapshots', () => {
  const snapshot: BhwiPsbtAttemptSnapshot = {
    generation: 7,
    originalBase64: 'original',
    walletID: 'wallet',
    walletIdentity: 'wallet-identity',
    associationIdentity: 'association',
    policyIdentity: 'none',
    fee: '1000',
    cpfp: { parentFee: 100, parentVsize: 200, targetFeeRate: 5 },
  };
  assert.doesNotThrow(() => assertBhwiPsbtAttemptCurrent(snapshot, { ...snapshot }));
  for (const current of [
    undefined,
    { ...snapshot, generation: 8 },
    { ...snapshot, originalBase64: 'changed' },
    { ...snapshot, walletID: 'deleted' },
    { ...snapshot, walletIdentity: 'edited' },
    { ...snapshot, associationIdentity: 'replaced' },
    { ...snapshot, policyIdentity: 'changed-policy' },
    { ...snapshot, fee: '1001' },
    { ...snapshot, cpfp: { ...snapshot.cpfp!, parentFee: 101 } },
    { ...snapshot, cpfp: { ...snapshot.cpfp!, parentVsize: 201 } },
    { ...snapshot, cpfp: { ...snapshot.cpfp!, targetFeeRate: 4 } },
    { ...snapshot, cpfp: undefined },
  ]) {
    expectMessage(() => assertBhwiPsbtAttemptCurrent(snapshot, current), BHWI_SIGNING_SESSION_EXPIRED);
  }
});

test('rejects tokenless and stale associated multisig continuations', () => {
  assert.doesNotThrow(() => assertBhwiPsbtContinuationToken('qr-7', 'qr-7'));
  expectMessage(() => assertBhwiPsbtContinuationToken('qr-7', undefined), BHWI_SIGNING_SESSION_EXPIRED);
  expectMessage(() => assertBhwiPsbtContinuationToken('qr-7', 'qr-6'), BHWI_SIGNING_SESSION_EXPIRED);
});
