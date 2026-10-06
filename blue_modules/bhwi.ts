/* eslint-disable no-bitwise */
import { PermissionsAndroid, Platform } from 'react-native';
import Keychain, { ACCESSIBLE } from 'react-native-keychain';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes } from '../class/rng';
import { decodeExtendedKey } from '../class/wallets/extended-key';
import { uint8ArrayToHex } from './uint8array-extras';
import NativeBhwi from '../codegen/NativeBhwi';
import type { Account, BhwiAccountFormat, BhwiFamily, Device, DeviceInfo, Policy, Registration } from '../codegen/NativeBhwi';
import { bitcoinNetwork, coinType } from '../models/bitcoinNetwork';

export const BHWI_ERROR_CODES = [
  'BHWI_UNAVAILABLE',
  'BHWI_BUSY',
  'BHWI_INVALID_INPUT',
  'BHWI_PERMISSION_DENIED',
  'BHWI_USER_REFUSED',
  'BHWI_AUTH_REFUSED',
  'BHWI_CANCELLED',
  'BHWI_DISCONNECTED',
  'BHWI_TIMEOUT',
  'BHWI_UNSUPPORTED',
  'BHWI_DEVICE_ERROR',
  'BHWI_INTERNAL',
] as const;

export type BhwiErrorCode = (typeof BHWI_ERROR_CODES)[number];
const safeMessages: Record<BhwiErrorCode, string> = {
  BHWI_UNAVAILABLE: 'Hardware wallets are unavailable on this device.',
  BHWI_BUSY: 'Another hardware wallet operation is active.',
  BHWI_INVALID_INPUT: 'The hardware wallet request is invalid.',
  BHWI_PERMISSION_DENIED: 'Hardware wallet permission was denied.',
  BHWI_USER_REFUSED: 'The request was refused on the hardware wallet.',
  BHWI_AUTH_REFUSED: 'Hardware wallet authentication was refused.',
  BHWI_CANCELLED: 'The hardware wallet request was cancelled.',
  BHWI_DISCONNECTED: 'The hardware wallet disconnected.',
  BHWI_TIMEOUT: 'The hardware wallet request timed out.',
  BHWI_UNSUPPORTED: 'This hardware wallet operation is unsupported.',
  BHWI_DEVICE_ERROR: 'The hardware wallet reported an error.',
  BHWI_INTERNAL: 'The hardware wallet operation failed.',
};

export class BhwiError extends Error {
  readonly code: BhwiErrorCode;

  constructor(code: BhwiErrorCode) {
    super(safeMessages[code]);
    this.name = 'BhwiError';
    this.code = code;
  }
}

export type BhwiSinglesigFormat = 'legacy' | 'nested-segwit' | 'native-segwit' | 'taproot';
export type BhwiMultisigFormat = 'multisig-wrapped' | 'multisig-native';
export type BhwiImportFormat = BhwiSinglesigFormat | BhwiMultisigFormat;

export type HardwareWalletAssociation = {
  family: BhwiFamily;
  fingerprint: string;
  path: string;
  xpub: string;
  format: BhwiImportFormat;
};

export type HardwareWalletRegistration = HardwareWalletAssociation & {
  status: 'complete' | 'pending';
  network: typeof bitcoinNetwork;
  name: string;
  descriptor: string;
  hmacService?: string;
};

export type BhwiAddressSnapshot = {
  address: string;
  index: number;
  isInternal: boolean;
};

export const isBhwiAddressSnapshot = (value: unknown): value is BhwiAddressSnapshot =>
  !!value &&
  typeof value === 'object' &&
  'address' in value &&
  typeof value.address === 'string' &&
  value.address.length > 0 &&
  'index' in value &&
  typeof value.index === 'number' &&
  Number.isSafeInteger(value.index) &&
  value.index >= 0 &&
  'isInternal' in value &&
  typeof value.isInternal === 'boolean';

