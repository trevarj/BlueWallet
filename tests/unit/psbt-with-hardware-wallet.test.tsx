import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { RenderAPI } from '@testing-library/react-native';
import { AppState } from 'react-native';
import type { AppStateStatus } from 'react-native';
import BIP32Factory from 'bip32';
import type { BIP32Interface } from 'bip32';
import * as bitcoin from 'bitcoinjs-lib';
import { Buffer } from 'buffer';

import { WatchOnlyWallet } from '../../class/wallets/watch-only-wallet';
import { convertExtendedKey } from '../../class/wallets/extended-key';
import { isBhwiReconnectMatch } from '../../blue_modules/bhwi';
import type { HardwareWalletAssociation } from '../../blue_modules/bhwi';
import ecc from '../../blue_modules/noble_ecc';
import { network } from '../../models/bitcoinNetwork';
import { BHWI_SIGNING_SESSION_EXPIRED, CPFP_FEE_TARGET_NOT_REACHED } from '../../blue_modules/bhwiPsbt';
import type { BhwiCpfpContext } from '../../blue_modules/bhwiPsbt';
import PsbtWithHardwareWallet from '../../screen/send/psbtWithHardwareWallet';

bitcoin.initEccLib(ecc);
const bip32 = BIP32Factory(ecc);
const accountPath = network === bitcoin.networks.bitcoin ? "m/84'/0'/0'" : "m/84'/1'/0'";

type AssociatedFixture = {
  wallet: WatchOnlyWallet;
  association: HardwareWalletAssociation;
  psbt: bitcoin.Psbt;
  children: BIP32Interface[];
  parents: bitcoin.Transaction[];
};

function required<Value>(value: Value | null | undefined): Value {
  if (value === null || value === undefined) throw new Error('Missing fixture value');
  return value;
}

function makeParent(script: Uint8Array, value: bigint, marker: number): bitcoin.Transaction {
  const transaction = new bitcoin.Transaction();
  const hash = new Uint8Array(32);
  hash[0] = marker;
  transaction.addInput(hash, 0xffffffff);
  transaction.addOutput(script, value);
  return transaction;
}

function makeAssociatedFixture(inputCount = 2): AssociatedFixture {
  const root = bip32.fromSeed(
    Uint8Array.from({ length: 32 }, (_, index) => index + 41),
    network,
  );
  const account = root.derivePath(accountPath);
  const xpub = account.neutered().toBase58();
  const fingerprint = Buffer.from(root.fingerprint).toString('hex');
  const association: HardwareWalletAssociation = {
    family: 'ledger',
    fingerprint,
    path: accountPath,
    xpub,
    format: 'native-segwit',
  };
  const wallet = new WatchOnlyWallet();
  wallet.setSecret(convertExtendedKey(xpub, 'native')).init();
  wallet.setDerivationPath(accountPath);
  wallet.setMasterFingerprintFromHex(fingerprint);
  wallet.setHardwareWalletAssociation(association);
  const psbt = new bitcoin.Psbt({ network });
  const children: BIP32Interface[] = [];
  const parents: bitcoin.Transaction[] = [];
  for (let index = 0; index < inputCount; index++) {
    const child = account.derive(0).derive(index);
    const script = required(bitcoin.payments.p2wpkh({ pubkey: child.publicKey, network }).output);
    const parent = makeParent(script, 100_000n, index + 1);
    psbt.addInput({
      hash: parent.getId(),
      index: 0,
      witnessUtxo: { script, value: 100_000n },
      bip32Derivation: [
        {
          masterFingerprint: Buffer.from(fingerprint, 'hex'),
          path: `${accountPath}/0/${index}`,
          pubkey: child.publicKey,
        },
      ],
    });
    children.push(child);
    parents.push(parent);
  }
  const destination = required(bitcoin.payments.p2wpkh({ pubkey: account.derive(1).derive(0).publicKey, network }).output);
  psbt.addOutput({ script: destination, value: 100_000n * BigInt(inputCount) - 1_000n });
  return { wallet, association, psbt, children, parents };
}

function parentMap(fixture: AssociatedFixture): Record<string, string> {
  return Object.fromEntries(fixture.parents.map(parent => [parent.getId(), parent.toHex()]));
}

const mockNavigate = jest.fn();
const mockDispatch = jest.fn();
const mockSetParams = jest.fn((params: Record<string, unknown>) => {
  mockRouteParams = { ...mockRouteParams, ...params };
});
const mockEnsureConnected = jest.fn();
const mockPresentAlert = jest.fn();
const mockMultiGetTransaction = jest.fn();
const mockEnableScreenProtect = jest.fn();
const mockDisableScreenProtect = jest.fn();
const mockFetchAndSaveWalletTransactions = jest.fn();
const mockOpenSignedTransactionRaw = jest.fn();
const mockMajorTomToGroundControl = jest.fn();
let mockNavigation = { navigate: mockNavigate, dispatch: mockDispatch, setParams: mockSetParams };
let mockBhwiAvailable = true;
let mockIsFocused = true;
let mockAppStateChange: (state: AppStateStatus) => void = () => undefined;
let mockRouteParams: Record<string, unknown>;
let mockWallet: WatchOnlyWallet;
let mockWallets: WatchOnlyWallet[] = [];

