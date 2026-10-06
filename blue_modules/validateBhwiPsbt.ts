import BIP32Factory from 'bip32';
import type { BIP32Interface } from 'bip32';
import * as bitcoin from 'bitcoinjs-lib';
import { Buffer } from 'buffer';
import { decode, encodingLength } from 'varuint-bitcoin';

import type { Account as BhwiAccount } from '../codegen/NativeBhwi';
import { MultisigHDWallet } from '../class/wallets/multisig-hd-wallet';
import { WatchOnlyWallet } from '../class/wallets/watch-only-wallet';
import { convertExtendedKey } from '../class/wallets/extended-key';
import { isBhwiXpubAtPath, isCanonicalBhwiFingerprint, sameBhwiExtendedPublicKey } from './bhwi';
import ecc from './noble_ecc';
import { network, normalizeDerivationPath } from '../models/bitcoinNetwork';

bitcoin.initEccLib(ecc);
const bip32 = BIP32Factory(ecc);
const MAX_PSBT_BYTES = 2 * 1024 * 1024;
const MAX_MONEY = 2_100_000_000_000_000n;
const CHANGED = 'Hardware wallet changed the transaction';
const INVALID_SIGNATURE = 'Invalid hardware-wallet signature';
const UNSUPPORTED = 'Unsupported hardware-wallet signing input';
const NO_SIGNATURE = 'Hardware wallet returned no signature';
const STABLE_ERRORS: Partial<Record<string, true>> = {
  [CHANGED]: true,
  [INVALID_SIGNATURE]: true,
  [UNSUPPORTED]: true,
  [NO_SIGNATURE]: true,
};
const FINALIZER_CLEANUP_TYPES: Partial<Record<number, true>> = {
  0x02: true,
  0x03: true,
  0x04: true,
  0x05: true,
  0x06: true,
  0x09: true,
  0x0a: true,
  0x0b: true,
  0x0c: true,
  0x0d: true,
  0x13: true,
  0x14: true,
  0x15: true,
  0x16: true,
  0x17: true,
  0x18: true,
};

type BhwiSigner = Pick<BhwiAccount, 'fingerprint' | 'path' | 'xpub'>;

export type BhwiPsbtValidationResult = {
  psbt: bitcoin.Psbt;
  tx?: bitcoin.Transaction;
  continuationPsbt: bitcoin.Psbt;
  selectedSignerSignedAllInputs: boolean;
};
type PsbtInput = bitcoin.Psbt['data']['inputs'][number];
type RawKeyValue = { key: Buffer; value: Buffer; id: string };
type RawPsbt = {
  maps: RawKeyValue[][];
  unsignedTx: Buffer;
  transaction: bitcoin.Transaction;
  psbt: bitcoin.Psbt;
};
type InputKind = 'pkh' | 'sh-wpkh' | 'wpkh' | 'tr' | 'sh-multi' | 'sh-wsh-multi' | 'wsh-multi';
type InputContext = {
  kind: InputKind;
  prevout: { script: Uint8Array; value: bigint };
  redeemScript?: Uint8Array;
  witnessScript?: Uint8Array;
  pubkeys?: Uint8Array[];
  threshold?: number;
  selectedPubkey?: Uint8Array;
};
type SignerBinding = {
  fingerprint: string;
  path: string;
  node: BIP32Interface;
  wallet: WatchOnlyWallet | MultisigHDWallet;
};
type Preflight = {
  raw: RawPsbt;
  contexts: InputContext[];
  fee: bigint;
};

function unsupported(): never {
  throw new Error(UNSUPPORTED);
}
function changed(): never {
  throw new Error(CHANGED);
}
function invalidSignature(): never {
  throw new Error(INVALID_SIGNATURE);
}
function noSignature(): never {
  throw new Error(NO_SIGNATURE);
}
const equal = (left: Uint8Array | undefined, right: Uint8Array | undefined): boolean =>
  left === undefined || right === undefined
    ? left === right
    : left.length === right.length && left.every((byte, index) => byte === right[index]);
const compareBytes = (left: Uint8Array, right: Uint8Array): number => {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
};
const fingerprintHex = (fingerprint: Uint8Array): string => Buffer.from(fingerprint).toString('hex');

function decodeBase64Bounded(value: string): Buffer {
  if (value.length === 0 || value.length > Math.ceil(MAX_PSBT_BYTES / 3) * 4 || value.length % 4 !== 0) unsupported();
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) unsupported();
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const decodedLength = (value.length / 4) * 3 - padding;
  if (decodedLength > MAX_PSBT_BYTES) unsupported();
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  if (padding === 2 && alphabet.indexOf(value[value.length - 3]) % 16 !== 0) unsupported();
  if (padding === 1 && alphabet.indexOf(value[value.length - 2]) % 4 !== 0) unsupported();
  const result = Buffer.from(value, 'base64');
  if (result.length !== decodedLength) unsupported();
  return result;
}

function readCompactSize(buffer: Buffer, offset: number): { value: number; offset: number } {
  if (offset >= buffer.length) unsupported();
  const first = buffer[offset];
  const bytes = first < 0xfd ? 1 : first === 0xfd ? 3 : first === 0xfe ? 5 : 9;
  if (offset + bytes > buffer.length) unsupported();
  let value: number | undefined;
  try {
    value = decode(buffer, offset);
  } catch {
    unsupported();
  }
  if (value === undefined || decode.bytes !== bytes || encodingLength(value) !== bytes) unsupported();
  return { value, offset: offset + bytes };
}

