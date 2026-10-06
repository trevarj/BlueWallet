import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { RenderAPI } from '@testing-library/react-native';
import { AppState } from 'react-native';
import type { AppStateStatus } from 'react-native';

import type { TWallet } from '../../class/wallets/types';
import { WatchOnlyWallet } from '../../class/wallets/watch-only-wallet';
import { HDLegacyP2PKHWallet } from '../../class/wallets/hd-legacy-p2pkh-wallet';
import { MultisigHDWallet } from '../../class/wallets/multisig-hd-wallet';
import HardwareWalletAccount from '../../screen/wallets/HardwareWalletAccount';
import * as Bhwi from '../../blue_modules/bhwi';

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
const mockSignPsbt = jest.fn();
const mockSignMessage = jest.fn();
const mockGetBhwiLedgerHmac = jest.fn();
const mockValidateOriginal = jest.fn();
const mockValidateResult = jest.fn();
const mockSaveToDisk = jest.fn(async () => true);
let mockWallets: TWallet[] = [];
let mockRouteParams: Record<string, unknown> = { mode: 'wallet' };
let mockAppStateChange: (state: AppStateStatus) => void = () => undefined;
let mockIsFocused = true;

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
    useIsFocused: () => mockIsFocused,
    useNavigation: () => mockNavigation,
    useRoute: () => ({ params: mockRouteParams }),
    useLocale: () => ({ direction: 'ltr' }),
  };
});

jest.mock('../../hooks/context/useStorage', () => ({
  useStorage: () => ({ addAndSaveWallet: mockAddAndSaveWallet, saveToDisk: mockSaveToDisk, wallets: mockWallets }),
}));
jest.mock('../../hooks/useScreenProtect', () => ({
  useScreenProtect: () => ({ enableScreenProtect: mockEnableScreenProtect, disableScreenProtect: mockDisableScreenProtect }),
}));
jest.mock('../../components/themes', () => ({ useTheme: () => ({ colors: new Proxy({}, { get: () => '#000000' }) }) }));

jest.mock('../../blue_modules/bhwi', () => {
  const actual = jest.requireActual('../../blue_modules/bhwi') as Pick<typeof Bhwi, 'isBhwiAddressSnapshot'>;
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
    getBhwiPolicyName: (value: string) => `policy-${value.length}`,
    getBhwiLedgerHmac: (...args: unknown[]) => mockGetBhwiLedgerHmac(...args),
    isBhwiAvailable: () => true,
    isBhwiSinglesigFormat: (format: string) => !format.startsWith('multisig-'),
    isCanonicalBhwiFingerprint: (value: string) => value === 'd34db33f',
    isBhwiReconnectMatch: () => true,
    isBhwiAddressSnapshot: actual.isBhwiAddressSnapshot,
    startBhwiSession: (...args: unknown[]) => mockStartSession(...args),
    supportsBhwiAccountFormat: () => true,
    matchesBhwiAddressSnapshot: (
      wallet: { _getInternalAddressByIndex(index: number): string; _getExternalAddressByIndex(index: number): string },
      snapshot: { address: string; index: number; isInternal: boolean },
    ) =>
      (snapshot.isInternal ? wallet._getInternalAddressByIndex(snapshot.index) : wallet._getExternalAddressByIndex(snapshot.index)) ===
      snapshot.address,
    supportsBhwiMessageSigning: (info: { family: string; model: string | null }, format: string) =>
      info.family === 'ledger' && info.model === null && format === 'legacy',
    verifyBhwiAccount: (...args: unknown[]) => mockVerifyAccount(...args),
  };
});
jest.mock('../../blue_modules/validateBhwiPsbt', () => ({
  validateBhwiPsbtOriginal: (...args: unknown[]) => mockValidateOriginal(...args),
  validateBhwiPsbt: (...args: unknown[]) => mockValidateResult(...args),
}));

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

const session = {
  discover: mockDiscover,
  connect: mockConnect,
  getAccount: mockGetAccount,
  signPsbt: mockSignPsbt,
  signMessage: mockSignMessage,
  disconnect: mockDisconnect,
};

beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active', writable: true });
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
    mockAppStateChange = listener as (state: AppStateStatus) => void;
    return { remove: jest.fn() };
  });
  mockIsFocused = true;
  mockRouteParams = { mode: 'wallet' };
  mockWallets = [];
  mockStartSession.mockResolvedValue(session);
  mockDiscover.mockResolvedValue([{ id: 'usb:ledger', name: 'Ledger', family: 'ledger', transport: 'usb' }]);
  mockConnect.mockResolvedValue({ family: 'ledger', fingerprint: 'd34db33f', version: '1', model: null });
  mockGetAccount.mockResolvedValue(nativeAccount);
  mockGetBhwiLedgerHmac.mockResolvedValue('ab'.repeat(32));
  mockVerifyAccount.mockImplementation((_info, requestedPath, requestedFormat) => ({
    ...publicAccount,
    path: requestedPath,
    format: requestedFormat,
  }));
  mockSignPsbt.mockResolvedValue('signed-psbt');
  mockSignMessage.mockReset();
  mockValidateResult.mockReturnValue({ psbt: {} });
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
async function reachSigningOperation(view: RenderAPI) {
  fireEvent.press(view.getByTestId('HardwareDiscover'));
  fireEvent.press(await view.findByTestId('HardwareDevice-usb:ledger'));
  await view.findByTestId('HardwareOperationAccount');
}

