/**
 * Unit tests for the BlueElectrum connection lifecycle / state machine.
 *
 * Exercises the bits that have no isolated coverage today: coalescing of
 * concurrent `ensureConnected()` callers, the generation counter that lets
 * `forceDisconnect()`/`setDisabled()` abort an in-flight connect, ping flips,
 * and the swap-check that guards against a stale client clobbering newer state.
 */

import * as BlueElectrum from '../../blue_modules/BlueElectrum';

// Jest hoists these above the import above. The factories close over `globalThis`
// so the test body can swap implementations per-test without re-mocking.
type TestGlobals = typeof globalThis & {
  __createNextFakeClient: (...args: unknown[]) => FakeClient;
  __presentAlertSpy?: jest.Mock;
};
jest.mock('electrum-client', () => {
  return jest.fn().mockImplementation((...args: unknown[]) => (globalThis as unknown as TestGlobals).__createNextFakeClient(...args));
});

jest.mock('../../components/Alert', () => ({
  __esModule: true,
  default: (...args: unknown[]) => (globalThis as unknown as TestGlobals).__presentAlertSpy?.(...args),
}));

type FakeClient = {
  initElectrumDeferred: Deferred<[string, string]>;
  headersDeferred: Deferred<{ height: unknown; hex?: string }>;
  pingDeferred: Deferred<unknown> | null;
  pingShouldReject: boolean;
  closed: boolean;
  onError?: (e: { message: string }) => void;
  host: string;
  port: number;
  connect: jest.Mock;
  initElectrum: jest.Mock;
  server_version: jest.Mock;
  server_features: jest.Mock;
  blockchainBlock_header: jest.Mock;
  blockchainHeaders_subscribe: jest.Mock;
  blockchainScripthash_getHistory: jest.Mock;
  blockchainTransaction_get: jest.Mock;
  server_ping: jest.Mock;
  close: jest.Mock;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolveOuter!: (v: T) => void;
  let rejectOuter!: (e: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveOuter = resolve;
    rejectOuter = reject;
  });
  return { promise, resolve: resolveOuter, reject: rejectOuter };
}

function makeFakeClient(host = 'fake.host', port = 50002): FakeClient {
  const fc: Partial<FakeClient> = {
    initElectrumDeferred: deferred<[string, string]>(),
    headersDeferred: deferred<{ height: unknown; hex?: string }>(),
    pingDeferred: null,
    pingShouldReject: false,
    closed: false,
    host,
    port,
  };
  fc.connect = jest.fn().mockResolvedValue(undefined);
  fc.initElectrum = jest.fn(() => fc.initElectrumDeferred!.promise);
  fc.server_version = jest.fn().mockResolvedValue(['Fulcrum 1.10.0', '1.4']);
  fc.server_features = jest.fn().mockResolvedValue({
    genesis_hash: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
    hash_function: 'sha256',
  });
  fc.blockchainBlock_header = jest.fn();
  fc.blockchainHeaders_subscribe = jest.fn(() => fc.headersDeferred!.promise);
  fc.blockchainScripthash_getHistory = jest.fn();
  fc.blockchainTransaction_get = jest.fn();
  fc.server_ping = jest.fn(() => {
    fc.pingDeferred = deferred<unknown>();
    if (fc.pingShouldReject) {
      fc.pingDeferred.reject(new Error('ping failed'));
    } else {
      fc.pingDeferred.resolve(undefined);
    }
    return fc.pingDeferred.promise;
  });
  fc.close = jest.fn(() => {
    fc.closed = true;
  });
  return fc as FakeClient;
}

const created: FakeClient[] = [];
const constructorArgs: unknown[][] = [];
let configureNextClient: ((client: FakeClient) => void) | undefined;
(globalThis as unknown as TestGlobals).__createNextFakeClient = (...args: unknown[]) => {
  const client = makeFakeClient();
  configureNextClient?.(client);
  configureNextClient = undefined;
  created.push(client);
  constructorArgs.push(args);
  return client;
};

const presentAlertMock = jest.fn();
(globalThis as unknown as TestGlobals).__presentAlertSpy = presentAlertMock;

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function flush(times = 4) {
  for (let i = 0; i < times; i++) await tick();
}

