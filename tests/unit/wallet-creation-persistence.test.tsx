import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import triggerHapticFeedback from '../../blue_modules/hapticFeedback';
import { HDSegwitBech32Wallet } from '../../class/wallets/hd-segwit-bech32-wallet';
import { MultisigHDWallet } from '../../class/wallets/multisig-hd-wallet';
import type { TWallet } from '../../class/wallets/types';
import WalletsAdd from '../../screen/wallets/Add';
import ImportCustomDerivationPath from '../../screen/wallets/ImportCustomDerivationPath';
import ImportSpeed from '../../screen/wallets/ImportSpeed';
import ImportWalletDiscovery from '../../screen/wallets/ImportWalletDiscovery';
import WalletsAddMultisigStep2 from '../../screen/wallets/addMultisigStep2';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
const mockParentGoBack = jest.fn();
const mockSetOptions = jest.fn();
const mockSetParams = jest.fn((updates: Record<string, unknown>) => Object.assign(mockRouteParams, updates));
let mockRouteParams: Record<string, unknown> = {};
const mockParentNavigation = { goBack: mockParentGoBack };
const mockNavigation = {
  navigate: mockNavigate,
  goBack: mockGoBack,
  getParent: () => mockParentNavigation,
  setOptions: mockSetOptions,
  setParams: mockSetParams,
};

const mockAddAndSaveWallet = jest.fn<Promise<boolean>, [TWallet]>();
const mockAddWallet = jest.fn<void, [TWallet]>();
const mockSaveToDisk = jest.fn<Promise<boolean>, []>();
const mockSleep = jest.fn(async () => undefined);
let mockDiscoveredWallet: TWallet;

jest.mock('@react-navigation/native', () => {
  const actual = jest.requireActual('@react-navigation/native');
  return {
    ...actual,
    useNavigation: () => mockNavigation,
    useRoute: () => ({ params: mockRouteParams }),
    useFocusEffect: (effect: () => void | (() => void)) => effect(),
    useLocale: () => ({ direction: 'ltr' }),
  };
});

jest.mock('../../hooks/context/useStorage', () => ({
  useStorage: () => ({
    addAndSaveWallet: mockAddAndSaveWallet,
    addWallet: mockAddWallet,
    saveToDisk: mockSaveToDisk,
    sleep: mockSleep,
    currentSharedCosigner: '',
    setSharedCosigner: jest.fn(),
  }),
}));

jest.mock('../../hooks/context/useSettings', () => ({
  useSettings: () => ({
    isElectrumDisabled: true,
    isPrivacyBlurEnabled: false,
  }),
}));

jest.mock('../../hooks/useScreenProtect', () => ({
  useScreenProtect: () => ({ enableScreenProtect: jest.fn(), disableScreenProtect: jest.fn() }),
}));

jest.mock('../../components/themes', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#000000' }) }),
}));

jest.mock('../../components/Alert', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../blue_modules/hapticFeedback', () => ({
  __esModule: true,
  default: jest.fn(),
  HapticFeedbackTypes: {
    ImpactLight: 'impactLight',
    NotificationError: 'notificationError',
    NotificationSuccess: 'notificationSuccess',
    Selection: 'selection',
  },
}));

jest.mock('../../helpers/lndHub', () => ({ getLNDHub: jest.fn().mockResolvedValue('') }));
jest.mock('../../helpers/scan-qr.ts', () => ({
  getScanWasBBQR: jest.fn(() => false),
  resetScanWasBBQR: jest.fn(),
}));
jest.mock('../../helpers/confirm', () => ({ __esModule: true, default: jest.fn().mockResolvedValue(false) }));
jest.mock('../../helpers/prompt', () => ({ __esModule: true, default: jest.fn() }));

jest.mock('../../class/wallet-import', () => {
  const actual = jest.requireActual('../../class/wallet-import');
  return {
    ...actual,
    __esModule: true,
    default: jest.fn((...args: unknown[]) => {
      const onWallet = args[4];
      return {
        stop: jest.fn(),
        promise: Promise.resolve().then(() => {
          if (typeof onWallet === 'function') onWallet(mockDiscoveredWallet);
          return { cancelled: false, wallets: [mockDiscoveredWallet] };
        }),
      };
    }),
  };
});

