import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { RenderAPI } from '@testing-library/react-native';
import { AppState } from 'react-native';
import type { AppStateStatus } from 'react-native';
import BIP32Factory from 'bip32';
import type { BIP32Interface } from 'bip32';
import * as bitcoin from 'bitcoinjs-lib';
import { Buffer } from 'buffer';

import ecc from '../../blue_modules/noble_ecc';
import { MultisigHDWallet } from '../../class/wallets/multisig-hd-wallet';
import type { HardwareWalletAssociation } from '../../blue_modules/bhwi';
import { network } from '../../models/bitcoinNetwork';
import PsbtMultisig from '../../screen/send/psbtMultisig';

bitcoin.initEccLib(ecc);
const bip32 = BIP32Factory(ecc);
const path = MultisigHDWallet.PATH_NATIVE_SEGWIT;
const phoneMnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

type MockRouteParams = {
  walletID: string;
  psbtBase64: string;
  bhwiBound: boolean;
  bhwiReturnedBase64?: string;
  bhwiAttempt?: number;
  receivedPSBTBase64?: string;
  multisigContinuation?: string;
  onBarScannedFromPicker?: boolean;
};

let mockRouteParams: MockRouteParams;
let mockWallets: MultisigHDWallet[] = [];
let mockIsFocused = true;
let mockAppStateChange: (state: AppStateStatus) => void = () => undefined;
const mockNavigate = jest.fn();
const mockDispatch = jest.fn();
const mockSetParams = jest.fn();
const mockPresentAlert = jest.fn();
const mockEnableScreenProtect = jest.fn();
const mockDisableScreenProtect = jest.fn();
const mockNavigation = { navigate: mockNavigate, dispatch: mockDispatch, setParams: mockSetParams };

jest.mock('@react-navigation/native', () => {
  const actual = jest.requireActual('@react-navigation/native');
  return {
    ...actual,
    useNavigation: () => mockNavigation,
    useRoute: () => ({ params: mockRouteParams }),
    useIsFocused: () => mockIsFocused,
  };
});
jest.mock('../../hooks/context/useStorage', () => ({ useStorage: () => ({ wallets: mockWallets }) }));
jest.mock('../../hooks/context/useSettings', () => ({ useSettings: () => ({ isElectrumDisabled: false }) }));
jest.mock('../../hooks/useScreenProtect', () => ({
  useScreenProtect: () => ({ enableScreenProtect: mockEnableScreenProtect, disableScreenProtect: mockDisableScreenProtect }),
}));
jest.mock('../../blue_modules/bhwi', () => {
  const actual = jest.requireActual('../../blue_modules/bhwi');
  return { ...actual, isBhwiAvailable: () => true };
});
jest.mock('../../components/Alert', () => ({ __esModule: true, default: (...args: unknown[]) => mockPresentAlert(...args) }));
jest.mock('../../blue_modules/currency', () => ({
  satoshiToBTC: (value: number) => String(value),
  satoshiToLocalCurrency: (value: number) => String(value),
}));
jest.mock('../../components/themes', () => ({
  useTheme: () => ({
    colors: {
      elevated: '#fff',
      buttonAlternativeTextColor: '#111',
      alternativeTextColor: '#222',
      buttonDisabledBackgroundColor: '#ccc',
      buttonTextColor: '#000',
      msSuccessBG: '#0a0',
      alternativeTextColor2: '#333',
    },
  }),
}));
jest.mock('../../components/SafeArea', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  return { __esModule: true, default: ({ children }: { children: React.ReactNode }) => ReactModule.createElement(View, null, children) };
});
jest.mock('../../components/BlueCard', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  return { __esModule: true, default: ({ children }: { children: React.ReactNode }) => ReactModule.createElement(View, null, children) };
});
jest.mock('../../components/Icon', () => 'Icon');
jest.mock('../../components/Button', () => {
  const ReactModule = require('react');
  const { Pressable, Text } = require('react-native');
  return {
    __esModule: true,
    default: ({ disabled, onPress, testID, title }: { disabled?: boolean; onPress?: () => void; testID?: string; title: string }) =>
      ReactModule.createElement(Pressable, { disabled, onPress, testID }, ReactModule.createElement(Text, null, title)),
  };
});

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

type Fixture = {
  wallet: MultisigHDWallet;
  psbt: bitcoin.Psbt;
  hardwareChildren: BIP32Interface[];
};

