import { Platform } from 'react-native';
import { bitcoinNetwork } from './bitcoinNetwork';

export const appScheme =
  Platform.OS === 'android' ? (bitcoinNetwork === 'testnet4' ? 'bluewallet-bhwi-testnet4' : 'bluewallet-bhwi') : 'bluewallet';