function setMockWallet(wallet: WatchOnlyWallet): void {
  mockWallet = wallet;
  mockWallets = [wallet];
}

jest.mock('@react-navigation/native', () => {
  const actual = jest.requireActual('@react-navigation/native');
  return {
    ...actual,
    useIsFocused: () => mockIsFocused,
    useNavigation: () => mockNavigation,
    useRoute: () => ({ params: mockRouteParams }),
  };
});

jest.mock('../../blue_modules/bhwi', () => {
  const actual = jest.requireActual('../../blue_modules/bhwi');
  return { ...actual, isBhwiAvailable: () => mockBhwiAvailable };
});

jest.mock('../../hooks/context/useStorage', () => ({
  useStorage: () => ({
    wallets: mockWallets,
    txMetadata: {},
    fetchAndSaveWalletTransactions: mockFetchAndSaveWalletTransactions,
  }),
}));
jest.mock('../../hooks/context/useSettings', () => ({ useSettings: () => ({ isElectrumDisabled: false }) }));
jest.mock('../../hooks/useBiometrics', () => ({
  useBiometrics: () => ({ isBiometricUseCapableAndEnabled: jest.fn(async () => false) }),
  unlockWithBiometrics: jest.fn(async () => true),
}));
jest.mock('../../components/Alert', () => ({ __esModule: true, default: (...args: unknown[]) => mockPresentAlert(...args) }));
jest.mock('../../hooks/useScreenProtect', () => ({
  useScreenProtect: () => ({ enableScreenProtect: mockEnableScreenProtect, disableScreenProtect: mockDisableScreenProtect }),
}));
jest.mock('../../components/themes', () => ({ useTheme: () => ({ colors: new Proxy({}, { get: () => '#000000' }) }) }));
jest.mock('../../blue_modules/BlueElectrum', () => ({
  ensureConnected: (...args: unknown[]) => mockEnsureConnected(...args),
  multiGetTransactionByTxid: (...args: unknown[]) => mockMultiGetTransaction(...args),
}));
jest.mock('../../blue_modules/hapticFeedback', () => ({
  __esModule: true,
  default: jest.fn(),
  HapticFeedbackTypes: { NotificationError: 'notificationError' },
}));
jest.mock('../../blue_modules/fs', () => ({
  openSignedTransactionRaw: (...args: unknown[]) => mockOpenSignedTransactionRaw(...args),
}));
jest.mock('../../blue_modules/notifications', () => ({
  majorTomToGroundControl: (...args: unknown[]) => mockMajorTomToGroundControl(...args),
}));
jest.mock('../../components/DynamicQRCode', () => {
  const ReactModule = require('react');
  const { View: MockView } = require('react-native');
  return {
    DynamicQRCode: ReactModule.forwardRef(function MockDynamicQRCode(_props: unknown, ref: React.Ref<unknown>) {
      ReactModule.useImperativeHandle(ref, () => ({ startAutoMove: jest.fn(), stopAutoMove: jest.fn() }));
      return ReactModule.createElement(MockView, { testID: 'DynamicQRCode' });
    }),
  };
});
jest.mock('../../components/SaveFileButton', () => {
  const ReactModule = require('react');
  const { View: MockView } = require('react-native');
  return {
    __esModule: true,
    default: ({ children, fileContent }: { children: React.ReactNode; fileContent: string }) =>
      ReactModule.createElement(MockView, { fileContent, testID: 'SaveFileButton' }, children),
  };
});
jest.mock('../../components/CopyToClipboardButton', () => {
  const ReactModule = require('react');
  const { Text: MockText } = require('react-native');
  return {
    __esModule: true,
    default: ({ displayText }: { displayText: string }) => ReactModule.createElement(MockText, null, displayText),
  };
});
jest.mock('../../components/SecondButton', () => {
  const ReactModule = require('react');
  const { Pressable: MockPressable, Text: MockText } = require('react-native');
  return {
    SecondButton: ReactModule.forwardRef(function MockSecondButton(
      { disabled, onPress, testID, title }: { disabled?: boolean; onPress?: () => void; testID?: string; title: string },
      _ref: React.Ref<unknown>,
    ) {
      return ReactModule.createElement(MockPressable, { disabled, onPress, testID }, ReactModule.createElement(MockText, null, title));
    }),
  };
});