function makeFixture(inputCount = 2): Fixture {
  const hardwareRoot = bip32.fromSeed(
    Uint8Array.from({ length: 32 }, (_unused, index) => index + 51),
    network,
  );
  const hardwareAccount = hardwareRoot.derivePath(path);
  const association: HardwareWalletAssociation = {
    family: 'ledger',
    fingerprint: Buffer.from(hardwareRoot.fingerprint).toString('hex'),
    path,
    xpub: hardwareAccount.neutered().toBase58(),
    format: 'multisig-native',
  };
  const wallet = new MultisigHDWallet();
  wallet.setM(2);
  wallet.setDerivationPath(path);
  wallet.addCosigner(phoneMnemonic, undefined, path);
  wallet.addCosigner(association.xpub, association.fingerprint, path);
  wallet.addHardwareWalletAssociation(association);
  const [phone] = wallet.getPublicCosigners();
  const phoneAccount = bip32.fromBase58(required(phone).xpub, network);
  const psbt = new bitcoin.Psbt({ network });
  const hardwareChildren: BIP32Interface[] = [];
  for (let index = 0; index < inputCount; index++) {
    const phoneChild = phoneAccount.derive(0).derive(index);
    const hardwareChild = hardwareAccount.derive(0).derive(index);
    const pubkeys = [phoneChild.publicKey, hardwareChild.publicKey].sort((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)),
    );
    const witnessScript = required(bitcoin.payments.p2ms({ m: 2, pubkeys, network }).output);
    const output = required(bitcoin.payments.p2wsh({ redeem: { output: witnessScript }, network }).output);
    const parent = makeParent(output, 100_000n, index + 1);
    psbt.addInput({
      hash: parent.getId(),
      index: 0,
      nonWitnessUtxo: parent.toBuffer(),
      witnessUtxo: { script: output, value: 100_000n },
      witnessScript,
      bip32Derivation: [
        {
          masterFingerprint: Buffer.from(required(phone).fingerprint, 'hex'),
          path: `${path}/0/${index}`,
          pubkey: phoneChild.publicKey,
        },
        {
          masterFingerprint: Buffer.from(association.fingerprint, 'hex'),
          path: `${path}/0/${index}`,
          pubkey: hardwareChild.publicKey,
        },
      ],
    });
    hardwareChildren.push(hardwareChild);
  }
  const destinationRoot = bip32.fromSeed(
    Uint8Array.from({ length: 32 }, () => 201),
    network,
  );
  const destination = required(bitcoin.payments.p2wpkh({ pubkey: destinationRoot.derive(0).publicKey, network }).output);
  psbt.addOutput({ script: destination, value: BigInt(inputCount) * 100_000n - 1_000n });
  return { wallet, psbt, hardwareChildren };
}

function setFixture(fixture: Fixture): void {
  mockWallets = [fixture.wallet];
  mockRouteParams = {
    walletID: fixture.wallet.getID(),
    psbtBase64: fixture.psbt.toBase64(),
    bhwiBound: true,
  };
}

function lastNavigation(screen: string): Record<string, unknown> {
  const call = [...mockNavigate.mock.calls].reverse().find(([name]) => name === screen);
  const params = required(call)[1] as unknown;
  if (!params || typeof params !== 'object') throw new Error(`Missing ${screen} navigation`);
  return params as Record<string, unknown>;
}

function hardwareNavigation(): { originalBase64: string; attempt: number } {
  const params = lastNavigation('HardwareWalletAccount');
  if (typeof params.originalBase64 !== 'string' || typeof params.attempt !== 'number') throw new Error('Invalid hardware navigation');
  return { originalBase64: params.originalBase64, attempt: params.attempt };
}

function qrNavigation(): { psbtBase64: string; multisigContinuation: string } {
  const params = lastNavigation('PsbtMultisigQRCode');
  if (typeof params.psbtBase64 !== 'string' || typeof params.multisigContinuation !== 'string') throw new Error('Invalid QR navigation');
  return { psbtBase64: params.psbtBase64, multisigContinuation: params.multisigContinuation };
}

function confirmedPsbt(): bitcoin.Psbt {
  const psbt = lastNavigation('Confirm').psbt;
  if (!(psbt instanceof bitcoin.Psbt)) throw new Error('Missing confirmed PSBT');
  return psbt;
}

