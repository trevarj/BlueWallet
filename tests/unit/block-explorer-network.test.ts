import type * as BlockExplorerModel from '../../models/blockExplorer';

let mockBitcoinNetwork: 'bitcoin' | 'testnet4' = 'bitcoin';

jest.mock('../../models/bitcoinNetwork', () => ({
  get bitcoinNetwork() {
    return mockBitcoinNetwork;
  },
}));

function loadBlockExplorer(network: 'bitcoin' | 'testnet4'): typeof BlockExplorerModel {
  mockBitcoinNetwork = network;
  let model: typeof BlockExplorerModel | undefined;
  jest.isolateModules(() => {
    model = require('../../models/blockExplorer');
  });
  if (!model) throw new Error('Block explorer model did not load');
  return model;
}

describe('block explorer network profile', () => {
  it('preserves all mainnet presets', () => {
    const model = loadBlockExplorer('bitcoin');

    expect(model.BLOCK_EXPLORERS).toEqual({
      default: { key: 'default', name: 'Mempool.space', url: 'https://mempool.space' },
      blockchair: { key: 'blockchair', name: 'Blockchair', url: 'https://blockchair.com/bitcoin' },
      blockstream: { key: 'blockstream', name: 'Blockstream.info', url: 'https://blockstream.info' },
      custom: { key: 'custom', name: 'Custom', url: '' },
    });
    expect(model.findMatchingExplorer('https://blockstream.info/testnet')).toBeNull();
    expect(model.findMatchingExplorer('https://blockstream.info/')).toBe(model.BLOCK_EXPLORERS.blockstream);
  });

  it('selects the complete Testnet4 Mempool base rather than matching only its hostname', async () => {
    const model = loadBlockExplorer('testnet4');

    await model.removeBlockExplorer();
    await expect(model.getBlockExplorerUrl()).resolves.toBe('https://mempool.space/testnet4');
    expect(model.BLOCK_EXPLORERS.default.url).toBe('https://mempool.space/testnet4');
    expect(model.getBlockExplorersList()).toEqual([model.BLOCK_EXPLORERS.default, model.BLOCK_EXPLORERS.custom]);
    expect(model.findMatchingExplorer('https://mempool.space')).toBeNull();
    expect(model.findMatchingExplorer('https://mempool.space/testnet')).toBeNull();
    expect(model.findMatchingExplorer('https://blockstream.info/testnet')).toBeNull();
    expect(model.findMatchingExplorer('https://mempool.space/testnet4/')).toBe(model.BLOCK_EXPLORERS.default);
  });
});