async function renderPreparedAssociated(fixture: AssociatedFixture, cpfp?: BhwiCpfpContext): Promise<RenderAPI> {
  setMockWallet(fixture.wallet);
  mockRouteParams = { walletID: fixture.wallet.getID(), psbt: fixture.psbt, cpfp };
  mockMultiGetTransaction.mockResolvedValue(parentMap(fixture));
  const view = render(<PsbtWithHardwareWallet />);
  await waitFor(() => {
    const status = view.queryByTestId('BhwiHardwareStatus');
    if (status) throw new Error(`Hardware preparation failed: ${String(status.props.children)}`);
    expect(mockRouteParams.bhwiOriginalBase64).toEqual(expect.any(String));
    expect(view.getByTestId('PsbtTxScanButton')).toBeTruthy();
  });
  await view.findByTestId('BhwiTransactionReview');
  return view;
}

beforeEach(() => {
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active', writable: true });
  jest.clearAllMocks();
  mockSetParams.mockImplementation((params: Record<string, unknown>) => {
    mockRouteParams = { ...mockRouteParams, ...params };
  });
  mockBhwiAvailable = true;
  mockIsFocused = true;
  mockNavigation = { navigate: mockNavigate, dispatch: mockDispatch, setParams: mockSetParams };
  mockEnsureConnected.mockResolvedValue(true);
  mockOpenSignedTransactionRaw.mockResolvedValue(undefined);
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
    mockAppStateChange = listener as (state: AppStateStatus) => void;
    return { remove: jest.fn() };
  });
  const psbt = new bitcoin.Psbt({ network });
  psbt.addOutput({ script: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN]), value: 0n });
  setMockWallet(Object.create(WatchOnlyWallet.prototype) as WatchOnlyWallet);
  Object.assign(mockWallet, {
    getID: () => 'offline-wallet',
    getHardwareWalletAssociation: () => undefined,
  });
  mockRouteParams = { walletID: mockWallet.getID(), psbt };
});

afterEach(() => jest.restoreAllMocks());

test('keeps an unassociated wallet offline and preserves its existing raw-scan return', async () => {
  const view = render(<PsbtWithHardwareWallet />);
  expect(view.queryByTestId('BhwiPreparePsbt')).toBeNull();
  expect(view.queryByTestId('BhwiSignPsbt')).toBeNull();
  expect(view.getByTestId('PsbtTxScanButton')).toBeTruthy();
  expect(mockEnsureConnected).not.toHaveBeenCalled();
  expect(mockMultiGetTransaction).not.toHaveBeenCalled();

  mockRouteParams = { ...mockRouteParams, onBarScanned: 'deadbeef' };
  view.rerender(<PsbtWithHardwareWallet />);
  await waitFor(() => expect(view.getByTestId('PsbtWithHardwareWalletBroadcastTransactionButton')).toBeTruthy());
  expect(mockEnsureConnected).not.toHaveBeenCalled();
});

test('rejects a hardware-bound raw route when its immutable original is missing', async () => {
  mockRouteParams = { ...mockRouteParams, bhwiBound: true, bhwiAttempt: 1, txhex: 'deadbeef' };
  const view = render(<PsbtWithHardwareWallet />);
  await waitFor(() =>
    expect(mockPresentAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        message: BHWI_SIGNING_SESSION_EXPIRED,
      }),
    ),
  );
  expect(view.queryByTestId('PsbtWithHardwareWalletBroadcastTransactionButton')).toBeNull();
});

test('fails closed when associated parent hydration fails and rejects a raw downgrade', async () => {
  const fixture = makeAssociatedFixture();
  setMockWallet(fixture.wallet);
  mockRouteParams = { walletID: fixture.wallet.getID(), psbt: fixture.psbt };
  mockMultiGetTransaction.mockResolvedValue({});
  const view = render(<PsbtWithHardwareWallet />);
  await waitFor(() => expect(mockMultiGetTransaction).toHaveBeenCalled());
  await waitFor(() => expect(view.getByTestId('BhwiPreparePsbt')).toBeTruthy());
  expect(view.queryByTestId('PsbtTxScanButton')).toBeNull();
  expect(view.queryByTestId('SaveFileButton')).toBeNull();

  mockRouteParams = { ...mockRouteParams, onBarScanned: 'deadbeef' };
  view.rerender(<PsbtWithHardwareWallet />);
  await waitFor(() => expect(mockPresentAlert).toHaveBeenCalledWith(expect.objectContaining({ message: BHWI_SIGNING_SESSION_EXPIRED })));
  expect(view.queryByTestId('PsbtWithHardwareWalletBroadcastTransactionButton')).toBeNull();
  expect(view.queryByTestId('PsbtTxScanButton')).toBeNull();
});

