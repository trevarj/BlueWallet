import * as bitcoin from 'bitcoinjs-lib';
import { Buffer } from 'buffer';

import { WatchOnlyWallet } from '../class/wallets/watch-only-wallet';
import { network } from '../models/bitcoinNetwork';
import * as BlueElectrum from './BlueElectrum';
import type { HardwareWalletAssociation } from './bhwi';
import { validateBhwiPsbt } from './validateBhwiPsbt';

export const BHWI_SIGNING_SESSION_EXPIRED = 'Hardware signing session expired; start again';
const UNSUPPORTED = 'Unsupported hardware-wallet signing input';

export type BhwiPsbtAttemptSnapshot = Readonly<{
  generation: number;
  originalBase64: string;
  walletID: string;
  walletIdentity: string;
  associationIdentity: string;
  policyIdentity: string;
  fee: string;
}>;

export type BhwiPsbtReview = {
  fee: bigint;
  outputs: { destination: string; value: bigint }[];
};

type ParentFetcher = (txids: string[]) => Promise<Record<string, string>>;

const equal = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

const unsupported = (): never => {
  throw new Error(UNSUPPORTED);
};

export const bhwiAssociationIdentity = (association: HardwareWalletAssociation): string =>
  [association.family, association.fingerprint, association.path, association.xpub, association.format].join('\0');

export function bhwiWatchOnlyWalletIdentity(wallet: WatchOnlyWallet, association: HardwareWalletAssociation): string | undefined {
  const liveAssociation = wallet.getHardwareWalletAssociation();
  if (!liveAssociation || bhwiAssociationIdentity(liveAssociation) !== bhwiAssociationIdentity(association)) return undefined;
  try {
    return [
      wallet.getID(),
      wallet.getSecret(),
      wallet.getMasterFingerprintHex(),
      wallet.getDerivationPath(),
      bhwiAssociationIdentity(liveAssociation),
    ].join('\0');
  } catch {
    return undefined;
  }
}

export function assertBhwiPsbtAttemptCurrent(
  expected: BhwiPsbtAttemptSnapshot | undefined,
  current: BhwiPsbtAttemptSnapshot | undefined,
): asserts expected is BhwiPsbtAttemptSnapshot {
  if (
    !expected ||
    !current ||
    expected.generation !== current.generation ||
    expected.originalBase64 !== current.originalBase64 ||
    expected.walletID !== current.walletID ||
    expected.walletIdentity !== current.walletIdentity ||
    expected.associationIdentity !== current.associationIdentity ||
    expected.policyIdentity !== current.policyIdentity ||
    expected.fee !== current.fee
  ) {
    throw new Error(BHWI_SIGNING_SESSION_EXPIRED);
  }
}

function checkedParent(psbt: bitcoin.Psbt, index: number, serialized: Uint8Array): bitcoin.Transaction {
  const txInput = psbt.txInputs[index];
  const input = psbt.data.inputs[index];
  if (!txInput || !input) return unsupported();
  let parent: bitcoin.Transaction;
  try {
    parent = bitcoin.Transaction.fromBuffer(Buffer.from(serialized));
  } catch {
    return unsupported();
  }
  if (!equal(parent.getHash(), txInput.hash) || txInput.index >= parent.outs.length) return unsupported();
  const output = parent.outs[txInput.index];
  if (!output) return unsupported();
  if (input.witnessUtxo && (!equal(output.script, input.witnessUtxo.script) || output.value !== input.witnessUtxo.value)) {
    return unsupported();
  }
  return parent;
}

export async function hydrateBhwiPsbt(
  source: bitcoin.Psbt,
  fetchParents: ParentFetcher = txids => BlueElectrum.multiGetTransactionByTxid(txids, false),
  assertCurrent: () => void = () => undefined,
): Promise<bitcoin.Psbt> {
  const psbt = source.clone();
  const missing = new Map<string, number[]>();
  for (const [index, input] of psbt.data.inputs.entries()) {
    if (input.nonWitnessUtxo) {
      checkedParent(psbt, index, input.nonWitnessUtxo);
      continue;
    }
    const txInput = psbt.txInputs[index];
    if (!txInput) return unsupported();
    const txid = Buffer.from(txInput.hash).reverse().toString('hex');
    missing.set(txid, [...(missing.get(txid) ?? []), index]);
  }
  if (missing.size === 0) return psbt;
  const parents = await fetchParents([...missing.keys()]);
  assertCurrent();
  for (const [txid, indexes] of missing) {
    const parentHex = parents[txid];
    if (typeof parentHex !== 'string') return unsupported();
    for (const index of indexes) {
      const parent = checkedParent(psbt, index, Buffer.from(parentHex, 'hex'));
      if (parent.getId() !== txid) return unsupported();
      psbt.updateInput(index, { nonWitnessUtxo: parent.toBuffer() });
    }
  }
  return psbt;
}

export function getBhwiPsbtReview(psbt: bitcoin.Psbt): BhwiPsbtReview {
  let inputTotal = 0n;
  for (const [index, input] of psbt.data.inputs.entries()) {
    if (!input.nonWitnessUtxo) return unsupported();
    const parent = checkedParent(psbt, index, input.nonWitnessUtxo);
    const txInput = psbt.txInputs[index];
    const output = txInput && parent.outs[txInput.index];
    if (!output) return unsupported();
    inputTotal += output.value;
  }
  let outputTotal = 0n;
  const outputs = psbt.txOutputs.map(output => {
    outputTotal += output.value;
    let destination: string;
    try {
      destination = bitcoin.address.fromOutputScript(output.script, network);
    } catch {
      destination = Buffer.from(output.script).toString('hex');
    }
    return { destination, value: output.value };
  });
  if (inputTotal < outputTotal) return unsupported();
  return { fee: inputTotal - outputTotal, outputs };
}

export function validateBhwiBoundPsbt(
  originalBase64: string | undefined,
  returnedBase64: string,
  wallet: WatchOnlyWallet,
  association: HardwareWalletAssociation,
): { psbt: bitcoin.Psbt; tx?: bitcoin.Transaction } {
  if (!originalBase64) throw new Error(BHWI_SIGNING_SESSION_EXPIRED);
  return validateBhwiPsbt(originalBase64, returnedBase64, wallet, association);
}
