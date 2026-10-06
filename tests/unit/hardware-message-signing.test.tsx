import React from 'react';
import { AppState } from 'react-native';
import type { AppStateStatus } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import { HDLegacyP2PKHWallet } from '../../class/wallets/hd-legacy-p2pkh-wallet';
import { WatchOnlyWallet } from '../../class/wallets/watch-only-wallet';
import { matchesBhwiAddressSnapshot } from '../../blue_modules/bhwi';
import type { HardwareWalletAssociation } from '../../blue_modules/bhwi';
import { BitcoinUnit } from '../../models/bitcoinUnits';
import SignVerify from '../../screen/wallets/signVerify';
import { AddressItem } from '../../components/addresses/AddressItem';
import { CommonToolTipActions } from '../../typings/CommonToolTipActions';

const mockNavigate = jest.fn();
const mockSetParams = jest.fn();
const mockNavigation = { navigate: mockNavigate, setParams: mockSetParams };
let mockFocused = true;
let mockRouteParams: Record<string, unknown>;
let mockWallets: WatchOnlyWallet[] = [];
let mockAppStateChange: (state: AppStateStatus) => void = () => undefined;
let capturedActions: Array<{ id: string; hidden?: boolean }> = [];

jest.mock('@react-navigation/native', () => {
  const actual = jest.requireActual('@react-navigation/native');
  return {
    ...actual,
    useIsFocused: () => mockFocused,
    useNavigation: () => mockNavigation,
    useRoute: () => ({ params: mockRouteParams }),
    useLocale: () => ({ direction: 'ltr' }),
  };
});

jest.mock('../../blue_modules/bhwi', () => {
  const actual = jest.requireActual('../../blue_modules/bhwi');
  return { ...actual, isBhwiAvailable: () => true };
});

jest.mock('../../hooks/context/useStorage', () => ({
  useStorage: () => ({ wallets: mockWallets, addressMetadata: {}, sleep: async () => undefined }),
}));

jest.mock('../../components/themes', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#000000' }), dark: false }),
}));

jest.mock('../../hooks/useBiometrics', () => ({
  useBiometrics: () => ({ isBiometricUseCapableAndEnabled: jest.fn(async () => false) }),
  unlockWithBiometrics: jest.fn(async () => true),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

jest.mock('../../components/TooltipMenu', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: ({ actions, children }: React.PropsWithChildren<{ actions: Array<{ id: string; hidden?: boolean }> }>) => {
      capturedActions = actions;
      return ReactModule.createElement(View, null, children);
    },
  };
});

jest.mock('../../blue_modules/hapticFeedback', () => ({
  __esModule: true,
  default: jest.fn(),
  HapticFeedbackTypes: {
    NotificationError: 'notificationError',
    NotificationSuccess: 'notificationSuccess',
    Selection: 'selection',
  },
}));

jest.mock('react-native-share', () => ({ open: jest.fn(async () => undefined) }));

const makeFixture = (family: HardwareWalletAssociation['family'] = 'ledger') => {
  const signer = new HDLegacyP2PKHWallet();
  signer.setSecret('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
  const path = signer.getDerivationPath();
  if (!path) throw new Error('Missing legacy account path');
  const association: HardwareWalletAssociation = {
    family,
    fingerprint: signer.getMasterFingerprintHex().toLowerCase(),
    path,
    xpub: signer.getXpub(),
    format: 'legacy',
  };
  const wallet = new WatchOnlyWallet();
  wallet.setSecret(association.xpub).init();
  wallet.setDerivationPath(association.path);
  wallet.setMasterFingerprintFromHex(association.fingerprint);
  wallet.setHardwareWalletAssociation(association);
  const address = wallet._getInternalAddressByIndex(2);
  const message = 'message snapshot';
  return { signer, wallet, association, address, message, signature: signer.signMessage(message, address) };
};

beforeEach(() => {
  jest.clearAllMocks();
  capturedActions = [];
  mockFocused = true;
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active', writable: true });
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
    mockAppStateChange = listener as (state: AppStateStatus) => void;
    return { remove: jest.fn() };
  });
  const fixture = makeFixture();
  mockWallets = [fixture.wallet];
  mockRouteParams = { walletID: fixture.wallet.getID(), address: fixture.address };
});

afterEach(() => jest.restoreAllMocks());