test('rejects an associated standalone txhex without an immutable original', async () => {
  const fixture = makeAssociatedFixture();
  setMockWallet(fixture.wallet);
  mockRouteParams = { walletID: fixture.wallet.getID(), txhex: 'deadbeef' };
  const view = render(<PsbtWithHardwareWallet />);
  await waitFor(() => expect(mockPresentAlert).toHaveBeenCalledWith(expect.objectContaining({ message: BHWI_SIGNING_SESSION_EXPIRED })));
  expect(view.queryByTestId('PsbtWithHardwareWalletBroadcastTransactionButton')).toBeNull();
  expect(view.queryByTestId('PsbtTxScanButton')).toBeNull();
});

test('uses the real verifier to keep a valid partial exportable and expose only a complete transaction for broadcast', async () => {
  const fixture = makeAssociatedFixture();
  const partialView = await renderPreparedAssociated(fixture);
  const originalBase64 = required(mockRouteParams.bhwiOriginalBase64 as string | undefined);
  const partial = bitcoin.Psbt.fromBase64(originalBase64, { network });
  partial.signInput(0, required(fixture.children[0]));
  mockRouteParams = { ...mockRouteParams, bhwiReturnedBase64: partial.toBase64() };
  partialView.rerender(<PsbtWithHardwareWallet />);
  await partialView.findByTestId('PsbtTxScanButton');
  expect(partialView.queryByTestId('PsbtWithHardwareWalletBroadcastTransactionButton')).toBeNull();
  const exported = bitcoin.Psbt.fromBase64(partialView.getByTestId('SaveFileButton').props.fileContent, { network });
  expect(exported.data.inputs[0]?.finalScriptWitness).toBeDefined();
  expect(exported.data.inputs[1]?.finalScriptWitness).toBeUndefined();
  partialView.unmount();

  const completeFixture = makeAssociatedFixture();
  const completeView = await renderPreparedAssociated(completeFixture);
  const completeOriginal = required(mockRouteParams.bhwiOriginalBase64 as string | undefined);
  const complete = bitcoin.Psbt.fromBase64(completeOriginal, { network });
  complete.signInput(0, required(completeFixture.children[0]));
  complete.signInput(1, required(completeFixture.children[1]));
  mockRouteParams = { ...mockRouteParams, bhwiReturnedBase64: complete.toBase64() };
  completeView.rerender(<PsbtWithHardwareWallet />);
  await completeView.findByTestId('PsbtWithHardwareWalletBroadcastTransactionButton');
});

test('rejects a signed CPFP whose real child virtual size misses the package target before confirmation', async () => {
  const fixture = makeAssociatedFixture();
  const signed = fixture.psbt.clone();
  signed.signInput(0, required(fixture.children[0]));
  signed.signInput(1, required(fixture.children[1]));
  const childVsize = signed.clone().finalizeAllInputs().extractTransaction().virtualSize();
  const view = await renderPreparedAssociated(fixture, {
    parentFee: 0,
    parentVsize: 100,
    targetFeeRate: 1_000 / (100 + childVsize) + 0.01,
  });
  const originalBase64 = required(mockRouteParams.bhwiOriginalBase64 as string | undefined);
  const complete = bitcoin.Psbt.fromBase64(originalBase64, { network });
  complete.signInput(0, required(fixture.children[0]));
  complete.signInput(1, required(fixture.children[1]));
  mockRouteParams = { ...mockRouteParams, bhwiReturnedBase64: complete.toBase64() };
  view.rerender(<PsbtWithHardwareWallet />);

  await waitFor(() => expect(mockPresentAlert).toHaveBeenCalledWith(expect.objectContaining({ message: CPFP_FEE_TARGET_NOT_REACHED })));
  expect(view.queryByTestId('PsbtWithHardwareWalletBroadcastTransactionButton')).toBeNull();
});

test('rejects malformed and stale CPFP metadata from the route', async () => {
  const malformedFixture = makeAssociatedFixture();
  setMockWallet(malformedFixture.wallet);
  mockRouteParams = {
    walletID: malformedFixture.wallet.getID(),
    psbt: malformedFixture.psbt,
    cpfp: { parentFee: -1, parentVsize: 100, targetFeeRate: Number.NaN },
  };
  mockMultiGetTransaction.mockResolvedValue(parentMap(malformedFixture));
  const malformedView = render(<PsbtWithHardwareWallet />);
  await waitFor(() => expect(malformedView.getByTestId('BhwiHardwareStatus').props.children).toBe(BHWI_SIGNING_SESSION_EXPIRED));
  expect(malformedView.queryByTestId('BhwiTransactionReview')).toBeNull();
  malformedView.unmount();

  const staleFixture = makeAssociatedFixture();
  const staleView = await renderPreparedAssociated(staleFixture, { parentFee: 0, parentVsize: 100, targetFeeRate: 0.1 });
  const originalBase64 = required(mockRouteParams.bhwiOriginalBase64 as string | undefined);
  const complete = bitcoin.Psbt.fromBase64(originalBase64, { network });
  complete.signInput(0, required(staleFixture.children[0]));
  complete.signInput(1, required(staleFixture.children[1]));
  mockRouteParams = {
    ...mockRouteParams,
    cpfp: { parentFee: 0, parentVsize: 100, targetFeeRate: 0.01 },
    bhwiReturnedBase64: complete.toBase64(),
  };
  staleView.rerender(<PsbtWithHardwareWallet />);
  await waitFor(() => {
    const alerted = mockPresentAlert.mock.calls.some(([value]) => value?.message === BHWI_SIGNING_SESSION_EXPIRED);
    const status = staleView.queryByTestId('BhwiHardwareStatus')?.props.children === BHWI_SIGNING_SESSION_EXPIRED;
    expect(alerted || status).toBe(true);
  });
  expect(staleView.queryByTestId('PsbtWithHardwareWalletBroadcastTransactionButton')).toBeNull();
});