function assertCanonicalTransactionEncoding(buffer: Buffer, unsigned: boolean): void {
  if (buffer.length < 10) unsupported();
  let offset = 4;
  let hasWitness = false;
  if (buffer[offset] === 0) {
    if (unsigned || offset + 2 > buffer.length || buffer[offset + 1] !== 1) unsupported();
    hasWitness = true;
    offset += 2;
  }
  const inputs = readCompactSize(buffer, offset);
  if (inputs.value === 0) unsupported();
  offset = inputs.offset;
  for (let index = 0; index < inputs.value; index++) {
    if (buffer.length - offset < 36) unsupported();
    offset += 36;
    const script = readCompactSize(buffer, offset);
    if (unsigned && script.value !== 0) unsupported();
    offset = script.offset;
    if (script.value > buffer.length - offset - 4) unsupported();
    offset += script.value + 4;
  }
  const outputs = readCompactSize(buffer, offset);
  if (outputs.value === 0) unsupported();
  offset = outputs.offset;
  for (let index = 0; index < outputs.value; index++) {
    if (buffer.length - offset < 8) unsupported();
    offset += 8;
    const script = readCompactSize(buffer, offset);
    offset = script.offset;
    if (script.value > buffer.length - offset) unsupported();
    offset += script.value;
  }
  if (hasWitness) {
    for (let index = 0; index < inputs.value; index++) {
      const items = readCompactSize(buffer, offset);
      offset = items.offset;
      for (let item = 0; item < items.value; item++) {
        const value = readCompactSize(buffer, offset);
        offset = value.offset;
        if (value.value > buffer.length - offset) unsupported();
        offset += value.value;
      }
    }
  }
  if (buffer.length - offset !== 4) unsupported();
}

function readMap(buffer: Buffer, start: number): { entries: RawKeyValue[]; offset: number } {
  const entries: RawKeyValue[] = [];
  const keys = new Set<string>();
  let offset = start;
  for (;;) {
    const keySize = readCompactSize(buffer, offset);
    offset = keySize.offset;
    if (keySize.value === 0) return { entries, offset };
    if (keySize.value > buffer.length - offset) unsupported();
    const key = buffer.subarray(offset, offset + keySize.value);
    offset += keySize.value;
    const valueSize = readCompactSize(buffer, offset);
    offset = valueSize.offset;
    if (valueSize.value > buffer.length - offset) unsupported();
    const value = buffer.subarray(offset, offset + valueSize.value);
    offset += valueSize.value;
    const id = key.toString('latin1');
    if (keys.has(id)) unsupported();
    keys.add(id);
    entries.push({ key, value, id });
  }
}

function assertTapDerivationEncoding(value: Buffer): void {
  const hashes = readCompactSize(value, 0);
  if (hashes.value > Math.floor((value.length - hashes.offset) / 32)) unsupported();
  const originOffset = hashes.offset + hashes.value * 32;
  if (originOffset + 4 > value.length || (value.length - originOffset - 4) % 4 !== 0) unsupported();
}

function assertCanonicalEmbeddedLengths(maps: RawKeyValue[][], inputCount: number): void {
  for (const map of maps) {
    for (const entry of map) {
      if (entry.key[0] !== 0xfc) continue;
      const identifier = readCompactSize(entry.key, 1);
      if (identifier.value > entry.key.length - identifier.offset - 1) unsupported();
    }
  }
  for (let index = 0; index < inputCount; index++) {
    const map = maps[index + 1];
    if (!map) unsupported();
    for (const entry of map) {
      if (entry.key[0] >= 0x0e && entry.key[0] <= 0x12) unsupported();
      if (entry.key.length === 1 && entry.key[0] === 0x01) {
        if (entry.value.length < 9) unsupported();
        const script = readCompactSize(entry.value, 8);
        if (script.value !== entry.value.length - script.offset) unsupported();
      } else if (entry.key[0] === 0x16) {
        assertTapDerivationEncoding(entry.value);
      }
    }
  }
  for (let index = inputCount + 1; index < maps.length; index++) {
    const map = maps[index];
    if (!map) unsupported();
    for (const entry of map) {
      if (entry.key[0] === 0x03 || entry.key[0] === 0x04) unsupported();
      if (entry.key[0] === 0x07) {
        assertTapDerivationEncoding(entry.value);
      } else if (entry.key.length === 1 && entry.key[0] === 0x06) {
        let offset = 0;
        while (offset < entry.value.length) {
          if (entry.value.length - offset < 3) unsupported();
          const script = readCompactSize(entry.value, offset + 2);
          offset = script.offset + script.value;
          if (offset > entry.value.length) unsupported();
        }
      }
    }
  }
}

function parseStrictPsbt(base64: string): RawPsbt {
  const buffer = decodeBase64Bounded(base64);
  if (buffer.length < 6 || !equal(buffer.subarray(0, 5), Uint8Array.of(0x70, 0x73, 0x62, 0x74, 0xff))) unsupported();
  const global = readMap(buffer, 5);
  const unsignedEntries = global.entries.filter(entry => entry.key.length === 1 && entry.key[0] === 0x00);
  if (unsignedEntries.length !== 1 || global.entries.some(entry => entry.key[0] === 0x00 && entry.key.length !== 1)) unsupported();
  for (const entry of global.entries) {
    if (entry.key[0] >= 0x02 && entry.key[0] <= 0x07) unsupported();
    if (entry.key[0] === 0xfb) {
      if (entry.key.length !== 1 || entry.value.length !== 4 || entry.value.some(byte => byte !== 0)) unsupported();
    }
  }
  const unsignedEntry = unsignedEntries[0];
  if (!unsignedEntry) unsupported();
  const unsignedTx = unsignedEntry.value;
  assertCanonicalTransactionEncoding(unsignedTx, true);
  let transaction: bitcoin.Transaction | undefined;
  try {
    transaction = bitcoin.Transaction.fromBuffer(unsignedTx);
  } catch {
    unsupported();
  }
  if (
    !transaction ||
    transaction.ins.length === 0 ||
    transaction.outs.length === 0 ||
    transaction.ins.some(input => input.script.length !== 0 || input.witness.length !== 0)
  ) {
    unsupported();
  }
  const maps = [global.entries];
  let offset = global.offset;
  for (let index = 0; index < transaction.ins.length + transaction.outs.length; index++) {
    const map = readMap(buffer, offset);
    maps.push(map.entries);
    offset = map.offset;
  }
  if (offset !== buffer.length) unsupported();
  assertCanonicalEmbeddedLengths(maps, transaction.ins.length);
  let psbt: bitcoin.Psbt | undefined;
  try {
    psbt = bitcoin.Psbt.fromBuffer(buffer, { network });
  } catch {
    unsupported();
  }
  if (!psbt || psbt.inputCount !== transaction.ins.length || psbt.data.outputs.length !== transaction.outs.length) unsupported();
  return { maps, unsignedTx, transaction, psbt };
}

