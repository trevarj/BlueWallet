/// <reference lib="es2024.promise" />
import { createHash } from 'crypto';
import { networks, payments } from 'bitcoinjs-lib';
import DefaultPreference from 'react-native-default-preference';
import * as BlueElectrum from '../../blue_modules/BlueElectrum';

const TESTNET4_GENESIS = '00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043';
const TESTNET4_GENESIS_HEADER =
  '0100000000000000000000000000000000000000000000000000000000000000000000004e7b2b9128fe0291db0693af2ae418b767e657cd407e80cb1434221eaea7a07a046f3566ffff001dbb0c7817';
// Testnet3 is a negative chain fixture, not an app profile or supported backend.
const TESTNET3_GENESIS = '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943';
const TESTNET3_GENESIS_HEADER =
  '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4adae5494dffff001d1aa4ae18';
// Synthetic tip: deterministic timestamp/height, not a mined header or live checkpoint.
const TIP_HEIGHT = 155_000;
const TIP_TIME = 1_720_000_000;
const tipHeader = Buffer.from(TESTNET4_GENESIS_HEADER, 'hex');
tipHeader.writeUInt32LE(TIP_TIME, 68);
const TIP_HEADER = tipHeader.toString('hex');

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
  __testnetFeatures: unknown;
  __testnetClients: TestClient[];
  __testnetConstructorArgs: unknown[][];
  __configureTestnetClient?: (client: TestClient) => void;
  __createTestnetElectrumClient: (...args: unknown[]) => TestClient;
};