test('rechecks the real signed CPFP package immediately before broadcast and clears the ready state on failure', async () => {
  const fixture = makeAssociatedFixture();
  const broadcastTx = jest.spyOn(fixture.wallet, 'broadcastTx').mockResolvedValue(true);
  const view = await renderPreparedAssociated(fixture, { parentFee: 0, parentVsize: 100, targetFeeRate: 0.1 });
  const originalBase64 = required(mockRouteParams.bhwiOriginalBase64 as string | undefined);
  const complete = bitcoin.Psbt.fromBase64(originalBase64, { network });
  complete.signInput(0, required(fixture.children[0]));
  complete.signInput(1, required(fixture.children[1]));
  mockRouteParams = { ...mockRouteParams, bhwiReturnedBase64: complete.toBase64() };
  view.rerender(<PsbtWithHardwareWallet />);
  await view.findByTestId('PsbtWithHardwareWalletBroadcastTransactionButton');

  jest.spyOn(bitcoin.Transaction.prototype, 'virtualSize').mockReturnValue(1_000_000);
  fireEvent.press(view.getByTestId('PsbtWithHardwareWalletBroadcastTransactionButton'));
  await waitFor(() => expect(mockPresentAlert).toHaveBeenCalledWith(expect.objectContaining({ message: CPFP_FEE_TARGET_NOT_REACHED })));
  expect(broadcastTx).not.toHaveBeenCalled();
  expect(view.queryByTestId('PsbtWithHardwareWalletBroadcastTransactionButton')).toBeNull();
});

test('rejects an altered scanner return without downgrading the associated flow', async () => {
  const fixture = makeAssociatedFixture();
  const view = await renderPreparedAssociated(fixture);
  const originalBase64 = required(mockRouteParams.bhwiOriginalBase64 as string | undefined);
  const altered = bitcoin.Psbt.fromBase64(originalBase64, { network });
  altered.setLocktime(1);
  altered.signInput(0, required(fixture.children[0]));
  mockRouteParams = { ...mockRouteParams, onBarScanned: altered.toBase64() };
  view.rerender(<PsbtWithHardwareWallet />);
  await waitFor(() =>
    expect(mockPresentAlert).toHaveBeenCalledWith(expect.objectContaining({ message: 'Hardware wallet changed the transaction' })),
  );
  expect(view.queryByTestId('PsbtWithHardwareWalletBroadcastTransactionButton')).toBeNull();
  expect(view.queryByTestId('PsbtTxScanButton')).toBeNull();
});

test('invalidates pending and completed work on unexpected blur but preserves an intentional scanner continuation', async () => {
  const pendingFixture = makeAssociatedFixture();
  setMockWallet(pendingFixture.wallet);
  mockRouteParams = { walletID: pendingFixture.wallet.getID(), psbt: pendingFixture.psbt };
  let resolveParents!: (parents: Record<string, string>) => void;
  const pendingParents = new Promise<Record<string, string>>(resolve => {
    resolveParents = resolve;
  });
  mockMultiGetTransaction.mockReturnValueOnce(pendingParents);
  const pendingView = render(<PsbtWithHardwareWallet />);
  await waitFor(() => expect(mockMultiGetTransaction).toHaveBeenCalled());
  mockIsFocused = false;
  pendingView.rerender(<PsbtWithHardwareWallet />);
  await act(async () => {
    resolveParents(parentMap(pendingFixture));
    await pendingParents;
  });
  mockIsFocused = true;
  pendingView.rerender(<PsbtWithHardwareWallet />);
  await pendingView.findByTestId('BhwiPreparePsbt');
  expect(pendingView.queryByTestId('BhwiTransactionReview')).toBeNull();
  expect(pendingView.queryByTestId('PsbtTxScanButton')).toBeNull();
  pendingView.unmount();

  const completedFixture = makeAssociatedFixture();
  const completedView = await renderPreparedAssociated(completedFixture);
  const completeOriginal = required(mockRouteParams.bhwiOriginalBase64 as string | undefined);
  const complete = bitcoin.Psbt.fromBase64(completeOriginal, { network });
  complete.signInput(0, required(completedFixture.children[0]));
  complete.signInput(1, required(completedFixture.children[1]));
  mockRouteParams = { ...mockRouteParams, bhwiReturnedBase64: complete.toBase64() };
  completedView.rerender(<PsbtWithHardwareWallet />);
  await completedView.findByTestId('PsbtWithHardwareWalletBroadcastTransactionButton');
  mockIsFocused = false;
  completedView.rerender(<PsbtWithHardwareWallet />);
  mockIsFocused = true;
  completedView.rerender(<PsbtWithHardwareWallet />);
  await completedView.findByTestId('BhwiPreparePsbt');
  expect(completedView.queryByTestId('PsbtWithHardwareWalletBroadcastTransactionButton')).toBeNull();
  expect(completedView.queryByTestId('PsbtTxScanButton')).toBeNull();
  completedView.unmount();

  const scannerFixture = makeAssociatedFixture();
  const scannerView = await renderPreparedAssociated(scannerFixture);
  fireEvent.press(scannerView.getByTestId('PsbtTxScanButton'));
  mockIsFocused = false;
  scannerView.rerender(<PsbtWithHardwareWallet />);
  mockIsFocused = true;
  scannerView.rerender(<PsbtWithHardwareWallet />);
  expect(scannerView.getByTestId('BhwiTransactionReview')).toBeTruthy();
  expect(scannerView.getByTestId('PsbtTxScanButton')).toBeTruthy();
});