jest.mock('../../components/Button', () => {
  const ReactModule = require('react');
  const { Pressable, Text } = require('react-native');
  const MockButton = ({
    disabled,
    onPress,
    showActivityIndicator,
    testID,
    title,
  }: {
    disabled?: boolean;
    onPress?: () => void | Promise<void>;
    showActivityIndicator?: boolean;
    testID?: string;
    title?: string;
  }) =>
    ReactModule.createElement(
      Pressable,
      { disabled, onPress, testID: testID ?? `Button-${title}` },
      ReactModule.createElement(Text, null, showActivityIndicator ? 'Saving' : title),
    );
  return { __esModule: true, default: MockButton, Button: MockButton };
});

jest.mock('../../components/BlueButtonLink', () => {
  const ReactModule = require('react');
  const { Pressable, Text } = require('react-native');
  return ({ disabled, onPress, testID, title }: { disabled?: boolean; onPress?: () => void; testID?: string; title: string }) =>
    ReactModule.createElement(Pressable, { disabled, onPress, testID }, ReactModule.createElement(Text, null, title));
});

jest.mock('../../components/BlueFormMultiInput', () => {
  const ReactModule = require('react');
  const { TextInput } = require('react-native');
  return (props: { editable?: boolean; onChangeText: (text: string) => void; testID?: string; value: string }) =>
    ReactModule.createElement(TextInput, props);
});

jest.mock('../../components/WalletToImport', () => {
  const ReactModule = require('react');
  const { Pressable, Text } = require('react-native');
  return ({ onPress, title }: { onPress: () => void; title: string }) =>
    ReactModule.createElement(Pressable, { onPress, testID: 'WalletToImport' }, ReactModule.createElement(Text, null, title));
});

jest.mock('../../components/WalletButton', () => {
  const ReactModule = require('react');
  const { Pressable, Text } = require('react-native');
  return ({ buttonType, onPress, testID }: { buttonType: string; onPress: () => void; testID?: string }) =>
    ReactModule.createElement(Pressable, { onPress, testID }, ReactModule.createElement(Text, null, buttonType));
});

jest.mock('../../components/BlueFormLabel', () => 'BlueFormLabel');
jest.mock('../../components/BlueText', () => 'BlueText');
jest.mock('../../components/BlueTextCentered', () => 'BlueTextCentered');
jest.mock('../../components/SafeArea', () => 'SafeArea');
jest.mock('../../components/SafeAreaScrollView', () => 'SafeAreaScrollView');
jest.mock('../../components/Icon', () => 'Icon');
jest.mock('../../components/MultipleStepsListItem', () => ({
  __esModule: true,
  default: 'MultipleStepsListItem',
  MultipleStepsListItemButtonType: { Full: 'Full' },
  MultipleStepsListItemDashType: { Top: 'Top', TopAndBottom: 'TopAndBottom' },
}));
jest.mock('../../components/BlueSpacing', () => ({
  BlueSpacing10: 'BlueSpacing10',
  BlueSpacing20: 'BlueSpacing20',
  BlueSpacing40: 'BlueSpacing40',
}));

const expectSameRetry = () => {
  expect(mockAddAndSaveWallet).toHaveBeenCalledTimes(2);
  expect(mockAddAndSaveWallet.mock.calls[1][0]).toBe(mockAddAndSaveWallet.mock.calls[0][0]);
  expect(mockParentGoBack).toHaveBeenCalledTimes(1);
};

