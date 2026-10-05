import { TurboModuleRegistry } from 'react-native';
import type { TurboModule } from 'react-native';
import type { Int32 } from 'react-native/Libraries/Types/CodegenTypes';

export type BhwiFamily = 'bitbox02' | 'coldcard' | 'jade' | 'ledger' | 'keepkey' | 'specter' | 'trezor';
export type BhwiTransport = 'usb' | 'ble';
export type BhwiAccountFormat =
  | 'legacy'
  | 'nested-segwit'
  | 'native-segwit'
  | 'taproot'
  | 'multisig-legacy'
  | 'multisig-wrapped'
  | 'multisig-native';

export type Device = {
  id: string;
  name: string;
  family: BhwiFamily;
  transport: BhwiTransport;
};

export type DeviceInfo = {
  family: BhwiFamily;
  fingerprint: string;
  version: string | null;
  model: string | null;
};

export type Account = {
  family: BhwiFamily;
  fingerprint: string;
  path: string;
  xpub: string;
  format: BhwiAccountFormat;
  descriptor: string | null;
};

export type Registration = {
  status: 'complete' | 'pending';
  hmacHex: string | null;
};

export type Policy = {
  name: string;
  descriptor: string;
  ledgerHmacHex: string | null;
};

export interface Spec extends TurboModule {
  discover(sessionId: string, transport: string): Promise<Device[]>;
  connect(sessionId: string, deviceId: string): Promise<DeviceInfo>;
  getAccount(sessionId: string, path: string, format: string): Promise<Account>;
  registerWallet(sessionId: string, name: string, descriptor: string): Promise<Registration>;
  displaySinglesigAddress(sessionId: string, path: string, format: string): Promise<string>;
  displayDescriptorAddress(sessionId: string, policy: Policy, change: boolean, index: Int32): Promise<string>;
  displayMultisigAddress(sessionId: string, threshold: Int32, format: string, keys: string[]): Promise<string>;
  signPsbt(sessionId: string, psbtBase64: string, policy: Policy | null): Promise<string>;
  signMessage(sessionId: string, path: string, message: string): Promise<string>;
  disconnect(sessionId: string): Promise<void>;
}

export default TurboModuleRegistry.get<Spec>('Bhwi');
