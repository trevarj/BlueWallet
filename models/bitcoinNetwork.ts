import { networks } from 'bitcoinjs-lib';
import { Platform } from 'react-native';
import SettingsModule from '../blue_modules/SettingsModule';

const nativeNetwork = Platform.OS === 'android' ? SettingsModule?.getConstants?.()?.bitcoinNetwork : 'bitcoin';
if (nativeNetwork !== 'bitcoin' && nativeNetwork !== 'testnet') {
  throw new Error('Missing or invalid Android bitcoinNetwork build constant');
}

export const bitcoinNetwork = nativeNetwork;
export const network = bitcoinNetwork === 'testnet' ? networks.testnet : networks.bitcoin;
export const coinType = bitcoinNetwork === 'testnet' ? 1 : 0;
export const genesisHash =
  bitcoinNetwork === 'testnet'
    ? '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943'
    : '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';
