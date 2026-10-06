import * as bitcoin from 'bitcoinjs-lib';
import { Buffer } from 'buffer';

import { WatchOnlyWallet } from '../class/wallets/watch-only-wallet';
import { MultisigHDWallet } from '../class/wallets/multisig-hd-wallet';
import { network } from '../models/bitcoinNetwork';
import * as BlueElectrum from './BlueElectrum';
import { sameBhwiExtendedPublicKey } from './bhwi';
import type { Account as BhwiAccount } from '../codegen/NativeBhwi';
import type { HardwareWalletAssociation } from './bhwi';
import { validateBhwiPsbt } from './validateBhwiPsbt';

export const BHWI_SIGNING_SESSION_EXPIRED = 'Hardware signing session expired; start again';
export const CPFP_FEE_TARGET_NOT_REACHED = 'CPFP fee target not reached; rebuild with a higher fee';
export type BhwiCpfpContext = Readonly<{
  parentFee: number;
  parentVsize: number;
  targetFeeRate: number;
}>;

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export function requireBhwiCpfpContext(value: unknown): BhwiCpfpContext | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') throw new Error(BHWI_SIGNING_SESSION_EXPIRED);
  const keys = Object.keys(value);
  if (
    keys.length !== 3 ||
    !Object.prototype.hasOwnProperty.call(value, 'parentFee') ||
    !Object.prototype.hasOwnProperty.call(value, 'parentVsize') ||
    !Object.prototype.hasOwnProperty.call(value, 'targetFeeRate')
  ) {
    throw new Error(BHWI_SIGNING_SESSION_EXPIRED);
  }
  const { parentFee, parentVsize, targetFeeRate } = value as Partial<BhwiCpfpContext>;
  if (
    typeof parentFee !== 'number' ||
    !Number.isSafeInteger(parentFee) ||
    parentFee < 0 ||
    typeof parentVsize !== 'number' ||
    !Number.isSafeInteger(parentVsize) ||
    parentVsize <= 0 ||
    typeof targetFeeRate !== 'number' ||
    !Number.isFinite(targetFeeRate) ||
    targetFeeRate <= 0 ||
    targetFeeRate > Number.MAX_SAFE_INTEGER
  ) {
    throw new Error(BHWI_SIGNING_SESSION_EXPIRED);
  }
  return Object.freeze({ parentFee, parentVsize, targetFeeRate });
}

export function assertBhwiCpfpPackageTarget(context: BhwiCpfpContext, childFee: bigint, child: bitcoin.Transaction): void {
  const childFeeNumber = Number(childFee);
  const childVsize = child.virtualSize();
  const packageFee = context.parentFee + childFeeNumber;
  const packageVsize = context.parentVsize + childVsize;
  if (
    childFee < 0n ||
    childFee > MAX_SAFE_BIGINT ||
    !Number.isSafeInteger(childVsize) ||
    childVsize <= 0 ||
    !Number.isSafeInteger(packageFee) ||
    !Number.isSafeInteger(packageVsize) ||
    packageFee / packageVsize < context.targetFeeRate
  ) {
    throw new Error(CPFP_FEE_TARGET_NOT_REACHED);
  }
}

export const assertBhwiPsbtContinuationToken = (expected: string | undefined, returned: string | undefined): void => {
  if (!expected || returned !== expected) throw new Error(BHWI_SIGNING_SESSION_EXPIRED);
};
const UNSUPPORTED = 'Unsupported hardware-wallet signing input';

export type BhwiPsbtAttemptSnapshot = Readonly<{
  generation: number;
  originalBase64: string;
  walletID: string;
  walletIdentity: string;
  associationIdentity: string;
  policyIdentity: string;
  fee: string;
  cpfp?: BhwiCpfpContext;
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
export type BhwiHardwareMobilePolicy = {
  association: HardwareWalletAssociation;
  phone: Pick<BhwiAccount, 'fingerprint' | 'path' | 'xpub'>;
};

export function getBhwiHardwareMobilePolicy(wallet: MultisigHDWallet): BhwiHardwareMobilePolicy | undefined {
  if (wallet.getM() !== 2 || wallet.getN() !== 2 || !wallet.isNativeSegwit() || wallet.howManySignaturesCanWeMake() !== 1) {
    return undefined;
  }
  const associations = wallet.getHardwareWalletAssociations();
  if (associations.length !== 1) return undefined;
  const association = associations[0];
  if (!association || association.format !== 'multisig-native' || association.path !== MultisigHDWallet.PATH_NATIVE_SEGWIT) {
    return undefined;
  }
  let publicCosigners: Array<{ xpub: string; fingerprint: string; path: string }>;
  try {
    publicCosigners = wallet.getPublicCosigners();
  } catch {
    return undefined;
  }
  const hardwareIndexes = publicCosigners
    .map((cosigner, index) => (sameBhwiExtendedPublicKey(cosigner.xpub, association.xpub) ? index : -1))
    .filter(index => index >= 0);
  const phoneIndexes = publicCosigners
    .map((_cosigner, index) => {
      const key = wallet.getCosigner(index + 1);
      return !MultisigHDWallet.isXpubString(key) && !MultisigHDWallet.isXprvString(key) ? index : -1;
    })
    .filter(index => index >= 0);
  if (
    hardwareIndexes.length !== 1 ||
    phoneIndexes.length !== 1 ||
    hardwareIndexes[0] === phoneIndexes[0] ||
    !MultisigHDWallet.isXpubString(wallet.getCosigner(hardwareIndexes[0]! + 1))
  ) {
    return undefined;
  }
  const phone = publicCosigners[phoneIndexes[0]!];
  if (!phone || phone.path !== MultisigHDWallet.PATH_NATIVE_SEGWIT) return undefined;
  return { association, phone };
}

export function getUnsignedBhwiMultisigPsbt(source: bitcoin.Psbt): bitcoin.Psbt {
  const unsigned = source.clone();
  for (const input of unsigned.data.inputs) {
    if (input.finalScriptSig || input.finalScriptWitness) throw new Error(UNSUPPORTED);
    delete input.partialSig;
    delete input.tapKeySig;
  }
  return unsigned;
}

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

export function bhwiMultisigWalletIdentity(wallet: MultisigHDWallet, association: HardwareWalletAssociation): string | undefined {
  const liveAssociations = wallet
    .getHardwareWalletAssociations()
    .filter(candidate => bhwiAssociationIdentity(candidate) === bhwiAssociationIdentity(association));
  if (liveAssociations.length !== 1) return undefined;
  try {
    return [wallet.getID(), wallet.getM(), wallet.getN(), wallet.getPublicDescriptor(), bhwiAssociationIdentity(liveAssociations[0])].join(
      '\0',
    );
  } catch {
    return undefined;
  }
}

export function bhwiMultisigPolicyIdentity(wallet: MultisigHDWallet, association: HardwareWalletAssociation): string | undefined {
  try {
    const descriptor = wallet.getPublicDescriptor();
    const registration = wallet.getHardwareWalletRegistration(association);
    return [
      descriptor,
      registration?.status ?? 'unregistered',
      registration?.name ?? '',
      registration?.descriptor ?? '',
      registration?.hmacService ?? '',
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
    expected.fee !== current.fee ||
    expected.cpfp?.parentFee !== current.cpfp?.parentFee ||
    expected.cpfp?.parentVsize !== current.cpfp?.parentVsize ||
    expected.cpfp?.targetFeeRate !== current.cpfp?.targetFeeRate
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
