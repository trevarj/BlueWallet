import { networks, payments } from 'bitcoinjs-lib';
import * as BlueElectrum from '../../blue_modules/BlueElectrum';

const TESTNET_GENESIS = '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943';
const TESTNET_GENESIS_HEADER =
  '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4adae5494dffff001d1aa4ae18';

type Features = { genesis_hash: string; hash_function: string };
type TestClient = {
  onError?: (error: { message: string }) => void;
  host: string;
  port: number;
  connect: jest.Mock;
  initElectrum: jest.Mock;
  server_version: jest.Mock;
  server_features: jest.Mock;
  server_ping: jest.Mock;
  blockchainBlock_header: jest.Mock;
  blockchainHeaders_subscribe: jest.Mock;
  blockchainScripthash_getBalance: jest.Mock;
  close: jest.Mock;
};
type TestGlobals = typeof globalThis & {
  __testnetFeatures: Features;
  __testnetClients: TestClient[];
  __testnetConstructorArgs: unknown[][];
  __createTestnetElectrumClient: (...args: unknown[]) => TestClient;
};

jest.mock('../../models/bitcoinNetwork', () => {
  const { networks: bitcoinNetworks } = jest.requireActual('bitcoinjs-lib') as { networks: typeof networks };
  return {
    bitcoinNetwork: 'testnet',
    coinType: 1,
    genesisHash: '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943',
    network: bitcoinNetworks.testnet,
  };
});

jest.mock('electrum-client', () => {
  return jest
    .fn()
    .mockImplementation((...args: unknown[]) => (globalThis as unknown as TestGlobals).__createTestnetElectrumClient(...args));
});

const testGlobals = globalThis as unknown as TestGlobals;
testGlobals.__testnetClients = [];
testGlobals.__testnetConstructorArgs = [];
testGlobals.__testnetFeatures = { genesis_hash: TESTNET_GENESIS, hash_function: 'sha256' };
testGlobals.__createTestnetElectrumClient = (...args: unknown[]) => {
  const client: TestClient = {
    host: String(args[3]),
    port: Number(args[2]),
    connect: jest.fn().mockResolvedValue(undefined),
    initElectrum: jest.fn().mockResolvedValue(['Fulcrum 1.10.0', '1.4']),
    server_version: jest.fn().mockResolvedValue(['Fulcrum 1.10.0', '1.4']),
    server_features: jest.fn(() => Promise.resolve(testGlobals.__testnetFeatures)),
    server_ping: jest.fn().mockResolvedValue(undefined),
    blockchainBlock_header: jest.fn().mockResolvedValue(TESTNET_GENESIS_HEADER),
    blockchainHeaders_subscribe: jest.fn().mockResolvedValue({ height: 4_806_000, hex: TESTNET_GENESIS_HEADER }),
    blockchainScripthash_getBalance: jest.fn().mockResolvedValue({ confirmed: 1, unconfirmed: 0 }),
    close: jest.fn(),
  };
  testGlobals.__testnetClients.push(client);
  testGlobals.__testnetConstructorArgs.push(args);
  return client;
};

describe('Testnet3 Electrum profile', () => {
  beforeEach(async () => {
    BlueElectrum.forceDisconnect();
    await BlueElectrum.setDisabled(false);
    testGlobals.__testnetClients.length = 0;
    testGlobals.__testnetConstructorArgs.length = 0;
    testGlobals.__testnetFeatures = { genesis_hash: TESTNET_GENESIS, hash_function: 'sha256' };
  });

  it('uses only the verified Testnet3 peer and publishes it after chain/tip validation', async () => {
    expect(BlueElectrum.hardcodedPeers).toEqual([{ host: 'blackie.c3-soft.com', ssl: 57006 }]);

    await expect(BlueElectrum.ensureConnected()).resolves.toBe(true);

    expect(testGlobals.__testnetConstructorArgs[0].slice(2)).toEqual([57006, 'blackie.c3-soft.com', 'tls', { rejectUnauthorized: true }]);
    expect(testGlobals.__testnetClients[0].server_features).toHaveBeenCalledTimes(1);
    expect(BlueElectrum.getConnectionState()).toBe('connected');
    await expect(BlueElectrum.getCurrentBlockTip()).resolves.toBe(4_806_000);
    expect(BlueElectrum.calculateBlockTime(4_806_000)).toBe(1_296_688_602);
    expect(BlueElectrum.calculateBlockTime(4_805_999)).toBe(0);
    expect(BlueElectrum.estimateCurrentBlockheight()).toBe(4_806_000);
  });

  it('validates custom peers with strict TLS and rejects TCP-only or other chains', async () => {
    await expect(BlueElectrum.testConnection('custom.example', 50001)).resolves.toBe(false);
    expect(testGlobals.__testnetClients).toHaveLength(0);

    testGlobals.__testnetFeatures = {
      genesis_hash: '00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043',
      hash_function: 'sha256',
    };
    await expect(BlueElectrum.testConnection('custom.example', undefined, 50002)).resolves.toBe(false);
    expect(testGlobals.__testnetClients[0].blockchainHeaders_subscribe).not.toHaveBeenCalled();
    expect(testGlobals.__testnetClients[0].close).toHaveBeenCalled();

    testGlobals.__testnetFeatures = {
      genesis_hash: '00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6',
      hash_function: 'sha256',
    };
    await expect(BlueElectrum.testConnection('signet.example', undefined, 50002)).resolves.toBe(false);
    expect(testGlobals.__testnetClients[1].blockchainHeaders_subscribe).not.toHaveBeenCalled();

    testGlobals.__testnetFeatures = { genesis_hash: TESTNET_GENESIS, hash_function: 'sha256' };
    await expect(BlueElectrum.testConnection('custom.example', undefined, 50002)).resolves.toBe(true);
    expect(testGlobals.__testnetConstructorArgs[2].slice(2)).toEqual([50002, 'custom.example', 'tls', { rejectUnauthorized: true }]);
  });

  it('uses the selected bitcoinjs network for Testnet3 address scripthashes', async () => {
    await BlueElectrum.ensureConnected();
    const address = payments.p2wpkh({ hash: Buffer.alloc(20, 7), network: networks.testnet }).address;
    if (!address) throw new Error('Failed to construct Testnet3 fixture address');

    await expect(BlueElectrum.getBalanceByAddress(address)).resolves.toMatchObject({ confirmed: 1, unconfirmed: 0 });
    expect(testGlobals.__testnetClients[0].blockchainScripthash_getBalance).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f]{64}$/));
  });
});