it('snapshots the exact historical change path and accepts the unchanged real signature result', async () => {
  const fixture = makeFixture();
  const snapshot = { address: fixture.address, index: 2, isInternal: true };
  expect(matchesBhwiAddressSnapshot(fixture.wallet, snapshot)).toBe(true);
  expect(fixture.wallet.verifyMessage(fixture.message, fixture.address, fixture.signature)).toBe(true);
  mockWallets = [fixture.wallet];
  mockRouteParams = { walletID: fixture.wallet.getID(), address: fixture.address };
  const view = render(<SignVerify />);
  fireEvent.changeText(view.getByTestId('Message'), fixture.message);
  fireEvent.press(view.getByText('Sign'));

  expect(mockNavigate).toHaveBeenCalledWith(
    'HardwareWalletAccount',
    expect.objectContaining({
      path: `${fixture.association.path}/1/2`,
      snapshot,
      message: fixture.message,
      hardwareAccount: fixture.association,
    }),
  );
  const request = mockNavigate.mock.calls[0][1] as { attempt: number };
  mockRouteParams = {
    walletID: fixture.wallet.getID(),
    address: fixture.address,
    bhwiMessageAttempt: request.attempt,
    bhwiMessageSignature: fixture.signature,
  };
  view.rerender(<SignVerify />);

  await waitFor(() => expect(view.getByTestId('SignVerifySignature').props.value).toBe(fixture.signature));
  expect(mockSetParams).toHaveBeenCalledWith({ bhwiMessageAttempt: undefined, bhwiMessageSignature: undefined });
});

it('fails closed for an unknown address and a core-unsupported family/format', () => {
  const fixture = makeFixture();
  mockWallets = [fixture.wallet];
  mockRouteParams = { walletID: fixture.wallet.getID(), address: fixture.address };
  const view = render(<SignVerify />);
  fireEvent.changeText(view.getByTestId('Message'), fixture.message);
  fireEvent.changeText(view.getByTestId('SignVerifyAddress'), 'unknown-address');
  fireEvent.press(view.getByText('Sign'));
  expect(mockNavigate).not.toHaveBeenCalled();

  const unsupported = makeFixture('bitbox02');
  mockWallets = [unsupported.wallet];
  mockRouteParams = { walletID: unsupported.wallet.getID(), address: unsupported.address };
  const unsupportedView = render(<SignVerify />);
  fireEvent.changeText(unsupportedView.getByTestId('Message'), unsupported.message);
  fireEvent.press(unsupportedView.getByText('Sign'));
  expect(mockNavigate).not.toHaveBeenCalled();
});

it('rejects a result after the message changes or the app backgrounds', async () => {
  const fixture = makeFixture();
  mockWallets = [fixture.wallet];
  mockRouteParams = { walletID: fixture.wallet.getID(), address: fixture.address };
  const view = render(<SignVerify />);
  fireEvent.changeText(view.getByTestId('Message'), fixture.message);
  fireEvent.press(view.getByText('Sign'));
  const firstRequest = mockNavigate.mock.calls[0][1] as { attempt: number };
  fireEvent.changeText(view.getByTestId('Message'), `${fixture.message} edited`);
  mockRouteParams = {
    walletID: fixture.wallet.getID(),
    address: fixture.address,
    bhwiMessageAttempt: firstRequest.attempt,
    bhwiMessageSignature: fixture.signature,
  };
  view.rerender(<SignVerify />);
  await waitFor(() => expect(view.getByTestId('SignVerifySignature').props.value).toBe(''));

  fireEvent.changeText(view.getByTestId('Message'), fixture.message);
  fireEvent.press(view.getByText('Sign'));
  const secondRequest = mockNavigate.mock.calls[1][1] as { attempt: number };
  act(() => mockAppStateChange('background'));
  mockRouteParams = {
    walletID: fixture.wallet.getID(),
    address: fixture.address,
    bhwiMessageAttempt: secondRequest.attempt,
    bhwiMessageSignature: fixture.signature,
  };
  view.rerender(<SignVerify />);
  await waitFor(() => expect(view.getByTestId('SignVerifySignature').props.value).toBe(''));
});

it('shows hardware Sign message without Export private key and leaves software actions unchanged', () => {
  const item = { key: 'address', address: 'address', index: 0, isInternal: false, balance: 0, transactions: 0 };
  const hardware = render(
    <AddressItem item={item} balanceUnit={BitcoinUnit.BTC} walletID="hardware" allowSignVerifyMessage allowExportPrivateKey={false} />,
  );
  expect(capturedActions.find(action => action.id === CommonToolTipActions.SignVerify.id)?.hidden).toBe(false);
  expect(capturedActions.find(action => action.id === CommonToolTipActions.ExportPrivateKey.id)?.hidden).toBe(true);

  hardware.rerender(
    <AddressItem item={item} balanceUnit={BitcoinUnit.BTC} walletID="software" allowSignVerifyMessage allowExportPrivateKey />,
  );
  expect(capturedActions.find(action => action.id === CommonToolTipActions.SignVerify.id)?.hidden).toBe(false);
  expect(capturedActions.find(action => action.id === CommonToolTipActions.ExportPrivateKey.id)?.hidden).toBe(false);
});