test('clears a verified associated result on background and requires a new preparation', async () => {
  const fixture = makeAssociatedFixture();
  const view = await renderPreparedAssociated(fixture);
  const originalBase64 = required(mockRouteParams.bhwiOriginalBase64 as string | undefined);
  const complete = bitcoin.Psbt.fromBase64(originalBase64, { network });
  complete.signInput(0, required(fixture.children[0]));
  complete.signInput(1, required(fixture.children[1]));
  mockRouteParams = { ...mockRouteParams, bhwiReturnedBase64: complete.toBase64() };
  view.rerender(<PsbtWithHardwareWallet />);
  await view.findByTestId('PsbtWithHardwareWalletBroadcastTransactionButton');
  act(() => mockAppStateChange('background'));
  await view.findByTestId('BhwiPreparePsbt');
  expect(view.queryByTestId('PsbtWithHardwareWalletBroadcastTransactionButton')).toBeNull();
  expect(view.queryByTestId('PsbtTxScanButton')).toBeNull();
});

test('immediately clears a verified associated result when the live wallet is deleted', async () => {
  const fixture = makeAssociatedFixture();
  const view = await renderPreparedAssociated(fixture);
  const originalBase64 = required(mockRouteParams.bhwiOriginalBase64 as string | undefined);
  const complete = bitcoin.Psbt.fromBase64(originalBase64, { network });
  complete.signInput(0, required(fixture.children[0]));
  complete.signInput(1, required(fixture.children[1]));
  mockRouteParams = { ...mockRouteParams, bhwiReturnedBase64: complete.toBase64() };
  view.rerender(<PsbtWithHardwareWallet />);
  await view.findByTestId('PsbtWithHardwareWalletBroadcastTransactionButton');

  mockWallets = [];
  view.rerender(<PsbtWithHardwareWallet />);
  await view.findByTestId('BhwiPreparePsbt');
  expect(view.queryByTestId('PsbtWithHardwareWalletBroadcastTransactionButton')).toBeNull();
  expect(view.queryByTestId('PsbtTxScanButton')).toBeNull();
});

test('requires exact reconnect identity with the real matcher', () => {
  const { association } = makeAssociatedFixture();
  const info = { family: association.family, fingerprint: association.fingerprint };
  const account = { ...association };
  expect(isBhwiReconnectMatch(association, info, account)).toBe(true);
  expect(isBhwiReconnectMatch(association, info, { ...account, xpub: `${account.xpub}changed` })).toBe(false);
  expect(isBhwiReconnectMatch(association, { ...info, fingerprint: '00000000' }, account)).toBe(false);
});

test('keeps parent screen protection active across the intentional hardware child continuation', async () => {
  const fixture = makeAssociatedFixture();
  const view = await renderPreparedAssociated(fixture);
  expect(mockEnableScreenProtect).toHaveBeenCalled();
  const disableCallsBeforeChild = mockDisableScreenProtect.mock.calls.length;
  fireEvent.press(view.getByTestId('BhwiSignPsbt'));
  expect(mockNavigate).toHaveBeenCalledWith(
    'HardwareWalletAccount',
    expect.objectContaining({ mode: 'sign-psbt', walletID: fixture.wallet.getID() }),
  );
  mockIsFocused = false;
  view.rerender(<PsbtWithHardwareWallet />);
  expect(mockDisableScreenProtect).toHaveBeenCalledTimes(disableCallsBeforeChild);
  mockIsFocused = true;
  view.rerender(<PsbtWithHardwareWallet />);
  expect(view.getByTestId('BhwiTransactionReview')).toBeTruthy();
  expect(mockDisableScreenProtect).toHaveBeenCalledTimes(disableCallsBeforeChild);
});