function resolveLastConnect() {
  const c = created[created.length - 1];
  c.initElectrumDeferred.resolve(['Fulcrum 1.10.0', '1.4']);
  c.headersDeferred.resolve({ height: 1000 });
}

describe('BlueElectrum lifecycle', () => {
  beforeEach(async () => {
    BlueElectrum.forceDisconnect();
    await BlueElectrum.setDisabled(false);
    created.length = 0;
    constructorArgs.length = 0;
    configureNextClient = undefined;
    presentAlertMock.mockClear();
  });

  describe('coalescing', () => {
    it('two concurrent ensureConnected() share one in-flight attempt', async () => {
      const p1 = BlueElectrum.ensureConnected();
      const p2 = BlueElectrum.ensureConnected();

      await flush();
      expect(created.length).toBe(1);

      resolveLastConnect();
      const [r1, r2] = await Promise.all([p1, p2]);

      expect(r1).toBe(true);
      expect(r2).toBe(true);
      expect(BlueElectrum.getConnectionState()).toBe('connected');
      expect(created.length).toBe(1);
    });
  });

  describe('forceDisconnect during in-flight connect', () => {
    it('aborts cleanly; state ends "disconnected" even if the socket resolves later', async () => {
      const p = BlueElectrum.ensureConnected();
      await flush();
      expect(created.length).toBe(1);
      expect(BlueElectrum.getConnectionState()).toBe('connecting');

      BlueElectrum.forceDisconnect();
      // Late resolve from the doomed attempt must not flip state back to 'connected'.
      resolveLastConnect();

      const result = await p;
      expect(result).toBe(false);
      expect(BlueElectrum.getConnectionState()).toBe('disconnected');
    });
  });

  describe('setDisabled(true) during in-flight connect', () => {
    it('bumps generation, tears down the socket, leaves state "disabled"', async () => {
      const p = BlueElectrum.ensureConnected();
      await flush();
      expect(created.length).toBe(1);
      expect(BlueElectrum.getConnectionState()).toBe('connecting');

      await BlueElectrum.setDisabled(true);
      // Late resolve from the doomed attempt must not flip state back to 'connected'.
      resolveLastConnect();

      const result = await p;
      expect(result).toBe(false);
      expect(BlueElectrum.getConnectionState()).toBe('disabled');
      expect(created[0].close).toHaveBeenCalled();
    });
  });

  describe('ping fast-path', () => {
    it('successful ping on existing client returns true without a new connect', async () => {
      // First, establish a connection.
      const connectPromise = BlueElectrum.ensureConnected();
      await flush();
      resolveLastConnect();
      await connectPromise;
      expect(BlueElectrum.getConnectionState()).toBe('connected');

      // Now ensureConnected() should ping the existing client, not construct another.
      const second = await BlueElectrum.ensureConnected();
      expect(second).toBe(true);
      expect(created.length).toBe(1);
      expect(created[0].server_ping).toHaveBeenCalled();
    });

    it('ping() on a connected client flipping to reject moves state to "disconnected"', async () => {
      const connectPromise = BlueElectrum.ensureConnected();
      await flush();
      resolveLastConnect();
      await connectPromise;
      expect(BlueElectrum.getConnectionState()).toBe('connected');

      created[0].pingShouldReject = true;
      const ok = await BlueElectrum.ping();

      expect(ok).toBe(false);
      expect(BlueElectrum.getConnectionState()).toBe('disconnected');
    });
  });

  describe('subscribeConnectionState', () => {
    it('notifies on transitions and stops after unsubscribe', async () => {
      const seen: string[] = [];
      const unsub = BlueElectrum.subscribeConnectionState(s => seen.push(s));

      const p = BlueElectrum.ensureConnected();
      await flush();
      expect(seen).toContain('connecting');

      resolveLastConnect();
      await p;
      expect(seen).toContain('connected');

      unsub();
      BlueElectrum.forceDisconnect();
      // After unsubscribe, the 'disconnected' transition should not be recorded.
      expect(seen[seen.length - 1]).toBe('connected');
    });
  });

  describe('isConnected / getConnectionState agree with the machine', () => {
    it('both reflect the current state', async () => {
      expect(BlueElectrum.isConnected()).toBe(false);
      expect(BlueElectrum.getConnectionState()).toBe('disconnected');

      const p = BlueElectrum.ensureConnected();
      await flush();
      resolveLastConnect();
      await p;

      expect(BlueElectrum.isConnected()).toBe(true);
      expect(BlueElectrum.getConnectionState()).toBe('connected');
    });
  });

  describe('chain-verified handshake', () => {
    const MAINNET_GENESIS_HEADER =
      '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c';

    it('keeps a provisional client unavailable until features and tip are verified', async () => {
      const connection = BlueElectrum.ensureConnected();
      await flush();

      expect(await BlueElectrum.ping()).toBe(false);
      expect(created[0].server_ping).not.toHaveBeenCalled();
      expect(BlueElectrum.getConnectionState()).toBe('connecting');

      resolveLastConnect();
      await connection;

      expect(created[0].server_features).toHaveBeenCalledTimes(1);
      expect(BlueElectrum.getConnectionState()).toBe('connected');
      expect(constructorArgs[0][5]).toBeUndefined();
    });

    it('rejects an incompatible negotiated protocol before chain queries', async () => {
      configureNextClient = client => client.server_version.mockResolvedValue(['Fulcrum 1.10.0', '1.3']);

      await expect(BlueElectrum.testConnection('old-protocol.example', undefined, 50002)).resolves.toBe(false);
      expect(created[0].server_features).not.toHaveBeenCalled();
      expect(created[0].close).toHaveBeenCalled();
    });

    it.each([
      [
        'wrong genesis',
        {
          genesis_hash: '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943',
          hash_function: 'sha256',
        },
      ],
      [
        'wrong hash function',
        {
          genesis_hash: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
          hash_function: 'sha256d',
        },
      ],
      [
        'Testnet4 genesis',
        {
          genesis_hash: '00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043',
          hash_function: 'sha256',
        },
      ],
    ])('rejects a custom peer with %s', async (_label, features) => {
      configureNextClient = client => client.server_features.mockResolvedValue(features);
      const connected = await BlueElectrum.testConnection('custom.example', undefined, 50002);

      expect(connected).toBe(false);
      expect(created[0].blockchainHeaders_subscribe).not.toHaveBeenCalled();
      expect(created[0].close).toHaveBeenCalled();
    });

    it('accepts the explicit genesis-header fallback only for an unsupported features RPC', async () => {
      configureNextClient = client => {
        client.server_features.mockRejectedValue({ code: -32601, message: 'Method not found' });
        client.blockchainBlock_header.mockResolvedValue(MAINNET_GENESIS_HEADER);
      };
      const connection = BlueElectrum.testConnection('legacy.example', undefined, 50002);
      await flush();
      created[0].headersDeferred.resolve({ height: 1000 });

      expect(await connection).toBe(true);
      expect(created[0].blockchainBlock_header).toHaveBeenCalledWith(0);
      expect(created[0].server_ping).toHaveBeenCalledTimes(1);
      expect(created[0].close).toHaveBeenCalled();
    });

    it.each([true, '1000', 0, -1, 1.5])('rejects malformed tip height %p', async height => {
      const connection = BlueElectrum.testConnection('tipless.example', undefined, 50002);
      await flush();
      created[0].headersDeferred.resolve({ height });

      await expect(connection).resolves.toBe(false);
      expect(created[0].server_ping).not.toHaveBeenCalled();
      expect(created[0].close).toHaveBeenCalled();
    });

    it('rejects an unsupported-features fallback whose exact genesis header hashes to another chain', async () => {
      configureNextClient = client => {
        client.server_features.mockRejectedValue({ code: -32601, message: 'Method not found' });
        client.blockchainBlock_header.mockResolvedValue(
          '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4adae5494dffff001d1aa4ae18',
        );
      };

      await expect(BlueElectrum.testConnection('wrong-chain.example', undefined, 50002)).resolves.toBe(false);
      expect(created[0].blockchainHeaders_subscribe).not.toHaveBeenCalled();
      expect(created[0].close).toHaveBeenCalled();
    });

    it('times out a live handshake and ignores its completion after a replacement is ready', async () => {
      jest.useFakeTimers();
      const staleFeatures = deferred<{ genesis_hash: string; hash_function: string }>();
      try {
        configureNextClient = client => client.server_features.mockReturnValue(staleFeatures.promise);
        const staleConnection = BlueElectrum.ensureConnected();
        await jest.advanceTimersByTimeAsync(0);
        expect(created).toHaveLength(1);
        created[0].initElectrumDeferred.resolve(['Fulcrum 1.10.0', '1.4']);
        await jest.advanceTimersByTimeAsync(0);
        expect(created[0].server_features).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(10_000);
        expect(created[0].close).toHaveBeenCalled();

        BlueElectrum.forceDisconnect();
        await jest.advanceTimersByTimeAsync(500);
        await expect(staleConnection).resolves.toBe(false);
        jest.useRealTimers();

        const replacement = BlueElectrum.ensureConnected();
        await flush();
        resolveLastConnect();
        await expect(replacement).resolves.toBe(true);

        staleFeatures.resolve({
          genesis_hash: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
          hash_function: 'sha256',
        });
        await flush();

        expect(BlueElectrum.getConnectionState()).toBe('connected');
        await expect(BlueElectrum.getCurrentBlockTip()).resolves.toBe(1000);
        expect(created[0].blockchainHeaders_subscribe).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('bounds the full custom version/features/tip/ping handshake and closes its exact client', async () => {
      jest.useFakeTimers();
      try {
        configureNextClient = client => {
          client.server_features.mockReturnValue(deferred<unknown>().promise);
        };
        const connection = BlueElectrum.testConnection('stalled.example', undefined, 50002);

        await jest.advanceTimersByTimeAsync(5_000);

        expect(await connection).toBe(false);
        expect(created[0].close).toHaveBeenCalled();
        expect(BlueElectrum.getConnectionState()).toBe('disconnected');
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('getConfirmedBlockHeight', () => {
    const TEST_ADDRESS = 'bc1qe7q08prc2spln2l7qdvvlcgqxm9za9z7mjnpzc';
    const TX_HASH = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

    async function connectAtTip(height: number) {
      const connectPromise = BlueElectrum.ensureConnected();
      await flush();
      const client = created[created.length - 1];
      client.initElectrumDeferred.resolve(['Fulcrum 1.10.0', '1.4']);
      client.headersDeferred.resolve({ height });
      await connectPromise;
      return client;
    }

    async function seedTxHeightCache(client: FakeClient, txHash: string, height: number) {
      client.blockchainScripthash_getHistory.mockResolvedValue([{ tx_hash: txHash, height }]);
      await BlueElectrum.getTransactionsByAddress(TEST_ADDRESS);
    }

    it('returns null for implausible height without caching', async () => {
      const client = await connectAtTip(1000);

      client.blockchainTransaction_get.mockResolvedValue({ confirmations: 2000 });

      const result = await BlueElectrum.getConfirmedBlockHeight('deadbeef');
      expect(result).toBeNull();
    });

    it('returns cached height when cache is within tip', async () => {
      const client = await connectAtTip(1000);
      await seedTxHeightCache(client, TX_HASH, 995);

      const result = await BlueElectrum.getConfirmedBlockHeight(TX_HASH);
      expect(result).toEqual({ height: 995, tip: 1000 });
      expect(client.blockchainTransaction_get).not.toHaveBeenCalled();
    });

    it('refreshes tip when cached height is slightly ahead of TTL tip', async () => {
      const client = await connectAtTip(1000);
      await seedTxHeightCache(client, TX_HASH, 1001);

      client.blockchainHeaders_subscribe.mockResolvedValue({ height: 1001 });

      const result = await BlueElectrum.getConfirmedBlockHeight(TX_HASH);
      expect(result).toEqual({ height: 1001, tip: 1001 });
      expect(client.blockchainTransaction_get).not.toHaveBeenCalled();
    });

    it('discards poisoned cache and fetches height from server', async () => {
      const client = await connectAtTip(1000);
      await seedTxHeightCache(client, TX_HASH, 2000);

      client.blockchainHeaders_subscribe.mockResolvedValue({ height: 1000 });
      client.blockchainTransaction_get.mockResolvedValue({ confirmations: 5 });

      const result = await BlueElectrum.getConfirmedBlockHeight(TX_HASH);
      expect(result).toEqual({ height: 996, tip: 1000 });
      expect(client.blockchainTransaction_get).toHaveBeenCalledWith(TX_HASH, true);
    });
  });
});