export type BhwiOperationRouteParams =
  | {
      mode: 'register-wallet';
      walletID: string;
      hardwareAccount: HardwareWalletAssociation;
    }
  | {
      mode: 'verify-address';
      walletID: string;
      snapshot: BhwiAddressSnapshot;
    }
  | {
      mode: 'sign-psbt';
      walletID: string;
      hardwareAccount: HardwareWalletAssociation;
      originalBase64: string;
      attempt: number;
    }
  | {
      mode: 'sign-message';
      walletID: string;
      hardwareAccount: HardwareWalletAssociation;
      snapshot: BhwiAddressSnapshot;
      path: string;
      message: string;
      attempt: number;
    };

export const BHWI_MAX_ACCOUNT_INDEX = 0x7fffffff;
export const BHWI_SINGLESIG_FORMATS: readonly BhwiSinglesigFormat[] = ['legacy', 'nested-segwit', 'native-segwit', 'taproot'];

const BHWI_FAMILIES: readonly BhwiFamily[] = ['bitbox02', 'coldcard', 'jade', 'ledger', 'keepkey', 'specter', 'trezor'];
const BHWI_LEDGER_HMAC_SERVICE_PREFIX = 'bluewallet.bhwi.ledger-policy.';
const HMAC_HEX_PATTERN = /^[0-9a-f]{64}$/;
const BHWI_IMPORT_FORMATS: readonly BhwiImportFormat[] = [...BHWI_SINGLESIG_FORMATS, 'multisig-wrapped', 'multisig-native'];
const formatPurpose: Record<BhwiImportFormat, number> = {
  legacy: 44,
  'nested-segwit': 49,
  'native-segwit': 84,
  taproot: 86,
  'multisig-wrapped': 48,
  'multisig-native': 48,
};

const DESCRIPTOR_WRAPPERS: Record<BhwiSinglesigFormat, [string, string]> = {
  legacy: ['pkh(', ')'],
  'nested-segwit': ['sh(wpkh(', '))'],
  'native-segwit': ['wpkh(', ')'],
  taproot: ['tr(', ')'],
};

const isBhwiFamily = (value: unknown): value is BhwiFamily =>
  typeof value === 'string' && (BHWI_FAMILIES as readonly string[]).includes(value);

export const isCanonicalBhwiFingerprint = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}$/.test(value);

const isImportFormat = (value: unknown): value is BhwiImportFormat =>
  typeof value === 'string' && (BHWI_IMPORT_FORMATS as readonly string[]).includes(value);

export const isBhwiSinglesigFormat = (format: BhwiAccountFormat): format is BhwiSinglesigFormat =>
  (BHWI_SINGLESIG_FORMATS as readonly string[]).includes(format);

export function parseBhwiAccountIndex(value: string | number): number {
  const text = String(value);
  if (!/^(0|[1-9]\d*)$/.test(text)) throw new BhwiError('BHWI_INVALID_INPUT');
  const index = Number(text);
  if (!Number.isSafeInteger(index) || index > BHWI_MAX_ACCOUNT_INDEX) throw new BhwiError('BHWI_INVALID_INPUT');
  return index;
}

export function getBhwiAccountPath(format: BhwiImportFormat, accountIndex: string | number, selectedCoinType: number = coinType): string {
  if (selectedCoinType !== 0 && selectedCoinType !== 1) throw new BhwiError('BHWI_INVALID_INPUT');
  const index = parseBhwiAccountIndex(accountIndex);
  const base = `m/${formatPurpose[format]}'/${selectedCoinType}'/${index}'`;
  if (format === 'multisig-wrapped') return `${base}/1'`;
  if (format === 'multisig-native') return `${base}/2'`;
  return base;
}

export function supportsBhwiAccountFormat(info: Pick<DeviceInfo, 'family' | 'model'>, format: BhwiImportFormat): boolean {
  switch (info.family) {
    case 'ledger':
      return true;
    case 'bitbox02':
      return format === 'nested-segwit' || format === 'native-segwit' || format === 'multisig-wrapped' || format === 'multisig-native';
    case 'jade':
      return format !== 'taproot';
    case 'coldcard':
    case 'keepkey':
    case 'specter':
      return format !== 'taproot';
    case 'trezor':
      return format !== 'taproot' || info.model === 'T';
  }
}

