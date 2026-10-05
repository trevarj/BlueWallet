import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';
import type { AppStateStatus } from 'react-native';

import type { TWallet } from '../../class/wallets/types';
import { WatchOnlyWallet } from '../../class/wallets/watch-only-wallet';
import HardwareWalletAccount from '../../screen/wallets/HardwareWalletAccount';

const mockNavigate = jest.fn();
const mockDispatch = jest.fn();
const mockParentGoBack = jest.fn();
const mockAddAndSaveWallet = jest.fn<Promise<boolean>, [TWallet]>();
const mockEnableScreenProtect = jest.fn();
const mockDisableScreenProtect = jest.fn();
const mockDisconnect = jest.fn(async () => undefined);
const mockDiscover = jest.fn();
const mockConnect = jest.fn();
const mockGetAccount = jest.fn();
const mockStartSession = jest.fn();
const mockVerifyAccount = jest.fn();
let mockRouteParams: Record<string, unknown> = { mode: 'wallet' };
let mockAppStateChange: (state: AppStateStatus) => void = () => undefined;

type PromiseResolvers<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

const withResolvers = <T,>(): PromiseResolvers<T> =>
  (
    Promise as typeof Promise & {
      withResolvers<TValue>(): PromiseResolvers<TValue>;
    }
  ).withResolvers<T>();

const publicAccount = {
  family: 'ledger' as const,
  fingerprint: 'd34db33f',
  path: "m/84'/0'/0'",
  xpub: 'public-account-xpub',
  format: 'native-segwit' as const,
};
const nativeAccount = { ...publicAccount, descriptor: 'wpkh(public-account)' };
const draft = { getID: () => 'hardware-wallet' } as unknown as WatchOnlyWallet;
const mockNavigation = {
  navigate: mockNavigate,
  dispatch: mockDispatch,
  getParent: () => ({ goBack: mockParentGoBack }),
};

jest.mock('@react-navigation/native', () => {
  const actual = jest.requireActual('@react-navigation/native');
  return {
    ...actual,
    useNavigation: () => mockNavigation,
    useRoute: () => ({ params: mockRouteParams }),
    useLocale: () => ({ direction: 'ltr' }),
  };
});

jest.mock('../../hooks/context/useStorage', () => ({ useStorage: () => ({ addAndSaveWallet: mockAddAndSaveWallet }) }));
jest.mock('../../hooks/useScreenProtect', () => ({
  useScreenProtect: () => ({ enableScreenProtect: mockEnableScreenProtect, disableScreenProtect: mockDisableScreenProtect }),
}));
jest.mock('../../components/themes', () => ({ useTheme: () => ({ colors: new Proxy({}, { get: () => '#000000' }) }) }));

jest.mock('../../blue_modules/bhwi', () => {
  class MockBhwiError extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  }
  return {
    BHWI_SINGLESIG_FORMATS: ['legacy', 'nested-segwit', 'native-segwit', 'taproot'],
    BhwiError: MockBhwiError,
    getBhwiAccountPath: (format: string, index: string) =>
      format.startsWith('multisig-')
        ? `m/48'/0'/${index}'/${format === 'multisig-native' ? 2 : 1}'`
        : `m/${format === 'native-segwit' ? 84 : 44}'/0'/${index}'`,
    isBhwiAvailable: () => true,
    isBhwiSinglesigFormat: (format: string) => !format.startsWith('multisig-'),
    isCanonicalBhwiFingerprint: (value: string) => value === 'd34db33f',
    startBhwiSession: (...args: unknown[]) => mockStartSession(...args),
    supportsBhwiAccountFormat: () => true,
    verifyBhwiAccount: (...args: unknown[]) => mockVerifyAccount(...args),
  };
});