test('discards a stale first preparation and publishes the current lifecycle retry', async () => {
  const fixture = makeAssociatedFixture();
  setMockWallet(fixture.wallet);
  mockRouteParams = { walletID: fixture.wallet.getID(), psbt: fixture.psbt };
  let resolveFirst!: (parents: Record<string, string>) => void;
  const firstParents = new Promise<Record<string, string>>(resolve => {
    resolveFirst = resolve;
  });
  mockMultiGetTransaction.mockReturnValueOnce(firstParents).mockResolvedValue(parentMap(fixture));
  const view = render(<PsbtWithHardwareWallet />);
  await waitFor(() => expect(mockMultiGetTransaction.mock.calls.length).toBeGreaterThanOrEqual(1));
  if (mockMultiGetTransaction.mock.calls.length === 1) {
    mockNavigation = { navigate: mockNavigate, dispatch: mockDispatch, setParams: mockSetParams };
    view.rerender(<PsbtWithHardwareWallet />);
  }
  await waitFor(() => expect(mockMultiGetTransaction.mock.calls.length).toBeGreaterThanOrEqual(2));
  await waitFor(() => expect(mockRouteParams.bhwiOriginalBase64).toEqual(expect.any(String)));
  const currentOriginal = mockRouteParams.bhwiOriginalBase64;
  await act(async () => {
    resolveFirst(parentMap(fixture));
    await firstParents;
  });
  expect(mockRouteParams.bhwiOriginalBase64).toBe(currentOriginal);
  expect(view.getByTestId('BhwiTransactionReview')).toBeTruthy();
});

test('stages a picker result after resume and requires explicit verification against a fresh review', async () => {
  const fixture = makeAssociatedFixture();
  const view = await renderPreparedAssociated(fixture);
  const oldAttempt = mockRouteParams.bhwiAttempt;
  const originalBase64 = required(mockRouteParams.bhwiOriginalBase64 as string | undefined);
  const complete = bitcoin.Psbt.fromBase64(originalBase64, { network });
  complete.signInput(0, required(fixture.children[0]));
  complete.signInput(1, required(fixture.children[1]));
  let resolveFile!: (value: string | false) => void;
  const pendingFile = new Promise<string | false>(resolve => {
    resolveFile = resolve;
  });
  mockOpenSignedTransactionRaw.mockReturnValueOnce(pendingFile);
  fireEvent.press(view.getByTestId('PsbtTxOpenButton'));
  act(() => {
    mockAppStateChange('inactive');
    mockAppStateChange('background');
  });
  await act(async () => {
    resolveFile(complete.toBase64());
    await pendingFile;
    await Promise.resolve();
  });
  expect(view.queryByTestId('PsbtWithHardwareWalletBroadcastTransactionButton')).toBeNull();
  await act(async () => {
    mockAppStateChange('active');
    await Promise.resolve();
  });
  await view.findByTestId('BhwiVerifyStagedFile');
  expect(view.getByTestId('BhwiTransactionReview')).toBeTruthy();
  expect(mockRouteParams.bhwiAttempt).not.toBe(oldAttempt);
  expect(view.queryByTestId('PsbtWithHardwareWalletBroadcastTransactionButton')).toBeNull();
  fireEvent.press(view.getByTestId('BhwiVerifyStagedFile'));
  await view.findByTestId('PsbtWithHardwareWalletBroadcastTransactionButton');
});

test('clears a staged picker result on a new background before confirmation', async () => {
  const fixture = makeAssociatedFixture();
  const view = await renderPreparedAssociated(fixture);
  const originalBase64 = required(mockRouteParams.bhwiOriginalBase64 as string | undefined);
  const complete = bitcoin.Psbt.fromBase64(originalBase64, { network });
  complete.signInput(0, required(fixture.children[0]));
  complete.signInput(1, required(fixture.children[1]));
  mockOpenSignedTransactionRaw.mockResolvedValueOnce(complete.toBase64());
  fireEvent.press(view.getByTestId('PsbtTxOpenButton'));
  await view.findByTestId('BhwiVerifyStagedFile');
  act(() => mockAppStateChange('background'));
  await view.findByTestId('BhwiPreparePsbt');
  expect(view.queryByTestId('BhwiVerifyStagedFile')).toBeNull();
  expect(view.queryByTestId('PsbtWithHardwareWalletBroadcastTransactionButton')).toBeNull();
  expect(view.queryByTestId('PsbtTxScanButton')).toBeNull();
});

