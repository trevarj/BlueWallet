import assert from 'assert';
import DeeplinkSchemaMatch from '../../class/deeplink-schema-match';
import { readFileOutsideSandbox } from '../../blue_modules/fs';
import { HDSegwitBech32Wallet } from '../../class/wallets/hd-segwit-bech32-wallet';

jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  Object.defineProperty(actual, 'Platform', {
    value: actual.Platform,
    configurable: true,
  });
  Object.defineProperty(actual.Platform, 'OS', {
    value: 'android',
    configurable: true,
  });
  return actual;
});

jest.mock('../../codegen/NativeSettingsModule', () => ({
  __esModule: true,
  default: { getConstants: () => ({ bitcoinNetwork: 'bitcoin' }) },
}));
jest.mock('../../models/appScheme', () => ({
  get appScheme() {
    return mockAppScheme;
  },
}));

let mockAppScheme: string;
jest.mock('../../blue_modules/fs', () => ({
  readFileOutsideSandbox: jest.fn().mockResolvedValue('original PSBT'),
}));
jest.mock('../../blue_modules/BlueElectrum', () => ({
  ensureConnected: jest.fn().mockResolvedValue(true),
}));

const address = '12eQ9m4sgAwTSQoNXkRABKhCXCsjm2jdVG';

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(readFileOutsideSandbox).mockResolvedValue('original PSBT');
  jest.requireMock('../../blue_modules/BlueElectrum').ensureConnected.mockResolvedValue(true);
});

describe.each([
  ['bitcoin', 'bluewallet-bhwi', 'bluewallet-bhwi-testnet'],
  ['testnet', 'bluewallet-bhwi-testnet', 'bluewallet-bhwi'],
])('Android %s app-owned links', (_bitcoinNetwork, scheme, foreignScheme) => {
  beforeAll(() => {
    mockAppScheme = scheme;
  });

  it('unwraps the complete payment prefix, including uppercase schemes', () => {
    for (const prefix of [scheme, scheme.toUpperCase()]) {
      const complete = jest.fn();
      DeeplinkSchemaMatch.navigationRouteFor({ url: `${prefix}:bitcoin:${address}?amount=0.01` }, complete);
      expect(complete.mock.calls).toEqual([
        [
          [
            'SendDetailsRoot',
            {
              screen: 'SendDetails',
              params: { uri: `bitcoin:${address}?amount=0.01` },
            },
          ],
        ],
      ]);
    }
  });

  it('rejects foreign wrappers, settings, widgets and files', () => {
    for (const foreign of ['bluewallet', foreignScheme]) {
      for (const suffix of [`bitcoin:${address}`, 'setelectrumserver?server=foreign', '//widget?action=openSend', '//import/tx.psbt']) {
        const url = `${foreign}:${suffix}`;
        const complete = jest.fn();
        assert.strictEqual(DeeplinkSchemaMatch.hasSchema(url), false);
        DeeplinkSchemaMatch.navigationRouteFor({ url }, complete);
        assert.strictEqual(complete.mock.calls.length, 0);
      }
      expect(readFileOutsideSandbox).not.toHaveBeenCalled();
      assert.strictEqual(DeeplinkSchemaMatch.getServerFromSetElectrumServerAction(`${foreign}:setelectrumserver?server=foreign`), false);
      assert.strictEqual(DeeplinkSchemaMatch.getUrlFromSetLndhubUrlAction(`${foreign}:setlndhuburl?url=foreign`), false);
    }
  });

  it('routes its settings and the exact widget wallet', () => {
    const complete = jest.fn();
    DeeplinkSchemaMatch.navigationRouteFor(
      {
        url: `${scheme}:setelectrumserver?server=electrum1.bluewallet.io%3A443%3As`,
      },
      complete,
    );
    expect(complete.mock.calls[0][0]).toEqual(['ElectrumSettings', { server: 'electrum1.bluewallet.io:443:s' }]);
    assert.strictEqual(
      DeeplinkSchemaMatch.getUrlFromSetLndhubUrlAction(`${scheme}:setlndhuburl?url=https%3A%2F%2Flndhub.example`),
      'https://lndhub.example',
    );

    const wallet = new HDSegwitBech32Wallet();
    DeeplinkSchemaMatch.navigationRouteFor({ url: `${scheme}://widget?action=openReceive` }, complete, {
      wallets: [wallet],
      saveToDisk: jest.fn(),
      addWallet: jest.fn(),
      setSharedCosigner: jest.fn(),
    });
    expect(complete.mock.calls[1][0]).toEqual([
      'DetailViewStackScreensStack',
      { screen: 'ReceiveDetails', params: { walletID: wallet.getID() } },
    ]);
  });

  it('retains ordinary Bitcoin payments and PSBT file imports', async () => {
    const complete = jest.fn();
    DeeplinkSchemaMatch.navigationRouteFor({ url: `bitcoin:${address}` }, complete);
    expect(complete.mock.calls[0][0]).toEqual(['SendDetailsRoot', { screen: 'SendDetails', params: { uri: `bitcoin:${address}` } }]);
    DeeplinkSchemaMatch.navigationRouteFor({ url: 'content://documents/tx.psbt' }, complete);
    await Promise.resolve();
    expect(readFileOutsideSandbox).toHaveBeenCalledWith('content://documents/tx.psbt');
    expect(complete.mock.calls[1][0]).toEqual([
      'SendDetailsRoot',
      {
        screen: 'PsbtWithHardwareWallet',
        params: { deepLinkPSBT: 'original PSBT' },
      },
    ]);
  });
});