function signHardware(base64: string, fixture: Fixture, indexes = fixture.hardwareChildren.map((_child, index) => index)): bitcoin.Psbt {
  const returned = bitcoin.Psbt.fromBase64(base64, { network });
  for (const index of indexes) {
    const child = required(fixture.hardwareChildren[index]);
    const alreadySigned = returned.data.inputs[index]?.partialSig?.some(signature =>
      Buffer.from(signature.pubkey).equals(Buffer.from(child.publicKey)),
    );
    if (!alreadySigned) returned.signInput(index, child);
  }
  return returned;
}

function expectConfirmDisabled(view: RenderAPI): void {
  const button = view.getByTestId('PsbtMultisigConfirmButton');
  expect(button.props.accessibilityState?.disabled ?? button.props.disabled ?? false).toBe(true);
}

async function pressAndSettle(view: RenderAPI, testID: string): Promise<void> {
  await act(async () => {
    fireEvent.press(view.getByTestId(testID));
    await Promise.resolve();
  });
}

async function pressEnabled(view: RenderAPI, testID: string): Promise<void> {
  const button = view.getByTestId(testID);
  await waitFor(() => expect(button.props.accessibilityState?.disabled ?? button.props.disabled ?? false).toBe(false));
  await pressAndSettle(view, testID);
}

async function rerenderSettled(view: RenderAPI): Promise<void> {
  await act(async () => {
    view.rerender(<PsbtMultisig />);
    await Promise.resolve();
  });
}

async function changeAppState(state: AppStateStatus): Promise<void> {
  await act(async () => {
    mockAppStateChange(state);
    await Promise.resolve();
  });
}
beforeEach(() => {
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active', writable: true });
  jest.clearAllMocks();
  mockIsFocused = true;
  mockSetParams.mockImplementation((params: Record<string, unknown>) => {
    Object.assign(mockRouteParams, params);
  });

  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
    mockAppStateChange = listener as (state: AppStateStatus) => void;
    return { remove: jest.fn() };
  });
});

afterEach(() => jest.restoreAllMocks());

test('preserves the phone signature through the strict hardware return and enables Confirm only when complete', async () => {
  const fixture = makeFixture();
  setFixture(fixture);
  const view = render(<PsbtMultisig />);
  expectConfirmDisabled(view);
  await pressEnabled(view, 'PsbtMultisigSignWithPhone');
  await waitFor(() => expect(view.getAllByTestId('ItemSigned')).toHaveLength(1));
  await pressEnabled(view, 'PsbtMultisigSignWithHardware');
  await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('HardwareWalletAccount', expect.any(Object)));
  const request = hardwareNavigation();
  const phonePartial = bitcoin.Psbt.fromBase64(request.originalBase64, { network });
  const phoneSignature = required(required(phonePartial.data.inputs[0]?.partialSig)[0]).signature;
  expect(phonePartial.data.inputs.every(input => input.partialSig?.length === 1)).toBe(true);
  const returned = signHardware(request.originalBase64, fixture);
  mockRouteParams = { ...mockRouteParams, bhwiReturnedBase64: returned.toBase64(), bhwiAttempt: request.attempt };
  await rerenderSettled(view);
  const confirm = view.getByTestId('PsbtMultisigConfirmButton');
  await waitFor(() => expect(confirm.props.accessibilityState?.disabled ?? confirm.props.disabled ?? false).toBe(false));
  await pressAndSettle(view, 'PsbtMultisigConfirmButton');
  const confirmed = confirmedPsbt();
  expect(Buffer.from(required(confirmed.data.inputs[0]?.finalScriptWitness)).includes(Buffer.from(phoneSignature))).toBe(true);
});