function bindSigner(wallet: WatchOnlyWallet | MultisigHDWallet, signer: BhwiSigner): SignerBinding {
  if (!isCanonicalBhwiFingerprint(signer.fingerprint) || signer.path !== normalizeDerivationPath(signer.path)) unsupported();
  if (!isBhwiXpubAtPath(signer.xpub, signer.path)) unsupported();
  if (wallet instanceof WatchOnlyWallet) {
    if (
      !wallet.isHd() ||
      wallet.getMasterFingerprintHex() !== signer.fingerprint ||
      wallet.getDerivationPath() !== signer.path ||
      !sameBhwiExtendedPublicKey(wallet.getSecret(), signer.xpub)
    ) {
      unsupported();
    }
  } else if (wallet instanceof MultisigHDWallet) {
    const matches = wallet
      .getPublicCosigners()
      .filter(
        cosigner =>
          cosigner.fingerprint === signer.fingerprint &&
          cosigner.path === signer.path &&
          sameBhwiExtendedPublicKey(cosigner.xpub, signer.xpub),
      );
    if (matches.length !== 1) unsupported();
  } else {
    unsupported();
  }
  let node: BIP32Interface | undefined;
  try {
    node = bip32.fromBase58(convertExtendedKey(signer.xpub, 'legacy'), network);
  } catch {
    unsupported();
  }
  if (!node) unsupported();
  return { fingerprint: signer.fingerprint, path: signer.path, node, wallet };
}

function isP2pkh(script: Uint8Array): boolean {
  return (
    script.length === 25 && script[0] === 0x76 && script[1] === 0xa9 && script[2] === 0x14 && script[23] === 0x88 && script[24] === 0xac
  );
}
function isP2sh(script: Uint8Array): boolean {
  return script.length === 23 && script[0] === 0xa9 && script[1] === 0x14 && script[22] === 0x87;
}
function isP2wpkh(script: Uint8Array): boolean {
  return script.length === 22 && script[0] === 0x00 && script[1] === 0x14;
}
function isP2wsh(script: Uint8Array): boolean {
  return script.length === 34 && script[0] === 0x00 && script[1] === 0x20;
}
function isP2tr(script: Uint8Array): boolean {
  return script.length === 34 && script[0] === 0x51 && script[1] === 0x20;
}
function hashMatches(script: Uint8Array, expected: Uint8Array, sha256: boolean): boolean {
  const digest = sha256 ? bitcoin.crypto.sha256(script) : bitcoin.crypto.hash160(script);
  return equal(digest, expected);
}

function parseMultisig(script: Uint8Array): { threshold: number; pubkeys: Uint8Array[] } | undefined {
  const chunks = bitcoin.script.decompile(script);
  if (
    !chunks ||
    !equal(bitcoin.script.compile(chunks), script) ||
    chunks.length < 4 ||
    chunks[chunks.length - 1] !== bitcoin.opcodes.OP_CHECKMULTISIG
  ) {
    return undefined;
  }
  const first = chunks[0];
  const last = chunks[chunks.length - 2];
  if (typeof first !== 'number' || typeof last !== 'number') return undefined;
  const threshold = first - bitcoin.opcodes.OP_1 + 1;
  const count = last - bitcoin.opcodes.OP_1 + 1;
  const scriptPubkeys = chunks.slice(1, -2);
  if (threshold < 1 || count < threshold || count > 16 || scriptPubkeys.length !== count) return undefined;
  const pubkeys: Uint8Array[] = [];
  for (const chunk of scriptPubkeys) {
    if (!(chunk instanceof Uint8Array) || chunk.length !== 33 || !ecc.isPoint(chunk)) return undefined;
    pubkeys.push(chunk);
  }
  for (let index = 1; index < pubkeys.length; index++) {
    const previous = pubkeys[index - 1];
    const current = pubkeys[index];
    if (!previous || !current || compareBytes(previous, current) >= 0) return undefined;
  }
  return { threshold, pubkeys };
}

function classifyInput(input: PsbtInput, prevout: { script: Uint8Array; value: bigint }): InputContext {
  const script = prevout.script;
  if (isP2pkh(script)) {
    if (input.redeemScript || input.witnessScript) unsupported();
    return { kind: 'pkh', prevout };
  }
  if (isP2wpkh(script)) {
    if (input.redeemScript || input.witnessScript) unsupported();
    return { kind: 'wpkh', prevout };
  }
  if (isP2tr(script)) {
    if (input.redeemScript || input.witnessScript) unsupported();
    return { kind: 'tr', prevout };
  }
  if (isP2wsh(script)) {
    const witnessScript = input.witnessScript;
    if (input.redeemScript || !witnessScript || !hashMatches(witnessScript, script.subarray(2), true)) unsupported();
    const multisig = parseMultisig(witnessScript);
    if (!multisig) unsupported();
    return { kind: 'wsh-multi', prevout, witnessScript, pubkeys: multisig.pubkeys, threshold: multisig.threshold };
  }
  if (isP2sh(script)) {
    const redeemScript = input.redeemScript;
    if (!redeemScript || !hashMatches(redeemScript, script.subarray(2, 22), false)) unsupported();
    if (isP2wpkh(redeemScript)) {
      if (input.witnessScript) unsupported();
      return { kind: 'sh-wpkh', prevout, redeemScript };
    }
    if (isP2wsh(redeemScript)) {
      const witnessScript = input.witnessScript;
      if (!witnessScript || !hashMatches(witnessScript, redeemScript.subarray(2), true)) unsupported();
      const multisig = parseMultisig(witnessScript);
      if (!multisig) unsupported();
      return {
        kind: 'sh-wsh-multi',
        prevout,
        redeemScript,
        witnessScript,
        pubkeys: multisig.pubkeys,
        threshold: multisig.threshold,
      };
    }
    if (input.witnessScript) unsupported();
    const multisig = parseMultisig(redeemScript);
    if (!multisig) unsupported();
    return { kind: 'sh-multi', prevout, redeemScript, pubkeys: multisig.pubkeys, threshold: multisig.threshold };
  }
  return unsupported();
}