jest.mock('../../components/Button', () => {
  const ReactModule = require('react');
  const { Pressable, Text } = require('react-native');
  const MockButton = ({
    disabled,
    onPress,
    testID,
    title,
  }: {
    disabled?: boolean;
    onPress?: () => void;
    testID?: string;
    title?: string;
  }) =>
    ReactModule.createElement(
      Pressable,
      { disabled, onPress, testID, accessibilityState: { disabled } },
      ReactModule.createElement(Text, null, title),
    );
  return { __esModule: true, default: MockButton };
});
jest.mock('../../components/BlueButtonLink', () => {
  const ReactModule = require('react');
  const { Pressable, Text } = require('react-native');
  return {
    __esModule: true,
    default: ({ disabled, onPress, testID, title }: { disabled?: boolean; onPress?: () => void; testID?: string; title: string }) =>
      ReactModule.createElement(Pressable, { disabled, onPress, testID }, ReactModule.createElement(Text, null, title)),
  };
});
jest.mock('../../components/ListItem', () => {
  const ReactModule = require('react');
  const { Pressable, Text } = require('react-native');
  return {
    __esModule: true,
    default: ({ disabled, onPress, testID, title }: { disabled?: boolean; onPress?: () => void; testID?: string; title: string }) =>
      ReactModule.createElement(Pressable, { disabled, onPress, testID }, ReactModule.createElement(Text, null, title)),
  };
});
jest.mock('../../components/SafeAreaScrollView', () => {
  const ReactModule = require('react');
  const { ScrollView } = require('react-native');
  return {
    __esModule: true,
    default: ({ children }: React.PropsWithChildren) => ReactModule.createElement(ScrollView, null, children),
  };
});
jest.mock('../../components/SegmentedControl', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  return { __esModule: true, default: ({ testID }: { testID?: string }) => ReactModule.createElement(View, { testID }) };
});
jest.mock('../../components/BlueFormLabel', () => {
  const ReactModule = require('react');
  const { Text } = require('react-native');
  return { __esModule: true, default: ({ children }: React.PropsWithChildren) => ReactModule.createElement(Text, null, children) };
});
jest.mock('../../components/BlueText', () => {
  const ReactModule = require('react');
  const { Text } = require('react-native');
  return {
    __esModule: true,
    default: ({ children, testID }: React.PropsWithChildren<{ testID?: string }>) => ReactModule.createElement(Text, { testID }, children),
  };
});
jest.mock('../../components/BlueSpacing', () => {
  const { View } = require('react-native');
  return { BlueSpacing10: View, BlueSpacing20: View };
});

const session = { discover: mockDiscover, connect: mockConnect, getAccount: mockGetAccount, disconnect: mockDisconnect };

beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active', writable: true });
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
    mockAppStateChange = listener as (state: AppStateStatus) => void;
    return { remove: jest.fn() };
  });
  mockRouteParams = { mode: 'wallet' };
  mockStartSession.mockResolvedValue(session);
  mockDiscover.mockResolvedValue([{ id: 'usb:ledger', name: 'Ledger', family: 'ledger', transport: 'usb' }]);
  mockConnect.mockResolvedValue({ family: 'ledger', fingerprint: 'd34db33f', version: '1', model: null });
  mockGetAccount.mockResolvedValue(nativeAccount);
  mockVerifyAccount.mockImplementation((_info, requestedPath, requestedFormat) => ({
    ...publicAccount,
    path: requestedPath,
    format: requestedFormat,
  }));
  jest.spyOn(WatchOnlyWallet, 'fromBhwiAccount').mockReturnValue(draft);
});

afterEach(() => jest.restoreAllMocks());

async function reachPublicAccount() {
  const view = render(<HardwareWalletAccount />);
  fireEvent.press(view.getByTestId('HardwareDiscover'));
  fireEvent.press(await view.findByTestId('HardwareDevice-usb:ledger'));
  fireEvent.press(await view.findByTestId('HardwareGetAccount'));
  await view.findByTestId('HardwarePublicAccount');
  return view;
}

it('keeps one exact draft after a failed durable save and navigates once only after retry', async () => {
  mockAddAndSaveWallet.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const view = await reachPublicAccount();

  fireEvent.press(view.getByTestId('HardwareFinish'));
  await waitFor(() => expect(mockAddAndSaveWallet).toHaveBeenCalledTimes(1));
  expect(mockParentGoBack).not.toHaveBeenCalled();
  expect(view.getByTestId('HardwareAccountIndex').props.editable).toBe(false);
  expect(view.getByTestId('HardwareFinish')).toBeTruthy();

  fireEvent.press(view.getByTestId('HardwareFinish'));
  await waitFor(() => expect(mockParentGoBack).toHaveBeenCalledTimes(1));
  expect(mockAddAndSaveWallet).toHaveBeenNthCalledWith(1, draft);
  expect(mockAddAndSaveWallet).toHaveBeenNthCalledWith(2, draft);
  expect(mockStartSession).toHaveBeenCalledTimes(1);
  expect(mockConnect).toHaveBeenCalledTimes(1);
  expect(mockGetAccount).toHaveBeenCalledTimes(1);

  view.unmount();
  await waitFor(() => expect(mockDisconnect).toHaveBeenCalledTimes(1));
});