test('keeps an incomplete hardware result exportable, retries that actor, and preserves it through phone completion', async () => {
  const fixture = makeFixture();
  setFixture(fixture);
  const view = render(<PsbtMultisig />);
  await pressEnabled(view, 'PsbtMultisigSignWithHardware');
  await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('HardwareWalletAccount', expect.any(Object)));
  const firstRequest = hardwareNavigation();
  const firstReturn = signHardware(firstRequest.originalBase64, fixture, [0]);
  const hardwareSignature = required(required(firstReturn.data.inputs[0]?.partialSig)[0]).signature;
  mockRouteParams = { ...mockRouteParams, bhwiReturnedBase64: firstReturn.toBase64(), bhwiAttempt: firstRequest.attempt };
  await rerenderSettled(view);
  await view.findByTestId('PsbtMultisigSignWithHardware');
  expectConfirmDisabled(view);
  await pressAndSettle(view, 'ProvideSignature');
  const exported = bitcoin.Psbt.fromBase64(qrNavigation().psbtBase64, { network });
  expect(exported.data.inputs[0]?.partialSig).toHaveLength(1);
  expect(exported.data.inputs[1]?.partialSig).toBeUndefined();

  mockNavigate.mockClear();
  await pressEnabled(view, 'PsbtMultisigSignWithHardware');
  await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('HardwareWalletAccount', expect.any(Object)));
  const retryRequest = hardwareNavigation();
  const completeHardware = signHardware(retryRequest.originalBase64, fixture);
  mockRouteParams = { ...mockRouteParams, bhwiReturnedBase64: completeHardware.toBase64(), bhwiAttempt: retryRequest.attempt };
  await rerenderSettled(view);
  await view.findByTestId('PsbtMultisigSignWithPhone');
  await pressEnabled(view, 'PsbtMultisigSignWithPhone');
  const confirm = view.getByTestId('PsbtMultisigConfirmButton');
  await waitFor(() => expect(confirm.props.accessibilityState?.disabled ?? confirm.props.disabled ?? false).toBe(false));
  await pressAndSettle(view, 'PsbtMultisigConfirmButton');
  const confirmed = confirmedPsbt();
  expect(Buffer.from(required(confirmed.data.inputs[0]?.finalScriptWitness)).includes(Buffer.from(hardwareSignature))).toBe(true);
});

test('stages a scanner picker result after resume, re-reviews it, and rejects alteration before Confirm', async () => {
  const fixture = makeFixture();
  setFixture(fixture);
  const view = render(<PsbtMultisig />);
  await pressAndSettle(view, 'ProvideSignature');
  const qr = qrNavigation();
  mockIsFocused = false;
  await rerenderSettled(view);
  const altered = bitcoin.Psbt.fromBase64(qr.psbtBase64, { network });
  altered.setLocktime(1);
  for (const [index, child] of fixture.hardwareChildren.entries()) altered.signInput(index, child);
  await changeAppState('background');
  mockRouteParams = {
    ...mockRouteParams,
    receivedPSBTBase64: altered.toBase64(),
    multisigContinuation: qr.multisigContinuation,
    onBarScannedFromPicker: true,
  };
  mockIsFocused = true;
  await rerenderSettled(view);
  expect(view.queryByTestId('PsbtMultisigVerifyStagedFile')).toBeNull();
  await changeAppState('active');
  await view.findByTestId('PsbtMultisigVerifyStagedFile');
  expectConfirmDisabled(view);
  await pressAndSettle(view, 'PsbtMultisigVerifyStagedFile');
  await waitFor(() =>
    expect(view.getByTestId('PsbtMultisigHardwareStatus').props.children).toBe('Hardware wallet changed the transaction'),
  );
  expectConfirmDisabled(view);
});

test('accepts a valid staged scanner picker result only after explicit confirmation and clears it on another background', async () => {
  const fixture = makeFixture();
  setFixture(fixture);
  const view = render(<PsbtMultisig />);
  await pressAndSettle(view, 'ProvideSignature');
  const qr = qrNavigation();
  mockIsFocused = false;
  await rerenderSettled(view);
  const returned = signHardware(qr.psbtBase64, fixture);
  await changeAppState('background');
  mockRouteParams = {
    ...mockRouteParams,
    receivedPSBTBase64: returned.toBase64(),
    multisigContinuation: qr.multisigContinuation,
    onBarScannedFromPicker: true,
  };
  mockIsFocused = true;
  await rerenderSettled(view);
  await changeAppState('active');
  await view.findByTestId('PsbtMultisigVerifyStagedFile');
  expectConfirmDisabled(view);
  await changeAppState('background');
  expect(view.queryByTestId('PsbtMultisigVerifyStagedFile')).toBeNull();

  await changeAppState('active');
  mockRouteParams = {
    ...mockRouteParams,
    receivedPSBTBase64: returned.toBase64(),
    onBarScannedFromPicker: true,
  };
  await rerenderSettled(view);
  await view.findByTestId('PsbtMultisigVerifyStagedFile');
  await pressAndSettle(view, 'PsbtMultisigVerifyStagedFile');
  await view.findByTestId('PsbtMultisigSignWithPhone');
  expectConfirmDisabled(view);
});
