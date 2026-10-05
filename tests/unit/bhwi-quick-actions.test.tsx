import { act, renderHook, waitFor } from '@testing-library/react-native';
import { DeviceEventEmitter, Linking } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import useDeviceQuickActions from '../../hooks/useDeviceQuickActions';
import { HDSegwitBech32Wallet } from '../../class/wallets/hd-segwit-bech32-wallet';
import * as NavigationService from '../../NavigationService';

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
jest.mock('react-native-quick-actions', () => ({
  clearShortcutItems: jest.fn(),
  setShortcutItems: jest.fn(),
  isSupported: jest.fn(callback => callback(null, true)),
  popInitialAction: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../NavigationService', () => ({
  dispatch: jest.fn(),
  navigate: jest.fn(),
}));
jest.mock('../../blue_modules/BlueElectrum', () => ({
  ensureConnected: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../hooks/context/useStorage', () => ({
  useStorage: () => mockStorage,
}));
jest.mock('../../hooks/context/useSettings', () => ({
  useSettings: () => ({
    preferredFiatCurrency: {},
    isQuickActionsEnabled: true,
  }),
}));

const mockWallet = new HDSegwitBech32Wallet();
const mockStorage = {
  wallets: [mockWallet],
  walletsInitialized: true,
  isStorageEncrypted: jest.fn().mockResolvedValue(false),
  addWallet: jest.fn(),
  saveToDisk: jest.fn(),
  setSharedCosigner: jest.fn(),
};
const shortcuts = jest.requireMock('react-native-quick-actions');

beforeEach(() => {
  jest.clearAllMocks();
  mockStorage.isStorageEncrypted.mockResolvedValue(false);
  shortcuts.popInitialAction.mockResolvedValue(null);
  shortcuts.isSupported.mockImplementation((callback: (error: null, supported: boolean) => void) => callback(null, true));
  jest.mocked(AsyncStorage.getItem).mockResolvedValue(null);
  jest.mocked(AsyncStorage.setItem).mockResolvedValue(undefined);
  jest.mocked(Linking.getInitialURL).mockResolvedValue(null);
  jest.requireMock('../../blue_modules/BlueElectrum').ensureConnected.mockResolvedValue(true);
});

describe.each([
  ['bitcoin', 'bluewallet-bhwi', 'bluewallet-bhwi-testnet'],
  ['testnet', 'bluewallet-bhwi-testnet', 'bluewallet-bhwi'],
])('Android %s wallet shortcuts', (_bitcoinNetwork, scheme, foreignScheme) => {
  beforeAll(() => {
    mockAppScheme = scheme;
  });

  it('emits owned shortcuts and rejects foreign initial and live actions', async () => {
    const { result } = renderHook(() => useDeviceQuickActions());
    const ownedUrl = `${scheme}://wallet/${mockWallet.getID()}`;
    await waitFor(() => expect(shortcuts.setShortcutItems).toHaveBeenCalled());
    expect(shortcuts.setShortcutItems.mock.calls[0][0][0].userInfo.url).toBe(ownedUrl);

    for (const foreign of ['bluewallet', foreignScheme]) {
      const action = {
        userInfo: { url: `${foreign}://wallet/${mockWallet.getID()}` },
      };
      await act(async () => result.current.popInitialAction(action));
      act(() => DeviceEventEmitter.emit('quickActionShortcut', action));
    }
    expect(NavigationService.dispatch).not.toHaveBeenCalled();

    const ownedAction = { userInfo: { url: ownedUrl } };
    await act(async () => result.current.popInitialAction(ownedAction));
    act(() => DeviceEventEmitter.emit('quickActionShortcut', ownedAction));
    expect(NavigationService.dispatch).toHaveBeenCalledTimes(2);
    expect(NavigationService.dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          name: 'WalletTransactions',
          params: { walletID: mockWallet.getID(), walletType: mockWallet.type },
        }),
      }),
    );
  });
});
