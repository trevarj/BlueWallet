import React from 'react';
import { render, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { RenderAPI } from '@testing-library/react-native';
import BIP32Factory from 'bip32';
import * as bitcoin from 'bitcoinjs-lib';
import { Buffer } from 'buffer';

import ecc from '../../blue_modules/noble_ecc';
import { convertExtendedKey } from '../../class/wallets/extended-key';
import { HDSegwitBech32Wallet } from '../../class/wallets/hd-segwit-bech32-wallet';
import { MultisigHDWallet } from '../../class/wallets/multisig-hd-wallet';
import { WatchOnlyWallet } from '../../class/wallets/watch-only-wallet';
import type { TWallet } from '../../class/wallets/types';
import type { HardwareWalletAssociation } from '../../blue_modules/bhwi';
import { network } from '../../models/bitcoinNetwork';
import { Chain } from '../../models/bitcoinUnits';
import NetworkTransactionFees from '../../models/networkTransactionFees';
import { CommonToolTipActions } from '../../typings/CommonToolTipActions';
import SendDetails from '../../screen/send/SendDetails';

bitcoin.initEccLib(ecc);
const bip32 = BIP32Factory(ecc);
const phoneMnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const multisigPath = MultisigHDWallet.PATH_NATIVE_SEGWIT;

const mockWallets: TWallet[] = [];
let mockRouteParams: { walletID: string; isEditable?: boolean; onBarScanned?: string };
let mockMenuOptions: { actions: Array<Array<{ id: string; hidden?: boolean }>>; onPressMenuItem: (id: string) => void };
const mockNavigate = jest.fn();
const mockSetParams = jest.fn();
const mockSetOptions = jest.fn();
const mockGoBack = jest.fn(async () => undefined);
const mockNavigation = { navigate: mockNavigate, setParams: mockSetParams, setOptions: mockSetOptions, goBack: mockGoBack };

jest.mock('@react-navigation/native', () => {
  const ReactModule = require('react');
  const actual = jest.requireActual('@react-navigation/native');
  return {
    ...actual,
    useNavigation: () => mockNavigation,
    useRoute: () => ({ params: mockRouteParams }),
    useLocale: () => ({ direction: 'ltr' }),
    useFocusEffect: (callback: () => void | (() => void)) => ReactModule.useEffect(callback, [callback]),
  };
});
jest.mock('../../hooks/context/useStorage', () => ({
  useStorage: () => ({
    wallets: mockWallets,
    sleep: async () => undefined,
    txMetadata: {},
    saveToDisk: async () => true,
  }),
}));
jest.mock('../../hooks/useKeyboard', () => ({ useKeyboard: () => ({ isVisible: false }) }));
jest.mock('../../components/headerMenuOptions', () => ({
  createEllipsisHeaderMenuOptions: (options: typeof mockMenuOptions) => {
    mockMenuOptions = options;
    return { headerRight: () => null, unstable_headerRightItems: () => [] };
  },
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
}));
jest.mock('../../models/networkTransactionFees', () => {
  class MockFees {
    static StorageKey = 'fees';
    static recommendedFees = jest.fn(async () => ({ fastestFee: 3, mediumFee: 2, slowFee: 1 }));
    fastestFee: number;
    mediumFee: number;
    slowFee: number;
    constructor(fastestFee: number, mediumFee: number, slowFee: number) {
      this.fastestFee = fastestFee;
      this.mediumFee = mediumFee;
      this.slowFee = slowFee;
    }
  }
  return { __esModule: true, default: MockFees, NetworkTransactionFee: MockFees, NetworkTransactionFeeType: {} };
});
jest.mock('../../components/themes', () => ({ useTheme: () => ({ colors: new Proxy({}, { get: () => '#111' }) }) }));
jest.mock('../../components/SafeArea', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  return { __esModule: true, default: ({ children }: { children: React.ReactNode }) => ReactModule.createElement(View, null, children) };
});
jest.mock('../../components/AddressInput', () => 'AddressInput');
jest.mock('../../components/AmountInput', () => ({ AmountInput: 'AmountInput', getCachedSatoshis: () => 0 }));
jest.mock('../../components/Button', () => 'Button');
jest.mock('../../components/CoinsSelected', () => 'CoinsSelected');
jest.mock('../../components/Icon', () => 'Icon');
jest.mock('../../components/InputAccessoryAllFunds', () => ({
  __esModule: true,
  default: 'InputAccessoryAllFunds',
  InputAccessoryAllFundsAccessoryViewID: 'all-funds',
}));
jest.mock('../../components/DismissKeyboardInputAccessory', () => ({
  DismissKeyboardInputAccessory: 'DismissKeyboardInputAccessory',
  DismissKeyboardInputAccessoryViewID: 'dismiss',
}));
jest.mock('../../components/BlueText', () => 'BlueText');
jest.mock('../../blue_modules/currency', () => ({
  btcToSatoshi: (value: number | string) => Number(value) * 100_000_000,
  satoshiToBTC: (value: number) => String(value / 100_000_000),
  satoshiToLocalCurrency: (value: number) => String(value),
  fiatToBTC: (value: number) => value,
}));
jest.mock('../../blue_modules/hapticFeedback', () => ({
  __esModule: true,
  default: jest.fn(),
  HapticFeedbackTypes: { NotificationError: 'error' },
}));
jest.mock('../../screen/ActionSheet', () => ({ showActionSheetWithOptions: jest.fn() }));