test('strictly rejects an altered staged picker result after explicit confirmation', async () => {
  const fixture = makeAssociatedFixture();
  const view = await renderPreparedAssociated(fixture);
  const originalBase64 = required(mockRouteParams.bhwiOriginalBase64 as string | undefined);
  const altered = bitcoin.Psbt.fromBase64(originalBase64, { network });
  altered.setLocktime(1);
  altered.signInput(0, required(fixture.children[0]));
  mockOpenSignedTransactionRaw.mockResolvedValueOnce(altered.toBase64());
  fireEvent.press(view.getByTestId('PsbtTxOpenButton'));
  await view.findByTestId('BhwiVerifyStagedFile');
  fireEvent.press(view.getByTestId('BhwiVerifyStagedFile'));
  await waitFor(() =>
    expect(mockPresentAlert).toHaveBeenCalledWith(expect.objectContaining({ message: 'Hardware wallet changed the transaction' })),
  );
  expect(view.queryByTestId('PsbtWithHardwareWalletBroadcastTransactionButton')).toBeNull();
  expect(view.queryByTestId('BhwiVerifyStagedFile')).toBeNull();
});

test('stages a scanner picker return after foreground resume and requires a fresh explicit review', async () => {
  const fixture = makeAssociatedFixture();
  const view = await renderPreparedAssociated(fixture);
  const oldAttempt = mockRouteParams.bhwiAttempt;
  const originalBase64 = required(mockRouteParams.bhwiOriginalBase64 as string | undefined);
  const complete = bitcoin.Psbt.fromBase64(originalBase64, { network });
  complete.signInput(0, required(fixture.children[0]));
  complete.signInput(1, required(fixture.children[1]));
  fireEvent.press(view.getByTestId('PsbtTxScanButton'));
  act(() => mockAppStateChange('background'));
  mockRouteParams = {
    ...mockRouteParams,
    onBarScanned: complete.toBase64(),
    onBarScannedFromPicker: true,
  };
  view.rerender(<PsbtWithHardwareWallet />);
  expect(view.queryByTestId('BhwiVerifyStagedFile')).toBeNull();
  await act(async () => {
    mockAppStateChange('active');
    await Promise.resolve();
  });
  await view.findByTestId('BhwiVerifyStagedFile');
  expect(mockRouteParams.bhwiAttempt).not.toBe(oldAttempt);
  expect(view.getByTestId('BhwiTransactionReview')).toBeTruthy();
  expect(view.queryByTestId('PsbtWithHardwareWalletBroadcastTransactionButton')).toBeNull();
  fireEvent.press(view.getByTestId('BhwiVerifyStagedFile'));
  await view.findByTestId('PsbtWithHardwareWalletBroadcastTransactionButton');
});

test('strictly rejects an altered scanner picker return after its fresh review', async () => {
  const fixture = makeAssociatedFixture();
  const view = await renderPreparedAssociated(fixture);
  const originalBase64 = required(mockRouteParams.bhwiOriginalBase64 as string | undefined);
  const altered = bitcoin.Psbt.fromBase64(originalBase64, { network });
  altered.setLocktime(1);
  altered.signInput(0, required(fixture.children[0]));
  mockRouteParams = {
    ...mockRouteParams,
    onBarScanned: altered.toBase64(),
    onBarScannedFromPicker: true,
  };
  view.rerender(<PsbtWithHardwareWallet />);
  await view.findByTestId('BhwiVerifyStagedFile');
  fireEvent.press(view.getByTestId('BhwiVerifyStagedFile'));
  await waitFor(() =>
    expect(mockPresentAlert).toHaveBeenCalledWith(expect.objectContaining({ message: 'Hardware wallet changed the transaction' })),
  );
  expect(view.queryByTestId('PsbtWithHardwareWalletBroadcastTransactionButton')).toBeNull();
});

test('refreshes the wallet after a successful verified hardware broadcast', async () => {
  const fixture = makeAssociatedFixture();
  jest.spyOn(fixture.wallet, 'broadcastTx').mockResolvedValue(true);
  const view = await renderPreparedAssociated(fixture);
  const originalBase64 = required(mockRouteParams.bhwiOriginalBase64 as string | undefined);
  const complete = bitcoin.Psbt.fromBase64(originalBase64, { network });
  complete.signInput(0, required(fixture.children[0]));
  complete.signInput(1, required(fixture.children[1]));
  mockRouteParams = { ...mockRouteParams, bhwiReturnedBase64: complete.toBase64() };
  view.rerender(<PsbtWithHardwareWallet />);
  fireEvent.press(await view.findByTestId('PsbtWithHardwareWalletBroadcastTransactionButton'));
  await waitFor(() => expect(mockFetchAndSaveWalletTransactions).toHaveBeenCalledWith(fixture.wallet.getID()));
  expect(mockNavigate).toHaveBeenCalledWith('Success', { amount: 0 });
});