function childCoordinates(path: string, accountPath: string): { branch: 0 | 1; index: number } | undefined {
  if (!path.startsWith(`${accountPath}/`)) return undefined;
  const components = path.slice(accountPath.length + 1).split('/');
  if (components.length !== 2 || (components[0] !== '0' && components[0] !== '1') || !/^(0|[1-9]\d*)$/.test(components[1])) {
    return undefined;
  }
  const index = Number(components[1]);
  if (!Number.isSafeInteger(index) || index > 0x7fffffff) return undefined;
  return { branch: Number(components[0]) as 0 | 1, index };
}

function expectedSinglesigScript(
  wallet: WatchOnlyWallet,
  pubkey: Uint8Array,
): { kind: InputKind; output?: Uint8Array; redeem?: Uint8Array } {
  switch (wallet.segwitType) {
    case 'p2pkh': {
      const payment = bitcoin.payments.p2pkh({ pubkey, network });
      return { kind: 'pkh', output: payment.output };
    }
    case 'p2sh(p2wpkh)': {
      const payment = bitcoin.payments.p2sh({ redeem: bitcoin.payments.p2wpkh({ pubkey, network }), network });
      return { kind: 'sh-wpkh', output: payment.output, redeem: payment.redeem?.output };
    }
    case 'p2wpkh': {
      const payment = bitcoin.payments.p2wpkh({ pubkey, network });
      return { kind: 'wpkh', output: payment.output };
    }
    case 'p2tr': {
      const payment = bitcoin.payments.p2tr({ internalPubkey: pubkey.subarray(1), network });
      return { kind: 'tr', output: payment.output };
    }
    default:
      return unsupported();
  }
}

function attachSelectedPolicy(context: InputContext, input: PsbtInput, binding: SignerBinding): void {
  const derivations = context.kind === 'tr' ? (input.tapBip32Derivation ?? []) : (input.bip32Derivation ?? []);
  for (const derivation of derivations) {
    const fingerprintMatches = fingerprintHex(derivation.masterFingerprint) === binding.fingerprint;
    const coordinates = childCoordinates(derivation.path, binding.path);
    if (fingerprintMatches && !coordinates) unsupported();
    if (!coordinates) continue;
    const pubkey = binding.node.derive(coordinates.branch).derive(coordinates.index).publicKey;
    const expectedKey = context.kind === 'tr' ? pubkey.subarray(1) : pubkey;
    if (!fingerprintMatches && !equal(derivation.pubkey, expectedKey)) continue;
    if (!fingerprintMatches || !equal(derivation.pubkey, expectedKey)) unsupported();
    if (context.selectedPubkey) unsupported();

    if (binding.wallet instanceof WatchOnlyWallet) {
      const expected = expectedSinglesigScript(binding.wallet, pubkey);
      if (
        context.kind !== expected.kind ||
        !equal(context.prevout.script, expected.output) ||
        !equal(context.redeemScript, expected.redeem)
      ) {
        unsupported();
      }
      if (context.kind === 'tr') {
        if (!equal(input.tapInternalKey, expectedKey)) unsupported();
      }
    } else {
      if (context.kind === 'tr') unsupported();
      const cosigners = binding.wallet.getPublicCosigners();
      const derived = cosigners.map(cosigner => {
        if (!isBhwiXpubAtPath(cosigner.xpub, cosigner.path)) unsupported();
        const node = bip32.fromBase58(convertExtendedKey(cosigner.xpub, 'legacy'), network);
        const child = node.derive(coordinates.branch).derive(coordinates.index).publicKey;
        const path = `${cosigner.path}/${coordinates.branch}/${coordinates.index}`;
        const matches = (input.bip32Derivation ?? []).filter(
          item => item.path === path && fingerprintHex(item.masterFingerprint) === cosigner.fingerprint && equal(item.pubkey, child),
        );
        if (matches.length !== 1) unsupported();
        return child;
      });
      const sorted = [...derived].sort(compareBytes);
      const p2ms = bitcoin.payments.p2ms({ m: binding.wallet.getM(), pubkeys: sorted, network });
      if (!p2ms.output) unsupported();
      let expectedKind: InputKind | undefined;
      let expectedOutput: Uint8Array | undefined;
      let expectedRedeem: Uint8Array | undefined;
      let expectedWitness: Uint8Array | undefined;
      if (binding.wallet.isLegacy()) {
        const payment = bitcoin.payments.p2sh({ redeem: p2ms, network });
        expectedKind = 'sh-multi';
        expectedOutput = payment.output;
        expectedRedeem = p2ms.output;
      } else if (binding.wallet.isWrappedSegwit()) {
        const payment = bitcoin.payments.p2sh({ redeem: bitcoin.payments.p2wsh({ redeem: p2ms, network }), network });
        expectedKind = 'sh-wsh-multi';
        expectedOutput = payment.output;
        expectedRedeem = payment.redeem?.output;
        expectedWitness = p2ms.output;
      } else if (binding.wallet.isNativeSegwit()) {
        const payment = bitcoin.payments.p2wsh({ redeem: p2ms, network });
        expectedKind = 'wsh-multi';
        expectedOutput = payment.output;
        expectedWitness = p2ms.output;
      } else {
        unsupported();
      }
      if (!expectedKind || !expectedOutput) unsupported();
      if (
        context.kind !== expectedKind ||
        context.threshold !== binding.wallet.getM() ||
        !equal(context.prevout.script, expectedOutput) ||
        !equal(context.redeemScript, expectedRedeem) ||
        !equal(context.witnessScript, expectedWitness)
      ) {
        unsupported();
      }
    }
    context.selectedPubkey = expectedKey;
  }
}