it('sends only the current public multisig policy and exact association to hardware signing', async () => {
  const hardwareAccount = {
    ...publicAccount,
    path: "m/48'/0'/0'/2'",
    format: 'multisig-native' as const,
  };
  const descriptor = 'wsh(sortedmulti(2,public-phone,public-hardware))';
  const registration = {
    ...hardwareAccount,
    status: 'complete' as const,
    network: 'bitcoin' as const,
    name: 'registered-policy',
    descriptor,
    hmacService: 'bluewallet.bhwi.ledger-policy.test',
  };
  const privateSeed = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const wallet = Object.create(MultisigHDWallet.prototype) as MultisigHDWallet;
  Object.assign(wallet, {
    getID: () => 'multisig-signing-wallet',
    getM: () => 2,
    getN: () => 2,
    getPublicDescriptor: () => descriptor,
    getHardwareWalletAssociations: () => [{ ...hardwareAccount }],
    getHardwareWalletRegistration: () => registration,
    getCosigner: () => privateSeed,
  });
  mockWallets = [wallet];
  mockRouteParams = {
    mode: 'sign-psbt',
    walletID: wallet.getID(),
    hardwareAccount,
    originalBase64: 'phone-signed-psbt',
    attempt: 2,
  };
  const view = render(<HardwareWalletAccount />);
  await reachSigningOperation(view);
  fireEvent.press(view.getByTestId('HardwareSignPsbt'));
  await waitFor(() => expect(mockSignPsbt).toHaveBeenCalledTimes(1));
  expect(mockSignPsbt).toHaveBeenCalledWith('phone-signed-psbt', {
    name: 'registered-policy',
    descriptor,
    ledgerHmacHex: 'ab'.repeat(32),
  });
  expect(mockGetBhwiLedgerHmac).toHaveBeenCalledWith(registration.hmacService);
  expect(JSON.stringify(mockSignPsbt.mock.calls[0])).not.toContain(privateSeed);
  expect(JSON.stringify(mockDispatch.mock.calls[0]?.[0])).toContain('PsbtMultisig');
  expect(JSON.stringify(mockRouteParams)).not.toContain('ab'.repeat(32));
  expect(JSON.stringify(mockDispatch.mock.calls[0]?.[0])).not.toContain('ab'.repeat(32));
});

function makeSigningWallet(secret = publicAccount.xpub) {
  const wallet = Object.create(WatchOnlyWallet.prototype) as WatchOnlyWallet;
  Object.assign(wallet, {
    getID: () => 'signing-wallet',
    getSecret: () => secret,
    getMasterFingerprintHex: () => publicAccount.fingerprint,
    getDerivationPath: () => publicAccount.path,
    getHardwareWalletAssociation: () => ({ ...publicAccount }),
  });
  return wallet;
}

type MessageSigningFixture = {
  wallet: WatchOnlyWallet;
  association: Bhwi.HardwareWalletAssociation;
  message: string;
  address: string;
  signature: string;
};

