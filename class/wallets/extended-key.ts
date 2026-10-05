import b58 from 'bs58check';

import { bitcoinNetwork } from '../../models/bitcoinNetwork';
import { concatUint8Arrays } from '../../blue_modules/uint8array-extras';

export type ExtendedKeyFormat = 'legacy' | 'nested' | 'native' | 'multisigNested' | 'multisigNative';
export type ExtendedKeyChain = 'bitcoin' | 'testnet';
type ExtendedKeyKind = 'public' | 'private';

type Version = {
  format: ExtendedKeyFormat;
  kind: ExtendedKeyKind;
  value: number;
  prefix: string;
};

const versions: Record<ExtendedKeyChain, readonly Version[]> = {
  bitcoin: [
    { format: 'legacy', kind: 'public', value: 0x0488b21e, prefix: 'xpub' },
    { format: 'legacy', kind: 'private', value: 0x0488ade4, prefix: 'xprv' },
    { format: 'nested', kind: 'public', value: 0x049d7cb2, prefix: 'ypub' },
    { format: 'nested', kind: 'private', value: 0x049d7878, prefix: 'yprv' },
    { format: 'native', kind: 'public', value: 0x04b24746, prefix: 'zpub' },
    { format: 'native', kind: 'private', value: 0x04b2430c, prefix: 'zprv' },
    {
      format: 'multisigNested',
      kind: 'public',
      value: 0x0295b43f,
      prefix: 'Ypub',
    },
    {
      format: 'multisigNested',
      kind: 'private',
      value: 0x0295b005,
      prefix: 'Yprv',
    },
    {
      format: 'multisigNative',
      kind: 'public',
      value: 0x02aa7ed3,
      prefix: 'Zpub',
    },
    {
      format: 'multisigNative',
      kind: 'private',
      value: 0x02aa7a99,
      prefix: 'Zprv',
    },
  ],
  testnet: [
    { format: 'legacy', kind: 'public', value: 0x043587cf, prefix: 'tpub' },
    { format: 'legacy', kind: 'private', value: 0x04358394, prefix: 'tprv' },
    { format: 'nested', kind: 'public', value: 0x044a5262, prefix: 'upub' },
    { format: 'nested', kind: 'private', value: 0x044a4e28, prefix: 'uprv' },
    { format: 'native', kind: 'public', value: 0x045f1cf6, prefix: 'vpub' },
    { format: 'native', kind: 'private', value: 0x045f18bc, prefix: 'vprv' },
    {
      format: 'multisigNested',
      kind: 'public',
      value: 0x024289ef,
      prefix: 'Upub',
    },
    {
      format: 'multisigNested',
      kind: 'private',
      value: 0x024285b5,
      prefix: 'Uprv',
    },
    {
      format: 'multisigNative',
      kind: 'public',
      value: 0x02575483,
      prefix: 'Vpub',
    },
    {
      format: 'multisigNative',
      kind: 'private',
      value: 0x02575048,
      prefix: 'Vprv',
    },
  ],
};

const selectedVersions = versions[bitcoinNetwork];
const allVersions = (Object.keys(versions) as ExtendedKeyChain[]).flatMap(chain => versions[chain].map(version => ({ chain, version })));
const recognizedExtendedKeyPrefixes = allVersions.map(candidate => candidate.version.prefix);

export const looksLikeExtendedKey = (key: string): boolean => recognizedExtendedKeyPrefixes.includes(key.substring(0, 4));

export const findRecognizedExtendedKey = (value: string): string | undefined => {
  const indexes = recognizedExtendedKeyPrefixes.map(prefix => value.indexOf(prefix)).filter(index => index >= 0);
  if (indexes.length === 0) return undefined;
  return value.slice(Math.min(...indexes)).match(/^[1-9A-HJ-NP-Za-km-z]+/)?.[0];
};

const versionBytes = (version: number): Uint8Array => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, version, false);
  return bytes;
};

export type DecodedExtendedKey = {
  payload: Uint8Array;
  format: ExtendedKeyFormat;
  kind: ExtendedKeyKind;
  chain: ExtendedKeyChain;
};

export const decodeRecognizedExtendedKey = (key: string, expectedKind?: ExtendedKeyKind): DecodedExtendedKey => {
  const payload = new Uint8Array(b58.decode(key));
  if (payload.length !== 78) throw new Error('Extended key payload must be exactly 78 bytes');

  const encodedVersion = new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0, false);
  const source = allVersions.find(candidate => candidate.version.value === encodedVersion);
  if (!source) throw new Error('Unrecognized extended key version');
  if (expectedKind && source.version.kind !== expectedKind) throw new Error(`Expected an extended ${expectedKind} key`);

  const marker = payload[45];
  if (source.version.kind === 'private' ? marker !== 0 : marker !== 2 && marker !== 3) {
    throw new Error(`Invalid extended ${source.version.kind} key marker`);
  }

  return {
    payload,
    format: source.version.format,
    kind: source.version.kind,
    chain: source.chain,
  };
};

export const decodeExtendedKey = (key: string, expectedKind?: ExtendedKeyKind): DecodedExtendedKey => {
  const decoded = decodeRecognizedExtendedKey(key, expectedKind);
  if (decoded.chain !== bitcoinNetwork) throw new Error(`Extended key is not valid for ${bitcoinNetwork}`);
  return decoded;
};

export const encodeExtendedKey = (
  format: ExtendedKeyFormat,
  kind: ExtendedKeyKind,
  depth: number,
  parentFingerprint: Uint8Array,
  index: number,
  chainCode: Uint8Array,
  key: Uint8Array,
): string => {
  if (!Number.isInteger(depth) || depth < 0 || depth > 255) throw new Error('Invalid extended key depth');
  if (parentFingerprint.length !== 4) throw new Error('Invalid extended key parent fingerprint');
  if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) throw new Error('Invalid extended key child index');
  if (chainCode.length !== 32) throw new Error('Invalid extended key chain code');
  if (key.length !== 33 || (kind === 'private' ? key[0] !== 0 : key[0] !== 2 && key[0] !== 3)) {
    throw new Error(`Invalid extended ${kind} key marker`);
  }

  const target = selectedVersions.find(candidate => candidate.format === format && candidate.kind === kind)!;
  const depthBytes = new Uint8Array([depth]);
  const indexBytes = new Uint8Array(4);
  new DataView(indexBytes.buffer).setUint32(0, index, false);
  return b58.encode(concatUint8Arrays([versionBytes(target.value), depthBytes, parentFingerprint, indexBytes, chainCode, key]));
};

export const convertExtendedKey = (key: string, format: ExtendedKeyFormat): string => {
  const decoded = decodeExtendedKey(key);
  const target = selectedVersions.find(candidate => candidate.format === format && candidate.kind === decoded.kind)!;
  return b58.encode(concatUint8Arrays([versionBytes(target.value), decoded.payload.slice(4)]));
};

export const isExtendedPublicKey = (key: string): boolean => {
  try {
    decodeExtendedKey(key, 'public');
    return true;
  } catch {
    return false;
  }
};

export const isExtendedPrivateKey = (key: string): boolean => {
  try {
    decodeExtendedKey(key, 'private');
    return true;
  } catch {
    return false;
  }
};

export const extendedPublicKeyPrefixes = selectedVersions
  .filter(candidate => candidate.kind === 'public')
  .map(candidate => candidate.prefix);