function assertTaprootFields(input: PsbtInput, context: InputContext): void {
  if (context.kind === 'tr') {
    if (input.partialSig?.length || input.tapScriptSig?.length || input.tapLeafScript?.length || input.tapMerkleRoot) unsupported();
    if (input.tapBip32Derivation?.some(derivation => derivation.leafHashes.length !== 0)) unsupported();
    if (input.tapInternalKey) {
      const payment = bitcoin.payments.p2tr({ internalPubkey: input.tapInternalKey, network });
      if (!equal(payment.output, context.prevout.script)) unsupported();
    }
    if (
      input.sighashType !== undefined &&
      input.sighashType !== bitcoin.Transaction.SIGHASH_DEFAULT &&
      input.sighashType !== bitcoin.Transaction.SIGHASH_ALL
    ) {
      unsupported();
    }
  } else {
    if (
      input.tapKeySig ||
      input.tapScriptSig?.length ||
      input.tapLeafScript?.length ||
      input.tapBip32Derivation?.length ||
      input.tapInternalKey ||
      input.tapMerkleRoot
    ) {
      unsupported();
    }
    if (input.sighashType !== undefined && input.sighashType !== bitcoin.Transaction.SIGHASH_ALL) unsupported();
  }
}

function assertSignatureSighashes(input: PsbtInput, context: InputContext): number | undefined {
  if (context.kind === 'tr') {
    const signature = input.tapKeySig;
    if (!signature) return undefined;
    if (signature.length !== 64 && signature.length !== 65) invalidSignature();
    const observed = signature.length === 64 ? bitcoin.Transaction.SIGHASH_DEFAULT : signature[64];
    if (observed === undefined) invalidSignature();
    if (
      (signature.length === 65 && observed === bitcoin.Transaction.SIGHASH_DEFAULT) ||
      (observed !== bitcoin.Transaction.SIGHASH_DEFAULT && observed !== bitcoin.Transaction.SIGHASH_ALL) ||
      (input.sighashType !== undefined && input.sighashType !== observed)
    ) {
      invalidSignature();
    }
    return observed;
  }
  for (const partial of input.partialSig ?? []) {
    let observed: number | undefined;
    try {
      observed = bitcoin.script.signature.decode(partial.signature).hashType;
    } catch {
      invalidSignature();
    }
    if (
      observed === undefined ||
      observed !== bitcoin.Transaction.SIGHASH_ALL ||
      (input.sighashType !== undefined && input.sighashType !== observed)
    ) {
      invalidSignature();
    }
  }
  return undefined;
}

const signatureValidator = (pubkey: Uint8Array, hash: Uint8Array, signature: Uint8Array): boolean => {
  if (pubkey.length !== 32) return ecc.verify(hash, pubkey, signature, true);
  const verifySchnorr = ecc.verifySchnorr;
  if (!verifySchnorr) return false;
  return verifySchnorr(hash, pubkey, signature);
};

function validatePresentSignatures(psbt: bitcoin.Psbt, index: number, context: InputContext): void {
  const input = psbt.data.inputs[index];
  if (!input) invalidSignature();
  const observedSighash = assertSignatureSighashes(input, context);
  if (!(input.partialSig?.length || input.tapKeySig)) return;
  let verificationPsbt = psbt;
  if (
    context.kind === 'tr' &&
    input.tapKeySig &&
    input.sighashType === undefined &&
    observedSighash !== bitcoin.Transaction.SIGHASH_DEFAULT
  ) {
    if (observedSighash === undefined) invalidSignature();
    verificationPsbt = psbt.clone();
    verificationPsbt.updateInput(index, { sighashType: observedSighash });
  }
  try {
    if (!verificationPsbt.validateSignaturesOfInput(index, signatureValidator)) invalidSignature();
  } catch (error) {
    if (error instanceof Error && error.message === INVALID_SIGNATURE) throw error;
    invalidSignature();
  }
}