describe('wallet creation persistence gates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAddAndSaveWallet.mockReset().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mockSaveToDisk.mockReset();
    mockRouteParams = {};
    mockDiscoveredWallet = {
      type: 'discovered',
      typeReadable: 'Discovered wallet',
      getID: () => 'discovered-wallet',
      getDerivationPath: () => "m/84'/0'/0'",
    } as unknown as TWallet;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('keeps the generated Add wallet staged and reports success only after retry', async () => {
    const generate = jest.spyOn(HDSegwitBech32Wallet.prototype, 'generate').mockImplementation(async function (this: HDSegwitBech32Wallet) {
      this.setSecret(MNEMONIC);
    });
    mockSaveToDisk.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const view = render(<WalletsAdd />);
    const create = await view.findByTestId('Create');

    fireEvent.press(create);
    await waitFor(() => expect(mockSaveToDisk).toHaveBeenCalledTimes(1));
    expect(mockAddWallet).toHaveBeenCalledTimes(1);
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(triggerHapticFeedback).not.toHaveBeenCalled();
    expect(view.getByTestId('WalletNameInput').props.editable).toBe(false);

    fireEvent.press(view.getByTestId('Create'));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledTimes(1));

    expect(generate).toHaveBeenCalledTimes(1);
    expect(mockAddWallet).toHaveBeenCalledTimes(1);
    expect(mockAddWallet.mock.calls[0][0].getSecret()).toBe(MNEMONIC);
    expect(mockSaveToDisk).toHaveBeenCalledTimes(2);
    expect(triggerHapticFeedback).toHaveBeenCalledTimes(1);
  });

  it('keeps ImportSpeed input and wallet unchanged across a failed save and retry', async () => {
    jest.spyOn(HDSegwitBech32Wallet.prototype, 'fetchBalance').mockResolvedValue(undefined);
    const view = render(<ImportSpeed />);
    fireEvent.changeText(view.getByTestId('SpeedMnemonicInput'), MNEMONIC);
    fireEvent.changeText(view.getByTestId('SpeedWalletTypeInput'), HDSegwitBech32Wallet.type);

    fireEvent.press(view.getByTestId('SpeedDoImport'));
    await waitFor(() => expect(mockAddAndSaveWallet).toHaveBeenCalledTimes(1));
    expect(mockParentGoBack).not.toHaveBeenCalled();
    expect(view.getByTestId('SpeedMnemonicInput').props.editable).toBe(false);

    fireEvent.press(view.getByTestId('SpeedDoImport'));
    await waitFor(expectSameRetry);
    expect(mockAddAndSaveWallet.mock.calls[0][0].getSecret()).toBe(MNEMONIC);
  });

  it('keeps the custom-derivation wallet and path locked until the same wallet saves', async () => {
    jest.useFakeTimers();
    mockRouteParams = { importText: MNEMONIC };
    const view = render(<ImportCustomDerivationPath />);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(500);
    });
    await waitFor(() => expect(view.getAllByTestId('WalletToImport').length).toBeGreaterThan(0));
    fireEvent.press(view.getAllByTestId('WalletToImport')[0]);

    fireEvent.press(view.getByTestId('ImportButton'));
    await waitFor(() => expect(mockAddAndSaveWallet).toHaveBeenCalledTimes(1));
    expect(mockParentGoBack).not.toHaveBeenCalled();
    expect(view.getByTestId('DerivationPathInput').props.editable).toBe(false);

    fireEvent.press(view.getByTestId('ImportButton'));
    await waitFor(expectSameRetry);
  });

  it('keeps the discovered wallet selected until retry succeeds', async () => {
    mockRouteParams = { importText: MNEMONIC, askPassphrase: false, searchAccounts: false };
    const view = render(<ImportWalletDiscovery />);

    await waitFor(() => expect(mockAddAndSaveWallet).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockParentGoBack).not.toHaveBeenCalled();
    expect(view.getByTestId('CustomDerivationPathButton').props.accessibilityState?.disabled ?? true).toBe(true);
    await waitFor(() => {
      const retry = view.getByTestId('Button-Import');
      expect(retry.props.accessibilityState?.disabled ?? retry.props.disabled ?? false).toBe(false);
    });
    fireEvent.press(view.getByTestId('Button-Import'));
    await waitFor(expectSameRetry);
  });

  it('reuses the protected multisig draft after persistence fails', async () => {
    mockRouteParams = {
      m: 1,
      n: 1,
      format: MultisigHDWallet.FORMAT_P2WSH,
      walletLabel: 'Vault',
      sheetAction: 'importMnemonic',
      sheetImportText: MNEMONIC,
      sheetAskPassphrase: false,
    };
    const view = render(<WalletsAddMultisigStep2 />);
    await view.findByTestId('CreateButton');
    await waitFor(() => {
      const create = view.getByTestId('CreateButton');
      expect(create.props.accessibilityState?.disabled ?? create.props.disabled ?? false).toBe(false);
    });
    fireEvent.press(view.getByTestId('CreateButton'));
    await waitFor(() => expect(mockAddAndSaveWallet).toHaveBeenCalledTimes(1));
    expect(mockParentGoBack).not.toHaveBeenCalled();
    expect(triggerHapticFeedback).not.toHaveBeenCalled();

    fireEvent.press(view.getByTestId('CreateButton'));
    await waitFor(expectSameRetry);
    expect((mockAddAndSaveWallet.mock.calls[0][0] as MultisigHDWallet).getCosigner(1)).toBe(MNEMONIC);
  });
});