function required<Value>(value: Value | null | undefined): Value {
  if (value === null || value === undefined) throw new Error('Missing fixture value');
  return value;
}

function makePsbt(): bitcoin.Psbt {
  const parent = new bitcoin.Transaction();
  parent.addInput(new Uint8Array(32), 0xffffffff);
  const inputScript = bitcoin.script.compile([bitcoin.opcodes.OP_TRUE]);
  parent.addOutput(inputScript, 10_000n);
  const psbt = new bitcoin.Psbt({ network });
  psbt.addInput({
    hash: parent.getId(),
    index: 0,
    nonWitnessUtxo: parent.toBuffer(),
    witnessUtxo: { script: inputScript, value: 10_000n },
  });
  psbt.addOutput({ script: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN]), value: 9_000n });
  return psbt;
}

function makeAssociatedSinglesig(): WatchOnlyWallet {
  const path = network === bitcoin.networks.bitcoin ? "m/84'/0'/0'" : "m/84'/1'/0'";
  const root = bip32.fromSeed(
    Uint8Array.from({ length: 32 }, (_unused, index) => index + 31),
    network,
  );
  const account = root.derivePath(path);
  const fingerprint = Buffer.from(root.fingerprint).toString('hex');
  const association: HardwareWalletAssociation = {
    family: 'ledger',
    fingerprint,
    path,
    xpub: account.neutered().toBase58(),
    format: 'native-segwit',
  };
  const wallet = new WatchOnlyWallet();
  wallet.setSecret(convertExtendedKey(association.xpub, 'native')).init();
  wallet.setDerivationPath(path);
  wallet.setMasterFingerprintFromHex(fingerprint);
  wallet.setHardwareWalletAssociation(association);
  jest.spyOn(wallet, 'fetchUtxo').mockImplementation(async () => undefined);
  return wallet;
}

function makeHardwareMultisig(withPhone: boolean): MultisigHDWallet {
  const hardwareRoot = bip32.fromSeed(
    Uint8Array.from({ length: 32 }, (_unused, index) => index + 71),
    network,
  );
  const hardwareAccount = hardwareRoot.derivePath(multisigPath);
  const hardware: HardwareWalletAssociation = {
    family: 'ledger',
    fingerprint: Buffer.from(hardwareRoot.fingerprint).toString('hex'),
    path: multisigPath,
    xpub: hardwareAccount.neutered().toBase58(),
    format: 'multisig-native',
  };
  const wallet = new MultisigHDWallet();
  wallet.setM(2);
  wallet.setDerivationPath(multisigPath);
  if (withPhone) {
    wallet.addCosigner(phoneMnemonic, undefined, multisigPath);
  } else {
    const other = bip32
      .fromSeed(
        Uint8Array.from({ length: 32 }, () => 121),
        network,
      )
      .derivePath(multisigPath);
    wallet.addCosigner(other.neutered().toBase58(), Buffer.from(other.fingerprint).toString('hex'), multisigPath);
  }
  wallet.addCosigner(hardware.xpub, hardware.fingerprint, multisigPath);
  wallet.addHardwareWalletAssociation(hardware);
  jest.spyOn(wallet, 'fetchUtxo').mockImplementation(async () => undefined);
  return wallet;
}

function makeSoftwareWallet(): HDSegwitBech32Wallet {
  const wallet = new HDSegwitBech32Wallet();
  wallet.setSecret(phoneMnemonic);
  jest.spyOn(wallet, 'fetchUtxo').mockImplementation(async () => undefined);
  jest.spyOn(wallet, 'cosignPsbt').mockReturnValue({ tx: { toHex: () => '02000000000000000000' } as bitcoin.Transaction });
  wallet.next_free_change_address_index = 0;
  wallet.gap_limit = 0;
  return wallet;
}

async function renderWallet(wallet: TWallet): Promise<RenderAPI> {
  if (wallet.chain !== Chain.ONCHAIN || !wallet.allowSend()) throw new Error('Fixture wallet is not send-capable');
  mockWallets.splice(0, mockWallets.length, wallet);
  mockRouteParams = { walletID: wallet.getID(), isEditable: true };
  const view = render(<SendDetails />);
  expect(mockWallets).toContain(wallet);
  expect(mockGoBack).not.toHaveBeenCalled();
  await waitFor(() => expect(mockSetOptions).toHaveBeenCalled());
  return view;
}