function preflight(originalBase64: string, wallet: WatchOnlyWallet | MultisigHDWallet, signer: BhwiSigner): Preflight {
  const binding = bindSigner(wallet, signer);
  const raw = parseStrictPsbt(originalBase64);
  const seenOutpoints = new Set<string>();
  const contexts: InputContext[] = [];
  let inputTotal = 0n;
  let outputTotal = 0n;

  for (const output of raw.transaction.outs) {
    if (output.value < 0n || output.value > MAX_MONEY) unsupported();
    outputTotal += output.value;
    if (outputTotal > MAX_MONEY) unsupported();
  }
  for (const [index, txInput] of raw.transaction.ins.entries()) {
    const input = raw.psbt.data.inputs[index];
    if (!input) unsupported();
    if (input.finalScriptSig || input.finalScriptWitness) unsupported();
    const outpoint = `${Buffer.from(txInput.hash).toString('hex')}:${txInput.index}`;
    if (seenOutpoints.has(outpoint) || (bitcoin.Transaction.isCoinbaseHash(txInput.hash) && txInput.index === 0xffffffff)) unsupported();
    seenOutpoints.add(outpoint);

    let prevout: { script: Uint8Array; value: bigint } | undefined;
    if (input.nonWitnessUtxo) {
      const previousBuffer = Buffer.from(input.nonWitnessUtxo.buffer, input.nonWitnessUtxo.byteOffset, input.nonWitnessUtxo.byteLength);
      assertCanonicalTransactionEncoding(previousBuffer, false);
      let previous: bitcoin.Transaction | undefined;
      try {
        previous = bitcoin.Transaction.fromBuffer(previousBuffer);
      } catch {
        unsupported();
      }
      if (!previous || !equal(previous.getHash(), txInput.hash) || txInput.index >= previous.outs.length) unsupported();
      const previousOutput = previous.outs[txInput.index];
      if (!previousOutput) unsupported();
      prevout = previousOutput;
    }
    const witnessUtxo = input.witnessUtxo;
    if (witnessUtxo) {
      if (prevout && (!equal(prevout.script, witnessUtxo.script) || prevout.value !== witnessUtxo.value)) unsupported();
      prevout = witnessUtxo;
    }
    if (!prevout || prevout.value < 0n || prevout.value > MAX_MONEY) unsupported();
    const validatedPrevout = prevout;
    inputTotal += validatedPrevout.value;
    if (inputTotal > MAX_MONEY) unsupported();

    const context = classifyInput(input, validatedPrevout);
    if ((context.kind === 'pkh' || context.kind === 'sh-multi') && !input.nonWitnessUtxo) unsupported();
    assertTaprootFields(input, context);
    attachSelectedPolicy(context, input, binding);
    contexts.push(context);
  }
  if (!contexts.some(context => context.selectedPubkey)) unsupported();
  if (inputTotal < outputTotal) unsupported();
  const fee = inputTotal - outputTotal;
  if (fee < 0n || fee > MAX_MONEY) unsupported();
  for (const [index, context] of contexts.entries()) validatePresentSignatures(raw.psbt, index, context);
  return { raw, contexts, fee };
}

/** Strictly validates a PSBT before it is sent to a hardware or phone signer. */
export function validateBhwiPsbtOriginal(
  originalBase64: string,
  wallet: WatchOnlyWallet | MultisigHDWallet,
  signer: BhwiSigner,
): bitcoin.Psbt {
  try {
    return preflight(originalBase64, wallet, signer).raw.psbt;
  } catch (error) {
    if (error instanceof Error && STABLE_ERRORS[error.message] === true) throw error;
    return unsupported();
  }
}

function indexMap(map: RawKeyValue[]): Map<string, RawKeyValue> {
  const result = new Map<string, RawKeyValue>();
  for (const entry of map) result.set(entry.id, entry);
  return result;
}
function compareExactMap(original: RawKeyValue[], returned: RawKeyValue[]): void {
  if (original.length !== returned.length) changed();
  const returnedByKey = indexMap(returned);
  for (const entry of original) {
    const candidate = returnedByKey.get(entry.id);
    if (!candidate || !equal(entry.key, candidate.key) || !equal(entry.value, candidate.value)) changed();
  }
}
function compareInputMap(original: RawKeyValue[], returned: RawKeyValue[]): boolean {
  const originalByKey = indexMap(original);
  const returnedByKey = indexMap(returned);
  const finalized = returned.some(entry => entry.key.length === 1 && (entry.key[0] === 0x07 || entry.key[0] === 0x08));
  for (const entry of original) {
    const candidate = returnedByKey.get(entry.id);
    if (!candidate) {
      if (!finalized || !FINALIZER_CLEANUP_TYPES[entry.key[0]]) changed();
    } else if (!equal(entry.value, candidate.value)) {
      changed();
    }
  }
  for (const entry of returned) {
    if (originalByKey.has(entry.id)) continue;
    const type = entry.key[0];
    if (type !== 0x02 && type !== 0x13 && (!finalized || (type !== 0x07 && type !== 0x08))) changed();
  }
  return finalized;
}

function readWitness(serialized: Uint8Array): Uint8Array[] {
  const buffer = Buffer.from(serialized.buffer, serialized.byteOffset, serialized.byteLength);
  let count: { value: number; offset: number } | undefined;
  try {
    count = readCompactSize(buffer, 0);
  } catch {
    invalidSignature();
  }
  if (!count || count.value > 18) invalidSignature();
  const stack: Uint8Array[] = [];
  let offset = count.offset;
  for (let index = 0; index < count.value; index++) {
    let size: { value: number; offset: number } | undefined;
    try {
      size = readCompactSize(buffer, offset);
    } catch {
      invalidSignature();
    }
    if (!size) invalidSignature();
    offset = size.offset;
    if (size.value > buffer.length - offset) invalidSignature();
    stack.push(buffer.subarray(offset, offset + size.value));
    offset += size.value;
  }
  if (offset !== buffer.length) invalidSignature();
  return stack;
}

function decodeScriptStack(script: Uint8Array): Array<number | Uint8Array> {
  const chunks = bitcoin.script.decompile(script);
  if (!chunks) invalidSignature();
  return chunks;
}

function signatureHash(transaction: bitcoin.Transaction, index: number, context: InputContext, pubkey: Uint8Array): Uint8Array {
  switch (context.kind) {
    case 'pkh':
      return transaction.hashForSignature(index, context.prevout.script, bitcoin.Transaction.SIGHASH_ALL);
    case 'sh-multi': {
      const redeemScript = context.redeemScript;
      if (!redeemScript) invalidSignature();
      return transaction.hashForSignature(index, redeemScript, bitcoin.Transaction.SIGHASH_ALL);
    }
    case 'wpkh':
    case 'sh-wpkh': {
      const script = bitcoin.payments.p2pkh({ pubkey, network }).output;
      if (!script) invalidSignature();
      return transaction.hashForWitnessV0(index, script, context.prevout.value, bitcoin.Transaction.SIGHASH_ALL);
    }
    case 'wsh-multi':
    case 'sh-wsh-multi': {
      const witnessScript = context.witnessScript;
      if (!witnessScript) invalidSignature();
      return transaction.hashForWitnessV0(index, witnessScript, context.prevout.value, bitcoin.Transaction.SIGHASH_ALL);
    }
    default:
      return invalidSignature();
  }
}