jest.mock('../../models/bitcoinNetwork', () => {
  const { networks: bitcoinNetworks } = jest.requireActual('bitcoinjs-lib') as { networks: typeof networks };
  return {
    bitcoinNetwork: 'testnet4',
    coinType: 1,
    genesisHash: '00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043',
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
testGlobals.__testnetFeatures = { genesis_hash: TESTNET4_GENESIS, hash_function: 'sha256' };
testGlobals.__createTestnetElectrumClient = (...args: unknown[]) => {
  const client: TestClient = {
    host: String(args[3]),
    port: Number(args[2]),
    connect: jest.fn().mockResolvedValue(undefined),
    initElectrum: jest.fn().mockResolvedValue(['Fulcrum 2.1.3', '1.4']),
    server_version: jest.fn().mockResolvedValue(['Fulcrum 2.1.3', '1.4']),
    server_features: jest.fn(() => Promise.resolve(testGlobals.__testnetFeatures)),
    server_ping: jest.fn().mockResolvedValue(undefined),
    blockchainBlock_header: jest.fn((height: number) => Promise.resolve(height === 0 ? TESTNET4_GENESIS_HEADER : TIP_HEADER)),
    blockchainHeaders_subscribe: jest.fn().mockResolvedValue({ height: TIP_HEIGHT, hex: TIP_HEADER }),
    blockchainScripthash_getBalance: jest.fn().mockResolvedValue({ confirmed: 1, unconfirmed: 0 }),
    close: jest.fn(),
  };
  testGlobals.__configureTestnetClient?.(client);
  testGlobals.__testnetClients.push(client);
  testGlobals.__testnetConstructorArgs.push(args);
  return client;
};

describe('Testnet4 Electrum profile', () => {
  beforeEach(async () => {
    BlueElectrum.forceDisconnect();
    await BlueElectrum.setDisabled(false);
    await DefaultPreference.clear(BlueElectrum.ELECTRUM_HOST);
    await DefaultPreference.clear(BlueElectrum.ELECTRUM_TCP_PORT);
    await DefaultPreference.clear(BlueElectrum.ELECTRUM_SSL_PORT);
    testGlobals.__testnetClients.length = 0;
    testGlobals.__testnetConstructorArgs.length = 0;
    testGlobals.__configureTestnetClient = undefined;
    testGlobals.__testnetFeatures = { genesis_hash: TESTNET4_GENESIS, hash_function: 'sha256' };
  });

  afterEach(() => BlueElectrum.forceDisconnect());

  it('independently hashes the exact BIP94 genesis header', () => {
    const header = Buffer.from(TESTNET4_GENESIS_HEADER, 'hex');
    expect(header).toHaveLength(80);
    const hash = createHash('sha256').update(createHash('sha256').update(header).digest()).digest().reverse().toString('hex');
    expect(hash).toBe(TESTNET4_GENESIS);
    expect(header.readUInt32LE(68)).toBe(1_714_777_860);
  });

  it('uses only the verified Testnet4 TLS peer and actual header timestamps without mainnet extrapolation', async () => {
    expect(BlueElectrum.hardcodedPeers).toEqual([{ host: 'blackie.c3-soft.com', ssl: 57010 }]);
    await expect(BlueElectrum.ensureConnected()).resolves.toBe(true);
    expect(testGlobals.__testnetConstructorArgs[0].slice(2)).toEqual([57010, 'blackie.c3-soft.com', 'tls', { rejectUnauthorized: true }]);
    expect(testGlobals.__testnetClients[0].server_features).toHaveBeenCalledTimes(1);
    expect(BlueElectrum.getConnectionState()).toBe('connected');
    await expect(BlueElectrum.getCurrentBlockTip()).resolves.toBe(TIP_HEIGHT);
    expect(BlueElectrum.calculateBlockTime(TIP_HEIGHT)).toBe(TIP_TIME);
    expect(BlueElectrum.calculateBlockTime(TIP_HEIGHT - 1)).toBe(0);
    const now = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 86_400_000);
    try {
      expect(BlueElectrum.estimateCurrentBlockheight()).toBe(TIP_HEIGHT);
    } finally {
      now.mockRestore();
    }
  });

  it('ignores saved TCP-only peers rather than downgrading TLS', async () => {
    await DefaultPreference.set(BlueElectrum.ELECTRUM_HOST, 'tcp-only.example');
    await DefaultPreference.set(BlueElectrum.ELECTRUM_TCP_PORT, '50001');
    await expect(BlueElectrum.ensureConnected()).resolves.toBe(true);
    expect(testGlobals.__testnetConstructorArgs[0].slice(2)).toEqual([57010, 'blackie.c3-soft.com', 'tls', { rejectUnauthorized: true }]);
    await expect(BlueElectrum.testConnection('custom.example', 50001)).resolves.toBe(false);
    expect(testGlobals.__testnetClients).toHaveLength(1);
  });

  it.each([
    ['Testnet3', { genesis_hash: TESTNET3_GENESIS, hash_function: 'sha256' }],
    ['Bitcoin', { genesis_hash: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f', hash_function: 'sha256' }],
    ['Signet', { genesis_hash: '00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6', hash_function: 'sha256' }],
    ['wrong hash function', { genesis_hash: TESTNET4_GENESIS, hash_function: 'sha256d' }],
    ['missing hash function', { genesis_hash: TESTNET4_GENESIS }],
    ['missing genesis', { hash_function: 'sha256' }],
    ['missing features', null],
  ])('rejects %s features without a permissive header fallback', async (_label, features) => {
    testGlobals.__testnetFeatures = features;
    await expect(BlueElectrum.testConnection('wrong-chain.example', undefined, 57010)).resolves.toBe(false);
    const client = testGlobals.__testnetClients[0];
    expect(client.blockchainBlock_header).not.toHaveBeenCalled();
    expect(client.blockchainHeaders_subscribe).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalled();
  });

  it('keeps the provisional default client unavailable until chain and tip verification finish', async () => {
    const { promise: features, resolve: releaseFeatures } = Promise.withResolvers<unknown>();
    const { promise: queried, resolve: markQueried } = Promise.withResolvers<void>();
    testGlobals.__configureTestnetClient = client =>
      client.server_features.mockImplementation(() => {
        markQueried();
        return features;
      });
    const connection = BlueElectrum.ensureConnected();
    await queried;
    expect(testGlobals.__testnetClients[0].server_features).toHaveBeenCalledTimes(1);
    expect(BlueElectrum.getConnectionState()).toBe('connecting');
    await expect(BlueElectrum.ping()).resolves.toBe(false);
    expect(testGlobals.__testnetClients[0].server_ping).not.toHaveBeenCalled();
    releaseFeatures({ genesis_hash: TESTNET4_GENESIS, hash_function: 'sha256' });
    await expect(connection).resolves.toBe(true);
    expect(testGlobals.__testnetClients[0].blockchainHeaders_subscribe).toHaveBeenCalledTimes(1);
    expect(BlueElectrum.getConnectionState()).toBe('connected');
  });

  it('never publishes a default connection to the obsolete Testnet3 chain', async () => {
    jest.useFakeTimers();
    try {
      testGlobals.__testnetFeatures = { genesis_hash: TESTNET3_GENESIS, hash_function: 'sha256' };
      const connection = BlueElectrum.ensureConnected();
      await jest.advanceTimersByTimeAsync(2_500);
      await expect(connection).resolves.toBe(false);
      expect(BlueElectrum.getConnectionState()).toBe('disconnected');
      await expect(BlueElectrum.ping()).resolves.toBe(false);
      expect(testGlobals.__testnetClients.length).toBeGreaterThan(0);
      for (const client of testGlobals.__testnetClients) {
        expect(client.close).toHaveBeenCalled();
        expect(client.blockchainHeaders_subscribe).not.toHaveBeenCalled();
        expect(client.blockchainBlock_header).not.toHaveBeenCalled();
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it('accepts only the explicit unsupported-features route with a matching full genesis header', async () => {
    testGlobals.__configureTestnetClient = client =>
      client.server_features.mockRejectedValue({ code: -32601, message: 'Method not found' });
    await expect(BlueElectrum.testConnection('legacy.example', undefined, 57010)).resolves.toBe(true);
    expect(testGlobals.__testnetClients[0].blockchainBlock_header).toHaveBeenCalledWith(0);
    expect(testGlobals.__testnetConstructorArgs[0].slice(2)).toEqual([57010, 'legacy.example', 'tls', { rejectUnauthorized: true }]);
  });

  it.each([TESTNET3_GENESIS_HEADER, '00', 'zz'.repeat(80), undefined])('rejects a wrong or malformed fallback header %p', async header => {
    testGlobals.__configureTestnetClient = client => {
      client.server_features.mockRejectedValue({ code: -32601, message: 'Method not found' });
      client.blockchainBlock_header.mockResolvedValue(header);
    };
    await expect(BlueElectrum.testConnection('legacy-wrong.example', undefined, 57010)).resolves.toBe(false);
    expect(testGlobals.__testnetClients[0].blockchainHeaders_subscribe).not.toHaveBeenCalled();
  });

  it('does not fall back on an ordinary features failure', async () => {
    testGlobals.__configureTestnetClient = client => client.server_features.mockRejectedValue(new Error('Connection lost'));
    await expect(BlueElectrum.testConnection('broken.example', undefined, 57010)).resolves.toBe(false);
    expect(testGlobals.__testnetClients[0].blockchainBlock_header).not.toHaveBeenCalled();
  });

  it('fetches the actual tip header when subscription omits it', async () => {
    testGlobals.__configureTestnetClient = client => client.blockchainHeaders_subscribe.mockResolvedValue({ height: TIP_HEIGHT });
    await expect(BlueElectrum.ensureConnected()).resolves.toBe(true);
    expect(testGlobals.__testnetClients[0].blockchainBlock_header).toHaveBeenCalledWith(TIP_HEIGHT);
    expect(BlueElectrum.calculateBlockTime(TIP_HEIGHT)).toBe(TIP_TIME);
    await expect(BlueElectrum.testConnection('headerless.example', undefined, 57010)).resolves.toBe(true);
    expect(testGlobals.__testnetClients[1].blockchainBlock_header).toHaveBeenCalledWith(TIP_HEIGHT);
  });

  it.each(['00', 'zz'.repeat(80)])('rejects malformed subscription header %p', async hex => {
    testGlobals.__configureTestnetClient = client => client.blockchainHeaders_subscribe.mockResolvedValue({ height: TIP_HEIGHT, hex });
    await expect(BlueElectrum.testConnection('bad-header.example', undefined, 57010)).resolves.toBe(false);
    expect(testGlobals.__testnetClients[0].server_ping).not.toHaveBeenCalled();
  });

  it.each([undefined, '00', 'zz'.repeat(80)])('rejects an unavailable or malformed fetched tip header %p', async header => {
    testGlobals.__configureTestnetClient = client => {
      client.blockchainHeaders_subscribe.mockResolvedValue({ height: TIP_HEIGHT });
      client.blockchainBlock_header.mockResolvedValue(header);
    };
    await expect(BlueElectrum.testConnection('tipless.example', undefined, 57010)).resolves.toBe(false);
    expect(testGlobals.__testnetClients[0].server_ping).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, '155000', true, Number.MAX_SAFE_INTEGER + 1])('rejects invalid tip height %p', async height => {
    testGlobals.__configureTestnetClient = client => client.blockchainHeaders_subscribe.mockResolvedValue({ height, hex: TIP_HEADER });
    await expect(BlueElectrum.testConnection('bad-tip.example', undefined, 57010)).resolves.toBe(false);
  });

  it('rejects incompatible protocol and TLS failures before chain queries', async () => {
    testGlobals.__configureTestnetClient = client => client.server_version.mockResolvedValue(['Fulcrum', '1.3']);
    await expect(BlueElectrum.testConnection('old-protocol.example', undefined, 57010)).resolves.toBe(false);
    expect(testGlobals.__testnetClients[0].server_features).not.toHaveBeenCalled();
    testGlobals.__configureTestnetClient = client => client.connect.mockRejectedValue(new Error('Certificate hostname mismatch'));
    await expect(BlueElectrum.testConnection('bad-tls.example', undefined, 57010)).resolves.toBe(false);
    expect(testGlobals.__testnetClients[1].server_features).not.toHaveBeenCalled();
    expect(testGlobals.__testnetClients[1].close).toHaveBeenCalled();
  });

  it('retires a timed-out features request without late fallback or tip publication', async () => {
    jest.useFakeTimers();
    const { promise: features, resolve: releaseFeatures } = Promise.withResolvers<unknown>();
    try {
      testGlobals.__configureTestnetClient = client => client.server_features.mockReturnValue(features);
      const connection = BlueElectrum.testConnection('stalled.example', undefined, 57010);
      await jest.advanceTimersByTimeAsync(5_000);
      await expect(connection).resolves.toBe(false);
      expect(testGlobals.__testnetClients[0].close).toHaveBeenCalled();
      releaseFeatures({ genesis_hash: TESTNET4_GENESIS, hash_function: 'sha256' });
      await jest.advanceTimersByTimeAsync(0);
      expect(testGlobals.__testnetClients[0].blockchainHeaders_subscribe).not.toHaveBeenCalled();
      expect(testGlobals.__testnetClients[0].blockchainBlock_header).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('retains the test address encoding family for address scripthashes', async () => {
    await BlueElectrum.ensureConnected();
    const address = payments.p2wpkh({ hash: Buffer.alloc(20, 7), network: networks.testnet }).address;
    if (!address) throw new Error('Failed to construct test-encoded fixture address');
    await expect(BlueElectrum.getBalanceByAddress(address)).resolves.toMatchObject({ confirmed: 1, unconfirmed: 0 });
    expect(testGlobals.__testnetClients[0].blockchainScripthash_getBalance).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f]{64}$/));
  });
});
