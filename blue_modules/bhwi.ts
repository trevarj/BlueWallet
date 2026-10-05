/* eslint-disable no-bitwise */
import { PermissionsAndroid, Platform } from 'react-native';
import { randomBytes } from '../class/rng';
import { decodeExtendedKey } from '../class/wallets/extended-key';
import NativeBhwi from '../codegen/NativeBhwi';
import type { Account, BhwiAccountFormat, BhwiFamily, Device, DeviceInfo, Policy, Registration } from '../codegen/NativeBhwi';
import { coinType } from '../models/bitcoinNetwork';

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

export const BHWI_MAX_ACCOUNT_INDEX = 0x7fffffff;
export const BHWI_SINGLESIG_FORMATS: readonly BhwiSinglesigFormat[] = ['legacy', 'nested-segwit', 'native-segwit', 'taproot'];

const BHWI_FAMILIES: readonly BhwiFamily[] = ['bitbox02', 'coldcard', 'jade', 'ledger', 'keepkey', 'specter', 'trezor'];
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

  signMessage(path: string, message: string): Promise<string> {
    return this.call(native => native.signMessage(this.sessionId, path, message));
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