function orderedMultisigSignatures(
  signatures: Uint8Array[],
  context: InputContext,
  transaction: bitcoin.Transaction,
  index: number,
  requestedSighash: number | undefined,
): Array<{ pubkey: Uint8Array; signature: Uint8Array }> {
  const pubkeys = context.pubkeys;
  if (!pubkeys || signatures.length !== context.threshold) invalidSignature();
  const result: Array<{ pubkey: Uint8Array; signature: Uint8Array }> = [];
  let pubkeyIndex = 0;
  for (const signature of signatures) {
    let decoded: { hashType: number; signature: Uint8Array } | undefined;
    try {
      decoded = bitcoin.script.signature.decode(signature);
    } catch {
      invalidSignature();
    }
    if (
      !decoded ||
      decoded.hashType !== bitcoin.Transaction.SIGHASH_ALL ||
      (requestedSighash !== undefined && requestedSighash !== decoded.hashType)
    ) {
      invalidSignature();
    }
    let matched = false;
    while (pubkeyIndex < pubkeys.length) {
      const pubkey = pubkeys[pubkeyIndex++];
      if (!pubkey) invalidSignature();
      const hash = signatureHash(transaction, index, context, pubkey);
      if (ecc.verify(hash, pubkey, decoded.signature, true)) {
        result.push({ pubkey, signature });
        matched = true;
        break;
      }
    }
    if (!matched) invalidSignature();
  }
  return result;
}

function extractFinalSignatures(
  input: PsbtInput,
  context: InputContext,
  transaction: bitcoin.Transaction,
  index: number,
): { partialSig?: Array<{ pubkey: Uint8Array; signature: Uint8Array }>; tapKeySig?: Uint8Array } {
  const scriptSig = input.finalScriptSig;
  const witness = input.finalScriptWitness ? readWitness(input.finalScriptWitness) : undefined;
  switch (context.kind) {
    case 'pkh': {
      if (!scriptSig || witness) invalidSignature();
      const stack = decodeScriptStack(scriptSig);
      const signature = stack[0];
      const pubkey = stack[1];
      if (stack.length !== 2 || !(signature instanceof Uint8Array) || !(pubkey instanceof Uint8Array)) invalidSignature();
      return { partialSig: [{ signature, pubkey }] };
    }
    case 'sh-wpkh': {
      if (!scriptSig || !witness || witness.length !== 2) invalidSignature();
      const stack = decodeScriptStack(scriptSig);
      const redeemScript = stack[0];
      const signature = witness[0];
      const pubkey = witness[1];
      if (
        stack.length !== 1 ||
        !(redeemScript instanceof Uint8Array) ||
        !equal(redeemScript, context.redeemScript) ||
        !signature ||
        !pubkey
      ) {
        invalidSignature();
      }
      return { partialSig: [{ signature, pubkey }] };
    }
    case 'wpkh': {
      if (scriptSig || !witness || witness.length !== 2) invalidSignature();
      const signature = witness[0];
      const pubkey = witness[1];
      if (!signature || !pubkey) invalidSignature();
      return { partialSig: [{ signature, pubkey }] };
    }
    case 'tr': {
      if (scriptSig || !witness || witness.length !== 1) invalidSignature();
      const tapKeySig = witness[0];
      if (!tapKeySig) invalidSignature();
      return { tapKeySig };
    }
    case 'sh-multi': {
      if (!scriptSig || witness) invalidSignature();
      const stack = decodeScriptStack(scriptSig);
      const first = stack[0];
      const last = stack[stack.length - 1];
      if (
        (first !== bitcoin.opcodes.OP_0 && !(first instanceof Uint8Array && first.length === 0)) ||
        !(last instanceof Uint8Array) ||
        !equal(last, context.redeemScript)
      ) {
        invalidSignature();
      }
      const signatures: Uint8Array[] = [];
      for (const signature of stack.slice(1, -1)) {
        if (!(signature instanceof Uint8Array)) invalidSignature();
        signatures.push(signature);
      }
      return { partialSig: orderedMultisigSignatures(signatures, context, transaction, index, input.sighashType) };
    }
    case 'sh-wsh-multi': {
      if (!scriptSig || !witness || witness.length < 2) invalidSignature();
      const stack = decodeScriptStack(scriptSig);
      const redeemScript = stack[0];
      const first = witness[0];
      const last = witness[witness.length - 1];
      if (
        stack.length !== 1 ||
        !(redeemScript instanceof Uint8Array) ||
        !equal(redeemScript, context.redeemScript) ||
        !first ||
        first.length !== 0 ||
        !last ||
        !equal(last, context.witnessScript)
      ) {
        invalidSignature();
      }
      return { partialSig: orderedMultisigSignatures(witness.slice(1, -1), context, transaction, index, input.sighashType) };
    }
    case 'wsh-multi': {
      if (scriptSig || !witness || witness.length < 2) invalidSignature();
      const first = witness[0];
      const last = witness[witness.length - 1];
      if (!first || first.length !== 0 || !last || !equal(last, context.witnessScript)) invalidSignature();
      return { partialSig: orderedMultisigSignatures(witness.slice(1, -1), context, transaction, index, input.sighashType) };
    }
  }
  return invalidSignature();
}