function makeMessageSigningWallet() {
  const signer = new HDLegacyP2PKHWallet();
  signer.setSecret('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
  const association: Bhwi.HardwareWalletAssociation = {
    ...publicAccount,
    path: "m/44'/0'/0'",
    format: 'legacy',
  };
  const wallet = Object.create(WatchOnlyWallet.prototype) as WatchOnlyWallet;
  Object.assign(wallet, {
    getID: () => 'message-signing-wallet',
    getSecret: () => association.xpub,
    getMasterFingerprintHex: () => association.fingerprint,
    getDerivationPath: () => association.path,
    getHardwareWalletAssociation: () => ({ ...association }),
    _getExternalAddressByIndex: (index: number) => signer._getExternalAddressByIndex(index),
    _getInternalAddressByIndex: (index: number) => signer._getInternalAddressByIndex(index),
    verifyMessage: (message: string, address: string, signature: string) => signer.verifyMessage(message, address, signature),
  });
  const message = 'hardware message';
  const address = signer._getExternalAddressByIndex(2);
  const fixture: MessageSigningFixture = { wallet, association, message, address, signature: signer.signMessage(message, address) };
  return fixture;
}

function messageRoute(fixture: MessageSigningFixture, attempt = 1) {
  return {
    mode: 'sign-message' as const,
    walletID: fixture.wallet.getID(),
    hardwareAccount: fixture.association,
    snapshot: { address: fixture.address, index: 2, isInternal: false },
    path: `${fixture.association.path}/0/2`,
    message: fixture.message,
    attempt,
  };
}

it('accepts a real locally verifiable device signature without rewriting its header', async () => {
  const fixture = makeMessageSigningWallet();
  mockWallets = [fixture.wallet];
  mockRouteParams = messageRoute(fixture);
  mockSignMessage.mockResolvedValueOnce(fixture.signature);
  const view = render(<HardwareWalletAccount />);
  await reachSigningOperation(view);
  fireEvent.press(view.getByTestId('HardwareSignMessage'));

  await waitFor(() => expect(mockDispatch).toHaveBeenCalledTimes(1));
  expect(mockSignMessage).toHaveBeenCalledWith(mockRouteParams.path, 'legacy', fixture.message);
  const returned = JSON.stringify(mockDispatch.mock.calls[0][0]);
  expect(returned).toContain('SignVerify');
  expect(returned).toContain(fixture.signature);
});

it('rejects a valid compact signature carrying the wrong address-format header', async () => {
  const fixture = makeMessageSigningWallet();
  const wrongHeader = Buffer.from(fixture.signature, 'base64');
  wrongHeader[0] = 39;
  mockWallets = [fixture.wallet];
  mockRouteParams = messageRoute(fixture);
  mockSignMessage.mockResolvedValueOnce(wrongHeader.toString('base64'));
  const view = render(<HardwareWalletAccount />);
  await reachSigningOperation(view);
  fireEvent.press(view.getByTestId('HardwareSignMessage'));

  await waitFor(() =>
    expect(view.getByTestId('HardwareStatus').props.children).toBe('The hardware wallet returned an invalid message signature.'),
  );
  expect(mockDispatch).not.toHaveBeenCalled();
});

it('rejects an altered compact signature body', async () => {
  const fixture = makeMessageSigningWallet();
  const altered = Buffer.from(fixture.signature, 'base64');
  altered[64] = altered[64] === 0 ? 1 : altered[64] - 1;
  mockWallets = [fixture.wallet];
  mockRouteParams = messageRoute(fixture);
  mockSignMessage.mockResolvedValueOnce(altered.toString('base64'));
  const view = render(<HardwareWalletAccount />);
  await reachSigningOperation(view);
  fireEvent.press(view.getByTestId('HardwareSignMessage'));

  await waitFor(() =>
    expect(view.getByTestId('HardwareStatus').props.children).toBe('The hardware wallet returned an invalid message signature.'),
  );
  expect(mockDispatch).not.toHaveBeenCalled();
});

it('drops a message signature returned after the associated wallet is deleted', async () => {
  const fixture = makeMessageSigningWallet();
  const pendingSign = withResolvers<string>();
  mockWallets = [fixture.wallet];
  mockRouteParams = messageRoute(fixture);
  mockSignMessage.mockReturnValueOnce(pendingSign.promise);
  const view = render(<HardwareWalletAccount />);
  await reachSigningOperation(view);
  fireEvent.press(view.getByTestId('HardwareSignMessage'));
  await waitFor(() => expect(mockSignMessage).toHaveBeenCalledTimes(1));
  mockWallets = [];
  view.rerender(<HardwareWalletAccount />);
  await act(async () => {
    pendingSign.resolve(fixture.signature);
    await pendingSign.promise;
  });

  await waitFor(() => expect(view.getByTestId('HardwareStatus').props.children).toBe('Hardware signing session expired; start again'));
  expect(mockDispatch).not.toHaveBeenCalled();
});

it('requires an explicit fresh connection after message-signing refusal', async () => {
  const fixture = makeMessageSigningWallet();
  mockWallets = [fixture.wallet];
  mockRouteParams = messageRoute(fixture);
  mockSignMessage.mockRejectedValueOnce(new Bhwi.BhwiError('BHWI_USER_REFUSED')).mockResolvedValueOnce(fixture.signature);
  const view = render(<HardwareWalletAccount />);
  await reachSigningOperation(view);
  fireEvent.press(view.getByTestId('HardwareSignMessage'));
  await waitFor(() => expect(mockSignMessage).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(view.queryByTestId('HardwareOperationAccount')).toBeNull());
  expect(mockDispatch).not.toHaveBeenCalled();

  await reachSigningOperation(view);
  fireEvent.press(view.getByTestId('HardwareSignMessage'));
  await waitFor(() => expect(mockDispatch).toHaveBeenCalledTimes(1));
  expect(mockStartSession).toHaveBeenCalledTimes(2);
  expect(mockSignMessage).toHaveBeenCalledTimes(2);
});

it('requires a fresh connection after signing refusal and never retries automatically', async () => {
  const signingWallet = makeSigningWallet();
  mockWallets = [signingWallet];
  mockRouteParams = {
    mode: 'sign-psbt',
    walletID: signingWallet.getID(),
    hardwareAccount: publicAccount,
    originalBase64: 'original-psbt',
    attempt: 1,
  };
  mockSignPsbt.mockRejectedValueOnce(new Bhwi.BhwiError('BHWI_USER_REFUSED')).mockResolvedValueOnce('signed-psbt');
  const view = render(<HardwareWalletAccount />);
  await reachSigningOperation(view);
  fireEvent.press(view.getByTestId('HardwareSignPsbt'));
  await waitFor(() => expect(mockSignPsbt).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(view.queryByTestId('HardwareOperationAccount')).toBeNull());
  expect(mockStartSession).toHaveBeenCalledTimes(1);
  expect(mockDispatch).not.toHaveBeenCalled();

  await reachSigningOperation(view);
  fireEvent.press(view.getByTestId('HardwareSignPsbt'));
  await waitFor(() => expect(mockDispatch).toHaveBeenCalledTimes(1));
  expect(mockStartSession).toHaveBeenCalledTimes(2);
  expect(mockSignPsbt).toHaveBeenCalledTimes(2);
  expect(mockValidateOriginal).toHaveBeenCalledTimes(2);
  expect(mockValidateResult).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(mockDispatch.mock.calls[0][0])).toContain('signed-psbt');
  expect(JSON.stringify(mockDispatch.mock.calls[0][0])).toContain('original-psbt');
});

