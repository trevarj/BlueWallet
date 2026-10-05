// blockExplorer.ts
import DefaultPreference from 'react-native-default-preference';
import { bitcoinNetwork } from './bitcoinNetwork';

export interface BlockExplorer {
  key: string;
  name: string;
  url: string;
}

const mainnetBlockExplorers: { [key: string]: BlockExplorer } = {
  default: { key: 'default', name: 'Mempool.space', url: 'https://mempool.space' },
  blockchair: { key: 'blockchair', name: 'Blockchair', url: 'https://blockchair.com/bitcoin' },
  blockstream: { key: 'blockstream', name: 'Blockstream.info', url: 'https://blockstream.info' },
  custom: { key: 'custom', name: 'Custom', url: '' },
};

const testnetBlockExplorers: { [key: string]: BlockExplorer } = {
  default: { key: 'default', name: 'Blockstream.info', url: 'https://blockstream.info/testnet' },
  custom: { key: 'custom', name: 'Custom', url: '' },
};

export const BLOCK_EXPLORERS = bitcoinNetwork === 'testnet' ? testnetBlockExplorers : mainnetBlockExplorers;

export const getBlockExplorersList = (): BlockExplorer[] => {
  return Object.values(BLOCK_EXPLORERS);
};

export const normalizeUrl = (url: string): string => {
  return url.replace(/\/+$/, '');
};

export const isValidUrl = (url: string): boolean => {
  const pattern = /^(https?:\/\/)/;
  return pattern.test(url);
};

export const findMatchingExplorer = (url: string): BlockExplorer | null => {
  const normalizedUrl = normalizeUrl(url);
  return Object.values(BLOCK_EXPLORERS).find(explorer => normalizeUrl(explorer.url) === normalizedUrl) ?? null;
};

const BLOCK_EXPLORER_STORAGE_KEY = 'blockExplorer';

export const saveBlockExplorer = async (url: string): Promise<boolean> => {
  try {
    await DefaultPreference.set(BLOCK_EXPLORER_STORAGE_KEY, url);
    return true;
  } catch (error) {
    console.error('Error saving block explorer:', error);
    return false;
  }
};

export const removeBlockExplorer = async (): Promise<boolean> => {
  try {
    await DefaultPreference.clear(BLOCK_EXPLORER_STORAGE_KEY);
    return true;
  } catch (error) {
    console.error('Error removing block explorer:', error);
    return false;
  }
};

export const getBlockExplorerUrl = async (): Promise<string> => {
  try {
    const url = (await DefaultPreference.get(BLOCK_EXPLORER_STORAGE_KEY)) as string | null;
    return url ?? BLOCK_EXPLORERS.default.url;
  } catch (error) {
    console.error('Error getting block explorer:', error);
    return BLOCK_EXPLORERS.default.url;
  }
};