export function supportsBhwiMessageSigning(
  info: Pick<DeviceInfo, 'family' | 'model'>,
  format: BhwiImportFormat,
): format is Exclude<BhwiSinglesigFormat, 'taproot'> {
  if (!isBhwiSinglesigFormat(format) || format === 'taproot') return false;
  switch (info.family) {
    case 'coldcard':
      return format === 'native-segwit';
    case 'jade':
    case 'ledger':
    case 'keepkey':
      return true;
    case 'trezor':
      return info.model === null || info.model === '1' || info.model === 'T';
    case 'bitbox02':
      return format === 'nested-segwit' || format === 'native-segwit';
    case 'specter':
      return false;
  }
}

export const supportsBhwiRegistration = (family: BhwiFamily): boolean => family !== 'trezor' && family !== 'keepkey';

export const supportsBhwiDescriptorDisplay = (family: BhwiFamily, descriptor: string): boolean => {
  const policy = descriptor.trim().split('#', 1)[0];
  if (family === 'ledger') return true;
  if (family === 'specter') return !policy.startsWith('tr(');
  if (family !== 'bitbox02' && family !== 'jade') return false;
  if (policy.startsWith('tr(') || policy.startsWith('sh(sortedmulti(') || policy.startsWith('sh(multi(')) return false;
  return family !== 'bitbox02' || !policy.startsWith('pkh(');
};

export const supportsBhwiRawMultisigDisplay = (family: BhwiFamily): boolean => family !== 'specter';

export const getBhwiPolicyName = (descriptor: string): string => `bw_${uint8ArrayToHex(sha256(descriptor)).slice(0, 12)}`;

export const getBhwiLedgerHmacService = (descriptor: string, association: HardwareWalletAssociation): string => {
  const binding = [
    bitcoinNetwork,
    getBhwiPolicyName(descriptor),
    descriptor,
    association.family,
    association.fingerprint,
    association.path,
    association.xpub,
    association.format,
  ].join('\0');
  return `${BHWI_LEDGER_HMAC_SERVICE_PREFIX}${uint8ArrayToHex(sha256(binding))}`;
};

