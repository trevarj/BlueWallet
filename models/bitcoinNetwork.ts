import { networks } from 'bitcoinjs-lib';
import { Platform } from 'react-native';
import SettingsModule from '../blue_modules/SettingsModule';

const nativeNetwork = Platform.OS === 'android' ? SettingsModule?.getConstants?.()?.bitcoinNetwork : 'bitcoin';
if (nativeNetwork !== 'bitcoin' && nativeNetwork !== 'testnet4') {
  throw new Error('Missing or invalid Android bitcoinNetwork build constant');
}

export const bitcoinNetwork = nativeNetwork;
export const mainnetServicesEnabled = bitcoinNetwork === 'bitcoin';
export const networkDisplayName = mainnetServicesEnabled ? 'Bitcoin' : 'Testnet4';
export const labelForNetwork = (label: string): string => (mainnetServicesEnabled ? label : `${label} — ${networkDisplayName}`);
export const MAINNET_SERVICES_UNAVAILABLE = 'This feature is unavailable on Testnet4.';
export const assertMainnetServicesEnabled = (): void => {
  if (!mainnetServicesEnabled) throw new Error(MAINNET_SERVICES_UNAVAILABLE);
};
export const network = bitcoinNetwork === 'testnet4' ? networks.testnet : networks.bitcoin;
export const coinType = bitcoinNetwork === 'testnet4' ? 1 : 0;

export const normalizeDerivationPath = (path: string): string =>
  path.trim().replace(/[‘’]/g, "'").replace(/[hH]/g, "'").replace(/^M\//, 'm/');

export const isCompatibleOrigin = (path: string): boolean => {
  const normalizedPath = normalizeDerivationPath(path);
  const conventionalOrigin = normalizedPath.match(/^m\/(?:44|48|49|84|86)'\/(\d+)'(?:\/|$)/);
  return !conventionalOrigin || Number(conventionalOrigin[1]) === coinType;
};

export type MultisigPathFormat = 'legacy' | 'wrapped' | 'native';

export const getMultisigPathFormat = (path: string): MultisigPathFormat | undefined => {
  const normalizedPath = normalizeDerivationPath(path);
  if (normalizedPath === "m/45'") return 'legacy';
  const bip48 = normalizedPath.match(/^m\/48'\/(\d+)'\/\d+'\/([12])'$/);
  if (!bip48 || Number(bip48[1]) !== coinType) return undefined;
  return bip48[2] === '2' ? 'native' : 'wrapped';
};

export const mapStandardAccountPath = (path: string): string => path.replace(/^m\/(44|48|49|84|86)'\/0'(?=\/|$)/, `m/$1'/${coinType}'`);
export const genesisHash =
  bitcoinNetwork === 'testnet4'
    ? '00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043'
    : '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';