function signAction(): { id: string; hidden?: boolean } {
  return required(mockMenuOptions.actions.flat().find(action => action.id === CommonToolTipActions.SignPSBT.id));
}

async function returnImportedPsbt(view: RenderAPI, psbt: bitcoin.Psbt, expectedDestination?: string): Promise<void> {
  mockMenuOptions.onPressMenuItem(CommonToolTipActions.SignPSBT.id);
  await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('ScanQRCode', expect.objectContaining({ showFileImportButton: true })));
  mockRouteParams = { ...mockRouteParams, isEditable: !mockRouteParams.isEditable };
  view.rerender(<SendDetails />);
  mockNavigate.mockClear();
  mockSetParams.mockClear();
  mockRouteParams = { ...mockRouteParams, onBarScanned: psbt.toBase64() };
  view.rerender(<SendDetails />);
  await waitFor(() => expect(mockSetParams).toHaveBeenCalledWith(expect.objectContaining({ onBarScanned: undefined })));
  if (expectedDestination) {
    await waitFor(() => expect(mockNavigate.mock.calls.some(([screen]) => screen === expectedDestination)).toBe(true));
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGoBack.mockResolvedValue(undefined);
  jest.mocked(AsyncStorage.getItem).mockResolvedValue(null);
  jest.mocked(AsyncStorage.setItem).mockResolvedValue(undefined);
  jest.mocked(NetworkTransactionFees.recommendedFees).mockResolvedValue({ fastestFee: 3, mediumFee: 2, slowFee: 1 });
  mockSetParams.mockImplementation((params: Record<string, unknown>) => {
    if ('onBarScanned' in params) {
      mockRouteParams.onBarScanned = typeof params.onBarScanned === 'string' ? params.onBarScanned : undefined;
    }
  });
});

afterEach(() => jest.restoreAllMocks());

test('shows and binds imported signing for the selected associated singlesig wallet', async () => {
  const wallet = makeAssociatedSinglesig();
  const psbt = makePsbt();
  const view = await renderWallet(wallet);
  expect(signAction().hidden).toBe(false);
  await returnImportedPsbt(view, psbt, 'PsbtWithHardwareWallet');
  expect(mockNavigate).toHaveBeenCalledWith('PsbtWithHardwareWallet', {
    memo: undefined,
    walletID: wallet.getID(),
    psbt: expect.any(bitcoin.Psbt),
    bhwiBound: true,
  });
  const routedParams = mockNavigate.mock.calls.find(([screen]) => screen === 'PsbtWithHardwareWallet')?.[1] as unknown;
  if (!routedParams || typeof routedParams !== 'object' || !('psbt' in routedParams) || !(routedParams.psbt instanceof bitcoin.Psbt)) {
    throw new Error('Missing routed PSBT');
  }
  expect(routedParams.psbt.toBase64()).toBe(psbt.toBase64());
});

test('shows and binds imported signing for the selected phone plus hardware multisig wallet', async () => {
  const wallet = makeHardwareMultisig(true);
  const psbt = makePsbt();
  const view = await renderWallet(wallet);
  expect(signAction().hidden).toBe(false);
  await returnImportedPsbt(view, psbt, 'PsbtMultisig');
  expect(mockNavigate).toHaveBeenCalledWith('PsbtMultisig', {
    memo: undefined,
    walletID: wallet.getID(),
    psbtBase64: psbt.toBase64(),
    bhwiBound: true,
  });
});

test('does not offer imported hardware signing for an unrelated associated multisig policy', async () => {
  const wallet = makeHardwareMultisig(false);
  const view = await renderWallet(wallet);
  expect(signAction().hidden).toBe(true);
  await returnImportedPsbt(view, makePsbt());
  expect(mockNavigate.mock.calls.some(([screen]) => screen === 'PsbtWithHardwareWallet' || screen === 'PsbtMultisig')).toBe(false);
});

test('keeps the existing unassociated software imported-signing route', async () => {
  const wallet = makeSoftwareWallet();
  jest.spyOn(bitcoin.Psbt.prototype, 'getFee').mockReturnValue(1_000n);
  jest.spyOn(bitcoin.Psbt.prototype, 'getFeeRate').mockReturnValue(1);
  const view = await renderWallet(wallet);
  expect(signAction().hidden).toBe(false);
  await returnImportedPsbt(view, makePsbt(), 'CreateTransaction');
  expect(mockNavigate).toHaveBeenCalledWith('CreateTransaction', expect.objectContaining({ tx: '02000000000000000000' }));
  expect(mockNavigate.mock.calls.some(([screen]) => screen === 'PsbtWithHardwareWallet' || screen === 'PsbtMultisig')).toBe(false);
});