function addAndCheckReturnedSignatures(
  working: bitcoin.Psbt,
  returned: bitcoin.Psbt,
  index: number,
  context: InputContext,
  finalized: boolean,
  transaction: bitcoin.Transaction,
): { added: boolean; present: boolean } {
  const originalInput = working.data.inputs[index];
  const returnedInput = returned.data.inputs[index];
  if (!originalInput || !returnedInput) invalidSignature();
  const extracted = finalized
    ? extractFinalSignatures(returnedInput, context, transaction, index)
    : { partialSig: returnedInput.partialSig, tapKeySig: returnedInput.tapKeySig };
  if (finalized) {
    for (const partial of returnedInput.partialSig ?? []) {
      const finalizedPartial = extracted.partialSig?.find(
        candidate => equal(candidate.pubkey, partial.pubkey) && equal(candidate.signature, partial.signature),
      );
      if (!finalizedPartial) invalidSignature();
    }
    if (returnedInput.tapKeySig && !equal(returnedInput.tapKeySig, extracted.tapKeySig)) invalidSignature();
  }
  let selectedAdded = false;
  let selectedPresent = false;

  if (context.kind === 'tr') {
    if (extracted.partialSig?.length) invalidSignature();
    const signature = extracted.tapKeySig;
    if (signature) {
      const existing = originalInput.tapKeySig;
      if (existing && !equal(existing, signature)) invalidSignature();
      if (!existing) {
        const selectedPubkey = context.selectedPubkey;
        if (!selectedPubkey) invalidSignature();
        working.updateInput(index, { tapKeySig: signature });
        selectedAdded = true;
        selectedPresent = true;
      }
      selectedPresent = true;
    }
  } else {
    if (extracted.tapKeySig) invalidSignature();
    for (const partial of extracted.partialSig ?? []) {
      const existing = (originalInput.partialSig ?? []).find(candidate => equal(candidate.pubkey, partial.pubkey));
      if (existing) {
        if (!equal(existing.signature, partial.signature)) invalidSignature();
        if (context.selectedPubkey && equal(partial.pubkey, context.selectedPubkey)) selectedPresent = true;
        continue;
      }
      const selectedPubkey = context.selectedPubkey;
      if (!selectedPubkey || !equal(partial.pubkey, selectedPubkey)) invalidSignature();
      try {
        working.updateInput(index, { partialSig: [partial] });
      } catch {
        invalidSignature();
      }
      selectedAdded = true;
      selectedPresent = true;
    }
  }
  validatePresentSignatures(working, index, context);
  return { added: selectedAdded, present: selectedPresent };
}

function finishInput(working: bitcoin.Psbt, returned: bitcoin.Psbt, index: number, finalized: boolean): boolean {
  try {
    working.finalizeInput(index);
  } catch {
    if (finalized) invalidSignature();
    return false;
  }
  if (finalized) {
    const expected = working.data.inputs[index];
    const actual = returned.data.inputs[index];
    if (!expected || !actual) invalidSignature();
    if (!equal(expected.finalScriptSig, actual.finalScriptSig) || !equal(expected.finalScriptWitness, actual.finalScriptWitness)) {
      invalidSignature();
    }
  }
  return true;
}

export function validateBhwiPsbt(
  originalBase64: string,
  returnedBase64: string,
  wallet: WatchOnlyWallet | MultisigHDWallet,
  signer: BhwiSigner,
): BhwiPsbtValidationResult {
  try {
    const original = preflight(originalBase64, wallet, signer);
    let returned: RawPsbt | undefined;
    try {
      returned = parseStrictPsbt(returnedBase64);
    } catch {
      changed();
    }
    if (!returned || !equal(original.raw.unsignedTx, returned.unsignedTx)) changed();
    const originalGlobal = original.raw.maps[0];
    const returnedGlobal = returned.maps[0];
    if (!originalGlobal || !returnedGlobal) changed();
    compareExactMap(originalGlobal, returnedGlobal);
    const inputCount = original.raw.transaction.ins.length;
    const outputCount = original.raw.transaction.outs.length;
    const finalized: boolean[] = [];
    for (let index = 0; index < inputCount; index++) {
      const originalInputMap = original.raw.maps[index + 1];
      const returnedInputMap = returned.maps[index + 1];
      if (!originalInputMap || !returnedInputMap) changed();
      finalized.push(compareInputMap(originalInputMap, returnedInputMap));
    }
    for (let index = 0; index < outputCount; index++) {
      const originalOutputMap = original.raw.maps[inputCount + 1 + index];
      const returnedOutputMap = returned.maps[inputCount + 1 + index];
      if (!originalOutputMap || !returnedOutputMap) changed();
      compareExactMap(originalOutputMap, returnedOutputMap);
    }

    const working = original.raw.psbt;
    let selectedAdded = false;
    const selectedPresent: boolean[] = [];
    for (let index = 0; index < inputCount; index++) {
      const context = original.contexts[index];
      const isFinalized = finalized[index];
      if (!context || isFinalized === undefined) invalidSignature();
      const selected = addAndCheckReturnedSignatures(working, returned.psbt, index, context, isFinalized, original.raw.transaction);
      selectedAdded = selected.added || selectedAdded;
      selectedPresent.push(selected.present);
    }
    if (!selectedAdded) noSignature();

    const completionCandidate = working.clone();
    let complete = true;
    for (let index = 0; index < inputCount; index++) {
      const isFinalized = finalized[index];
      if (isFinalized === undefined) invalidSignature();
      complete = finishInput(completionCandidate, returned.psbt, index, isFinalized) && complete;
    }
    const selectedSignerSignedAllInputs = selectedPresent.length === inputCount && selectedPresent.every(Boolean);
    if (!complete) return { psbt: completionCandidate, continuationPsbt: working, selectedSignerSignedAllInputs };
    const tx = completionCandidate.extractTransaction();
    if (completionCandidate.getFee() !== original.fee) changed();
    return { psbt: completionCandidate, continuationPsbt: completionCandidate, tx, selectedSignerSignedAllInputs };
  } catch (error) {
    if (error instanceof Error && STABLE_ERRORS[error.message] === true) throw error;
    return invalidSignature();
  }
}
