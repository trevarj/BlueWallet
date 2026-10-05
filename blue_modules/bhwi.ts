import { PermissionsAndroid, Platform } from 'react-native';
import { randomBytes } from '../class/rng';
import NativeBhwi from '../codegen/NativeBhwi';
import type { Account, BhwiAccountFormat, Device, DeviceInfo, Policy, Registration } from '../codegen/NativeBhwi';

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
export type BhwiSelection = { walletId: string; accountId: string | null };

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

class BhwiSession {
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
    if (!isBhwiAvailable() || NativeBhwi === null) throw new BhwiError('BHWI_UNAVAILABLE');
    try {
      await NativeBhwi.disconnect(this.sessionId);
    } catch (error) {
      this.assertOwned();
      if (!this.selectionIsCurrent()) throw new BhwiError('BHWI_CANCELLED');
      throw mappedError(error);
    }
    this.assertOwned();
    const selectionIsCurrent = this.selectionIsCurrent();
    this.closed = true;
    if (activeOwner === this) activeOwner = null;
    if (!selectionIsCurrent) throw new BhwiError('BHWI_CANCELLED');
  }
}

export async function createBhwiSession(selection: BhwiSelection, getSelection: () => BhwiSelection | null): Promise<BhwiSession> {
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