export async function storeBhwiLedgerHmac(service: string, hmacHex: string): Promise<void> {
  const canonical = hmacHex.toLowerCase();
  if (!service.startsWith(BHWI_LEDGER_HMAC_SERVICE_PREFIX) || !HMAC_HEX_PATTERN.test(canonical)) {
    throw new BhwiError('BHWI_INVALID_INPUT');
  }
  const stored = await Keychain.setGenericPassword(service, canonical, {
    service,
    accessible: ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  if (!stored) throw new BhwiError('BHWI_INTERNAL');
}

export async function getBhwiLedgerHmac(service: string): Promise<string> {
  if (!service.startsWith(BHWI_LEDGER_HMAC_SERVICE_PREFIX)) throw new BhwiError('BHWI_INVALID_INPUT');
  const credentials = await Keychain.getGenericPassword({ service });
  if (!credentials || credentials.username !== service || !HMAC_HEX_PATTERN.test(credentials.password)) {
    throw new BhwiError('BHWI_INTERNAL');
  }
  return credentials.password;
}

type BhwiAddressWallet = {
  _hdWalletInstance?: BhwiAddressWallet;
  _getExternalAddressByIndex?: (index: number) => string;
  _getInternalAddressByIndex?: (index: number) => string;
  external_addresses_cache?: Record<number, string>;
  internal_addresses_cache?: Record<number, string>;
  next_free_address_index?: number;
  next_free_change_address_index?: number;
  gap_limit?: number;
};

const deriveBhwiAddress = (wallet: BhwiAddressWallet, isInternal: boolean, index: number): string | undefined => {
  if (!Number.isSafeInteger(index) || index < 0 || index > 0x7fffffff) return undefined;
  const target = wallet._hdWalletInstance ?? wallet;
  const derive = isInternal ? target._getInternalAddressByIndex : target._getExternalAddressByIndex;
  if (!derive) return undefined;
  try {
    return derive.call(target, index);
  } catch {
    return undefined;
  }
};

export function requireBhwiDisplayedAddress(snapshot: BhwiAddressSnapshot, displayedAddress: string): void {
  if (displayedAddress !== snapshot.address) throw new BhwiError('BHWI_INVALID_INPUT');
}

export function matchesBhwiAddressSnapshot(wallet: unknown, snapshot: BhwiAddressSnapshot): boolean {
  if (typeof wallet !== 'object' || wallet === null || typeof snapshot.address !== 'string') return false;
  return deriveBhwiAddress(wallet as BhwiAddressWallet, snapshot.isInternal, snapshot.index) === snapshot.address;
}

export function resolveBhwiAddressSnapshot(
  wallet: unknown,
  address: string,
  hint?: Pick<BhwiAddressSnapshot, 'index' | 'isInternal'>,
): BhwiAddressSnapshot | undefined {
  if (typeof wallet !== 'object' || wallet === null || !address) return undefined;
  const candidate = wallet as BhwiAddressWallet;
  if (hint) {
    const snapshot = { address, ...hint };
    return matchesBhwiAddressSnapshot(candidate, snapshot) ? snapshot : undefined;
  }
  const target = candidate._hdWalletInstance ?? candidate;
  const matches: BhwiAddressSnapshot[] = [];
  const addCached = (cache: Record<number, string> | undefined, isInternal: boolean) => {
    for (const [rawIndex, cachedAddress] of Object.entries(cache ?? {})) {
      const index = Number(rawIndex);
      if (cachedAddress === address && Number.isSafeInteger(index) && index >= 0) matches.push({ address, index, isInternal });
    }
  };
  addCached(target.external_addresses_cache, false);
  addCached(target.internal_addresses_cache, true);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return undefined;

  const gapLimit = Number.isSafeInteger(target.gap_limit) && (target.gap_limit ?? 0) >= 0 ? target.gap_limit! : 0;
  const externalLimit = (target.next_free_address_index ?? 0) + gapLimit;
  for (let index = 0; index < externalLimit; index++) {
    if (deriveBhwiAddress(target, false, index) === address) matches.push({ address, index, isInternal: false });
  }
  const changeLimit = target.next_free_change_address_index ?? 0;
  for (let index = 0; index <= changeLimit; index++) {
    if (deriveBhwiAddress(target, true, index) === address) matches.push({ address, index, isInternal: true });
  }
  return matches.length === 1 ? matches[0] : undefined;
}

const DESCRIPTOR_INPUT_CHARSET = '0123456789()[],\'/*abcdefgh@:$%{}IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~ijklmnopqrstuvwxyzABCDEFGH`#"\\ ';
const DESCRIPTOR_CHECKSUM_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const DESCRIPTOR_CHECKSUM_GENERATORS = [0xf5dee51989n, 0xa9fdca3312n, 0x1bab10e32dn, 0x3706b1677an, 0x644d626ffdn];

const descriptorChecksumPolymod = (value: bigint, symbol: number): bigint => {
  const high = value >> 35n;
  let next = ((value & 0x7ffffffffn) << 5n) ^ BigInt(symbol);
  for (let index = 0; index < DESCRIPTOR_CHECKSUM_GENERATORS.length; index++) {
    if (((high >> BigInt(index)) & 1n) !== 0n) next ^= DESCRIPTOR_CHECKSUM_GENERATORS[index];
  }
  return next;
};

const descriptorChecksum = (descriptor: string): string | undefined => {
  let checksum = 1n;
  let symbols = 0;
  let symbolCount = 0;
  for (const character of descriptor) {
    const position = DESCRIPTOR_INPUT_CHARSET.indexOf(character);
    if (position === -1) return undefined;
    checksum = descriptorChecksumPolymod(checksum, position & 31);
    symbols = symbols * 3 + (position >> 5);
    if (++symbolCount === 3) {
      checksum = descriptorChecksumPolymod(checksum, symbols);
      symbols = 0;
      symbolCount = 0;
    }
  }
  if (symbolCount > 0) checksum = descriptorChecksumPolymod(checksum, symbols);
  for (let index = 0; index < 8; index++) checksum = descriptorChecksumPolymod(checksum, 0);
  checksum ^= 1n;
  let result = '';
  for (let index = 0; index < 8; index++) {
    result += DESCRIPTOR_CHECKSUM_CHARSET[Number((checksum >> BigInt(5 * (7 - index))) & 31n)];
  }
  return result;
};

const descriptorKeyExpression = (descriptor: string, format: BhwiSinglesigFormat): string | undefined => {
  const separator = descriptor.lastIndexOf('#');
  if (separator !== descriptor.length - 9) return undefined;
  const withoutChecksum = descriptor.slice(0, separator);
  if (descriptorChecksum(withoutChecksum) !== descriptor.slice(separator + 1)) return undefined;
  const [prefix, suffix] = DESCRIPTOR_WRAPPERS[format];
  if (!withoutChecksum.startsWith(prefix) || !withoutChecksum.endsWith(suffix)) return undefined;
  return withoutChecksum.slice(prefix.length, -suffix.length);
};

const descriptorMatchesAccount = (account: Account, format: BhwiSinglesigFormat): boolean => {
  if (typeof account.descriptor !== 'string' || account.descriptor.length === 0) return false;
  const expression = descriptorKeyExpression(account.descriptor, format);
  if (!expression) return false;
  const match = expression.match(/^\[([0-9a-f]{8})\/([^\]]+)\]([1-9A-HJ-NP-Za-km-z]+)(.*)$/);
  if (!match) return false;
  const [, fingerprint, originPath, xpub, suffix] = match;
  if (suffix !== '/<0;1>/*') return false;
  return fingerprint === account.fingerprint && `m/${originPath.replace(/[hH‘’]/g, "'")}` === account.path && xpub === account.xpub;
};

export function isBhwiXpubAtPath(xpub: string, path: string): boolean {
  const components = path.startsWith('m/') ? path.slice(2).split('/') : [];
  if (components.length === 0 || components.some(component => !/^(0|[1-9]\d*)'$/.test(component))) return false;
  const finalChild = Number(components[components.length - 1].slice(0, -1));
  if (!Number.isSafeInteger(finalChild) || finalChild > BHWI_MAX_ACCOUNT_INDEX) return false;
  try {
    const payload = decodeExtendedKey(xpub, 'public').payload;
    const childNumber = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(9, false);
    return payload[4] === components.length && childNumber === finalChild + 0x80000000;
  } catch {
    return false;
  }
}
export function parseHardwareWalletAssociation(value: unknown): HardwareWalletAssociation | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Partial<HardwareWalletAssociation>;
  if (
    !isBhwiFamily(candidate.family) ||
    !isCanonicalBhwiFingerprint(candidate.fingerprint) ||
    !isImportFormat(candidate.format) ||
    typeof candidate.path !== 'string' ||
    typeof candidate.xpub !== 'string'
  ) {
    return undefined;
  }
  const match = candidate.path.match(
    candidate.format.startsWith('multisig-') ? /^m\/48'\/([01])'\/(\d+)'\/([12])'$/ : /^m\/(44|49|84|86)'\/([01])'\/(\d+)'$/,
  );
  if (!match) return undefined;
  const accountIndex = candidate.format.startsWith('multisig-') ? match[2] : match[3];
  try {
    if (candidate.path !== getBhwiAccountPath(candidate.format, accountIndex)) return undefined;
    if (!isBhwiXpubAtPath(candidate.xpub, candidate.path)) return undefined;
  } catch {
    return undefined;
  }
  return {
    family: candidate.family,
    fingerprint: candidate.fingerprint,
    path: candidate.path,
    xpub: candidate.xpub,
    format: candidate.format,
  };
}
export function parseHardwareWalletRegistration(value: unknown): HardwareWalletRegistration | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Partial<HardwareWalletRegistration>;
  const association = parseHardwareWalletAssociation(candidate);
  if (
    !association ||
    !supportsBhwiRegistration(association.family) ||
    (candidate.status !== 'complete' && candidate.status !== 'pending') ||
    candidate.network !== bitcoinNetwork ||
    typeof candidate.descriptor !== 'string' ||
    candidate.descriptor.length === 0 ||
    candidate.name !== getBhwiPolicyName(candidate.descriptor)
  ) {
    return undefined;
  }
  const expectedService = getBhwiLedgerHmacService(candidate.descriptor, association);
  if (
    (candidate.status === 'pending' && candidate.hmacService !== undefined) ||
    (association.family === 'ledger' && candidate.status === 'complete' && candidate.hmacService !== expectedService) ||
    (association.family !== 'ledger' && candidate.hmacService !== undefined)
  ) {
    return undefined;
  }
  return {
    ...association,
    status: candidate.status,
    network: bitcoinNetwork,
    name: getBhwiPolicyName(candidate.descriptor),
    descriptor: candidate.descriptor,
    ...(candidate.hmacService ? { hmacService: candidate.hmacService } : {}),
  };
}

export function createHardwareWalletRegistration(
  association: HardwareWalletAssociation,
  descriptor: string,
  status: Registration['status'],
): HardwareWalletRegistration {
  const value = parseHardwareWalletRegistration({
    ...association,
    status,
    network: bitcoinNetwork,
    name: getBhwiPolicyName(descriptor),
    descriptor,
    ...(association.family === 'ledger' && status === 'complete' ? { hmacService: getBhwiLedgerHmacService(descriptor, association) } : {}),
  });
  if (!value) throw new BhwiError('BHWI_INVALID_INPUT');
  return value;
}
export function verifyBhwiAccount(
  info: DeviceInfo,
  requestedPath: string,
  requestedFormat: BhwiImportFormat,
  account: Account,
): HardwareWalletAssociation {
  if (!supportsBhwiAccountFormat(info, requestedFormat)) throw new BhwiError('BHWI_UNSUPPORTED');
  if (!isCanonicalBhwiFingerprint(info.fingerprint) || !isCanonicalBhwiFingerprint(account.fingerprint)) {
    throw new BhwiError('BHWI_INVALID_INPUT');
  }
  if (
    account.family !== info.family ||
    account.fingerprint !== info.fingerprint ||
    account.path !== requestedPath ||
    account.format !== requestedFormat
  ) {
    throw new BhwiError('BHWI_INVALID_INPUT');
  }
  if (isBhwiSinglesigFormat(requestedFormat) && !descriptorMatchesAccount(account, requestedFormat)) {
    throw new BhwiError('BHWI_INVALID_INPUT');
  }
  const association = parseHardwareWalletAssociation({
    family: account.family,
    fingerprint: account.fingerprint,
    path: account.path,
    xpub: account.xpub,
    format: requestedFormat,
  });
  if (!association) throw new BhwiError('BHWI_INVALID_INPUT');
  return association;
}

export function sameBhwiExtendedPublicKey(a: string, b: string): boolean {
  try {
    const left = decodeExtendedKey(a, 'public').payload;
    const right = decodeExtendedKey(b, 'public').payload;
    if (left.length !== right.length) return false;
    for (let index = 4; index < left.length; index++) {
      if (left[index] !== right[index]) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function isBhwiReconnectMatch(
  expectedValue: unknown,
  info: Pick<DeviceInfo, 'family' | 'fingerprint'>,
  account: Pick<Account, 'family' | 'fingerprint' | 'path' | 'xpub' | 'format'>,
): boolean {
  const expected = parseHardwareWalletAssociation(expectedValue);
  return !!(
    expected &&
    info.family === expected.family &&
    info.fingerprint === expected.fingerprint &&
    account.family === expected.family &&
    account.fingerprint === expected.fingerprint &&
    account.path === expected.path &&
    account.xpub === expected.xpub &&
    account.format === expected.format
  );
}

export type BhwiSelection = { walletId: string; accountId: string | null };

const isErrorCode = (value: unknown): value is BhwiErrorCode =>
  typeof value === 'string' && (BHWI_ERROR_CODES as readonly string[]).includes(value);

const mappedError = (error: unknown): BhwiError => {
  let code: unknown;
  if (typeof error === 'object' && error !== null && 'code' in error) code = error.code;
  return new BhwiError(isErrorCode(code) ? code : 'BHWI_INTERNAL');
};

let activeOwner: BhwiSession | null = null;

const sameSelection = (a: BhwiSelection | null, b: BhwiSelection): boolean =>
  a !== null && a.walletId === b.walletId && a.accountId === b.accountId;

export const isBhwiAvailable = (): boolean => Platform.OS === 'android' && NativeBhwi !== null;

export function addBhwiHostActiveListener(listener: (active: boolean) => void) {
  if (!isBhwiAvailable() || NativeBhwi === null) return undefined;
  const subscription = NativeBhwi.onHostActiveChange(listener);
  listener(NativeBhwi.getHostActive());
  return subscription;
}

export class BhwiSession {
  private closed = false;
  private readonly sessionId: string;
  private readonly selection: BhwiSelection;
  private readonly getSelection: () => BhwiSelection | null;

  constructor(sessionId: string, selection: BhwiSelection, getSelection: () => BhwiSelection | null) {
    this.sessionId = sessionId;
    this.selection = selection;
    this.getSelection = getSelection;
  }

  private assertOwned(): void {
    if (this.closed || activeOwner !== this) throw new BhwiError('BHWI_CANCELLED');
  }

  private selectionIsCurrent(): boolean {
    try {
      return sameSelection(this.getSelection(), this.selection);
    } catch {
      return false;
    }
  }

  private async cancelStale(native: NonNullable<typeof NativeBhwi>): Promise<never> {
    this.assertOwned();
    try {
      await native.disconnect(this.sessionId);
      this.assertOwned();
      this.selectionIsCurrent();
    } catch {
      this.assertOwned();
      this.selectionIsCurrent();
    }
    this.closed = true;
    if (activeOwner === this) activeOwner = null;
    throw new BhwiError('BHWI_CANCELLED');
  }

  private async call<T>(operation: (native: NonNullable<typeof NativeBhwi>) => Promise<T>): Promise<T> {
    this.assertOwned();
    if (!isBhwiAvailable() || NativeBhwi === null) throw new BhwiError('BHWI_UNAVAILABLE');
    if (!this.selectionIsCurrent()) return this.cancelStale(NativeBhwi);
    try {
      const result = await operation(NativeBhwi);
      this.assertOwned();
      if (!this.selectionIsCurrent()) return this.cancelStale(NativeBhwi);
      return result;
    } catch (error) {
      this.assertOwned();
      if (!this.selectionIsCurrent()) return this.cancelStale(NativeBhwi);
      throw mappedError(error);
    }
  }

  async discover(transport: 'usb' | 'ble'): Promise<Device[]> {
    if (transport === 'ble') {
      const apiLevel = typeof Platform.Version === 'string' ? Number.parseInt(Platform.Version, 10) : Platform.Version;
      const permissions =
        apiLevel >= 31
          ? [PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN, PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT]
          : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
      let statuses: Record<string, string>;
      try {
        statuses = await PermissionsAndroid.requestMultiple(permissions);
      } catch {
        this.assertOwned();
        if (!this.selectionIsCurrent() && NativeBhwi !== null) return this.cancelStale(NativeBhwi);
        throw new BhwiError('BHWI_PERMISSION_DENIED');
      }
      this.assertOwned();
      if (!this.selectionIsCurrent() && NativeBhwi !== null) return this.cancelStale(NativeBhwi);
      if (permissions.some(permission => statuses[permission] !== PermissionsAndroid.RESULTS.GRANTED)) {
        throw new BhwiError('BHWI_PERMISSION_DENIED');
      }
    }
    this.assertOwned();
    if (!this.selectionIsCurrent() && NativeBhwi !== null) return this.cancelStale(NativeBhwi);
    const devices = await this.call(native => native.discover(this.sessionId, transport));
    this.assertOwned();
    if (!this.selectionIsCurrent() && NativeBhwi !== null) return this.cancelStale(NativeBhwi);
    return devices;
  }

  connect(deviceId: string): Promise<DeviceInfo> {
    return this.call(native => native.connect(this.sessionId, deviceId));
  }

  getAccount(path: string, format: BhwiAccountFormat): Promise<Account> {
    return this.call(native => native.getAccount(this.sessionId, path, format));
  }

  registerWallet(name: string, descriptor: string): Promise<Registration> {
    return this.call(native => native.registerWallet(this.sessionId, name, descriptor));
  }

  displaySinglesigAddress(path: string, format: BhwiAccountFormat): Promise<string> {
    return this.call(native => native.displaySinglesigAddress(this.sessionId, path, format));
  }

  displayDescriptorAddress(policy: Policy, change: boolean, index: number): Promise<string> {
    return this.call(native => native.displayDescriptorAddress(this.sessionId, policy, change, index));
  }

  displayMultisigAddress(threshold: number, format: BhwiAccountFormat, keys: string[]): Promise<string> {
    return this.call(native => native.displayMultisigAddress(this.sessionId, threshold, format, keys));
  }

  signPsbt(psbtBase64: string, policy: Policy | null): Promise<string> {
    return this.call(native => native.signPsbt(this.sessionId, psbtBase64, policy));
  }

  signMessage(path: string, format: BhwiSinglesigFormat, message: string): Promise<string> {
    return this.call(native => native.signMessage(this.sessionId, path, format, message));
  }

  async disconnect(): Promise<void> {
    this.assertOwned();
    let failure: BhwiError | undefined;
    if (!isBhwiAvailable() || NativeBhwi === null) {
      failure = new BhwiError('BHWI_UNAVAILABLE');
    } else {
      try {
        await NativeBhwi.disconnect(this.sessionId);
      } catch (error) {
        failure = this.selectionIsCurrent() ? mappedError(error) : new BhwiError('BHWI_CANCELLED');
      }
    }
    const selectionIsCurrent = this.selectionIsCurrent();
    this.closed = true;
    if (activeOwner === this) activeOwner = null;
    if (failure) throw failure;
    if (!selectionIsCurrent) throw new BhwiError('BHWI_CANCELLED');
  }
}

export async function startBhwiSession(selection: BhwiSelection, getSelection: () => BhwiSelection | null): Promise<BhwiSession> {
  if (!isBhwiAvailable()) throw new BhwiError('BHWI_UNAVAILABLE');
  if (activeOwner !== null) throw new BhwiError('BHWI_BUSY');
  let bytes: Uint8Array;
  try {
    bytes = await randomBytes(16);
  } catch {
    throw new BhwiError('BHWI_INTERNAL');
  }
  if (bytes.length !== 16) throw new BhwiError('BHWI_INTERNAL');
  let currentSelection: BhwiSelection | null;
  try {
    currentSelection = getSelection();
  } catch {
    throw new BhwiError('BHWI_CANCELLED');
  }
  if (!sameSelection(currentSelection, selection)) throw new BhwiError('BHWI_CANCELLED');
  if (activeOwner !== null) throw new BhwiError('BHWI_BUSY');
  const owner = new BhwiSession(Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(''), { ...selection }, getSelection);
  activeOwner = owner;
  return owner;
}
