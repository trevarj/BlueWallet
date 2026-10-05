import { Platform } from 'react-native';
import { bitcoinNetwork } from './bitcoinNetwork';

export const appScheme =
  Platform.OS === 'android' ? (bitcoinNetwork === 'testnet' ? 'bluewallet-bhwi-testnet' : 'bluewallet-bhwi') : 'bluewallet';