test.each(['deleted', 'edited'] as const)('rejects a signing result delivered after the wallet was %s', async change => {
  const signingWallet = makeSigningWallet();
  mockWallets = [signingWallet];
  mockRouteParams = {
    mode: 'sign-psbt',
    walletID: signingWallet.getID(),
    hardwareAccount: publicAccount,
    originalBase64: 'original-psbt',
    attempt: 3,
  };
  const pendingSign = withResolvers<string>();
  mockSignPsbt.mockReturnValueOnce(pendingSign.promise);
  const view = render(<HardwareWalletAccount />);
  await reachSigningOperation(view);
  fireEvent.press(view.getByTestId('HardwareSignPsbt'));
  await waitFor(() => expect(mockSignPsbt).toHaveBeenCalledTimes(1));
  mockWallets = change === 'deleted' ? [] : [makeSigningWallet('edited-public-account')];
  view.rerender(<HardwareWalletAccount />);
  await act(async () => {
    pendingSign.resolve('late-signed-psbt');
    await pendingSign.promise;
  });
  await waitFor(() => expect(view.getByTestId('HardwareStatus').props.children).toBe('Hardware signing session expired; start again'));
  expect(mockDispatch).not.toHaveBeenCalled();
  expect(mockValidateResult).not.toHaveBeenCalled();
});

it('leaves screen protection owned by the parent during a signing route', () => {
  const signingWallet = makeSigningWallet();
  mockWallets = [signingWallet];
  mockRouteParams = {
    mode: 'sign-psbt',
    walletID: signingWallet.getID(),
    hardwareAccount: publicAccount,
    originalBase64: 'original-psbt',
    attempt: 4,
  };
  const view = render(<HardwareWalletAccount />);
  expect(mockEnableScreenProtect).not.toHaveBeenCalled();
  view.unmount();
  expect(mockDisableScreenProtect).not.toHaveBeenCalled();
});

it('disconnects and rejects a pending signer completion after an unexpected child blur', async () => {
  const signingWallet = makeSigningWallet();
  mockWallets = [signingWallet];
  mockRouteParams = {
    mode: 'sign-psbt',
    walletID: signingWallet.getID(),
    hardwareAccount: publicAccount,
    originalBase64: 'original-psbt',
    attempt: 5,
  };
  const pendingSign = withResolvers<string>();
  mockSignPsbt.mockReturnValueOnce(pendingSign.promise);
  const view = render(<HardwareWalletAccount />);
  await reachSigningOperation(view);
  fireEvent.press(view.getByTestId('HardwareSignPsbt'));
  await waitFor(() => expect(mockSignPsbt).toHaveBeenCalledTimes(1));
  mockIsFocused = false;
  view.rerender(<HardwareWalletAccount />);
  await act(async () => {
    pendingSign.resolve('late-signed-psbt');
    await pendingSign.promise;
  });
  expect(mockDispatch).not.toHaveBeenCalled();
  expect(mockValidateResult).not.toHaveBeenCalled();
  expect(mockDisconnect).toHaveBeenCalled();
});