it('disconnects on unmount and ignores a discovery result that resolves afterward', async () => {
  const { promise, resolve } = withResolvers<unknown[]>();
  mockDiscover.mockReturnValue(promise);
  const view = render(<HardwareWalletAccount />);
  fireEvent.press(view.getByTestId('HardwareDiscover'));
  await waitFor(() => expect(mockDiscover).toHaveBeenCalledTimes(1));
  view.unmount();
  resolve([{ id: 'late', name: 'Late device', family: 'ledger', transport: 'usb' }]);
  await act(async () => Promise.resolve());
  expect(mockDisconnect).toHaveBeenCalledTimes(1);
  expect(mockConnect).not.toHaveBeenCalled();
});

it('invalidates an attempt backgrounded while session ownership is still starting', async () => {
  const pendingSession = withResolvers<typeof session>();
  mockStartSession.mockReturnValueOnce(pendingSession.promise);
  const view = render(<HardwareWalletAccount />);
  fireEvent.press(view.getByTestId('HardwareDiscover'));
  await waitFor(() => expect(mockStartSession).toHaveBeenCalledTimes(1));

  act(() => mockAppStateChange('background'));
  await act(async () => {
    pendingSession.resolve(session);
    await pendingSession.promise;
  });
  await waitFor(() => expect(mockDisconnect).toHaveBeenCalledTimes(1));
  expect(mockDiscover).not.toHaveBeenCalled();

  act(() => mockAppStateChange('active'));
  expect(mockStartSession).toHaveBeenCalledTimes(1);
  fireEvent.press(view.getByTestId('HardwareDiscover'));
  await view.findByTestId('HardwareDevice-usb:ledger');
  expect(mockStartSession).toHaveBeenCalledTimes(2);
});

it('drops discovery results delivered after backgrounding and requires an explicit restart', async () => {
  const pendingDiscovery = withResolvers<unknown[]>();
  mockDiscover.mockReturnValueOnce(pendingDiscovery.promise);
  const view = render(<HardwareWalletAccount />);
  fireEvent.press(view.getByTestId('HardwareDiscover'));
  await waitFor(() => expect(mockDiscover).toHaveBeenCalledTimes(1));

  act(() => mockAppStateChange('background'));
  await act(async () => {
    pendingDiscovery.resolve([{ id: 'late', name: 'Late device', family: 'ledger', transport: 'usb' }]);
    await pendingDiscovery.promise;
  });
  expect(view.queryByTestId('HardwareDevice-late')).toBeNull();

  act(() => mockAppStateChange('active'));
  expect(mockStartSession).toHaveBeenCalledTimes(1);
  fireEvent.press(view.getByTestId('HardwareDiscover'));
  await view.findByTestId('HardwareDevice-usb:ledger');
  expect(mockStartSession).toHaveBeenCalledTimes(2);
});

it('does not publish or navigate for a save that completes after backgrounding', async () => {
  const pendingSave = withResolvers<boolean>();
  mockAddAndSaveWallet.mockReturnValueOnce(pendingSave.promise).mockResolvedValueOnce(true);
  const view = await reachPublicAccount();
  fireEvent.press(view.getByTestId('HardwareFinish'));
  await waitFor(() => expect(mockAddAndSaveWallet).toHaveBeenCalledTimes(1));

  act(() => mockAppStateChange('background'));
  await act(async () => {
    pendingSave.resolve(true);
    await pendingSave.promise;
  });
  act(() => mockAppStateChange('active'));
  expect(mockParentGoBack).not.toHaveBeenCalled();

  fireEvent.press(view.getByTestId('HardwareFinish'));
  await waitFor(() => expect(mockParentGoBack).toHaveBeenCalledTimes(1));
  expect(mockAddAndSaveWallet).toHaveBeenNthCalledWith(1, draft);
  expect(mockAddAndSaveWallet).toHaveBeenNthCalledWith(2, draft);
  expect(mockStartSession).toHaveBeenCalledTimes(1);
  expect(mockGetAccount).toHaveBeenCalledTimes(1);
});

it('returns a verified BIP48 account to the exact multisig route without creating or saving a wallet', async () => {
  mockRouteParams = { mode: 'multisig-cosigner', format: 'multisig-native', returnTo: 'WalletsAddMultisigStep2' };
  mockGetAccount.mockResolvedValue({
    ...nativeAccount,
    path: "m/48'/0'/0'/2'",
    format: 'multisig-native',
    descriptor: null,
  });
  const view = await reachPublicAccount();
  fireEvent.press(view.getByTestId('HardwareFinish'));

  expect(WatchOnlyWallet.fromBhwiAccount).not.toHaveBeenCalled();
  expect(mockAddAndSaveWallet).not.toHaveBeenCalled();
  expect(mockDispatch).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(mockDispatch.mock.calls[0][0])).toContain('WalletsAddMultisigStep2');
  expect(JSON.stringify(mockDispatch.mock.calls[0][0])).toContain("m/48'/0'/0'/2'");
});
