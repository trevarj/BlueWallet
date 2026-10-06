import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import triggerHapticFeedback from '../../blue_modules/hapticFeedback';
import { getBhwiHardwareMobilePolicy } from '../../blue_modules/bhwiPsbt';
import { HDSegwitBech32Wallet } from '../../class/wallets/hd-segwit-bech32-wallet';
import { MultisigHDWallet } from '../../class/wallets/multisig-hd-wallet';
import { convertExtendedKey } from '../../class/wallets/extended-key';
import type { TWallet } from '../../class/wallets/types';
import WalletsAdd from '../../screen/wallets/Add';
import ImportCustomDerivationPath from '../../screen/wallets/ImportCustomDerivationPath';
import ImportSpeed from '../../screen/wallets/ImportSpeed';
import ImportWalletDiscovery from '../../screen/wallets/ImportWalletDiscovery';
import WalletsAddMultisigStep2 from '../../screen/wallets/addMultisigStep2';
import WalletsAddMultisig from '../../screen/wallets/WalletsAddMultisig';
import WalletsAddMultisigVaultKeySheet from '../../screen/wallets/WalletsAddMultisigVaultKeySheet';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
const mockParentGoBack = jest.fn();
const mockSetOptions = jest.fn();
const mockDispatch = jest.fn();
const mockEnableScreenProtect = jest.fn(async () => undefined);
const mockDisableScreenProtect = jest.fn(async () => undefined);
const mockSetParams = jest.fn((updates: Record<string, unknown>) => Object.assign(mockRouteParams, updates));
let mockRouteParams: Record<string, unknown> = {};
let mockFocusCleanup: void | (() => void);
let mockIsElectrumDisabled = true;
const mockParentNavigation = { goBack: mockParentGoBack };
const mockNavigation = {
  navigate: mockNavigate,
  goBack: mockGoBack,
  getParent: () => mockParentNavigation,
  setOptions: mockSetOptions,
  setParams: mockSetParams,
  dispatch: mockDispatch,
};

const mockAddAndSaveWallet = jest.fn<Promise<boolean>, [TWallet]>();
const mockAddWallet = jest.fn<void, [TWallet]>();
const mockSaveToDisk = jest.fn<Promise<boolean>, []>();
const mockSleep = jest.fn<Promise<void>, []>(async () => undefined);
let mockDiscoveredWallet: TWallet;

jest.mock('@react-navigation/native', () => {
  const actual = jest.requireActual('@react-navigation/native');
  return {
    ...actual,
    useNavigation: () => mockNavigation,
    useRoute: () => ({ params: mockRouteParams }),
    useFocusEffect: (effect: () => void | (() => void)) => {
      mockFocusCleanup = effect();
    },
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
    isElectrumDisabled: mockIsElectrumDisabled,
    isPrivacyBlurEnabled: false,
  }),
}));

jest.mock('../../hooks/useScreenProtect', () => ({
  useScreenProtect: () => ({ enableScreenProtect: mockEnableScreenProtect, disableScreenProtect: mockDisableScreenProtect }),
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
jest.mock('../../components/MultipleStepsListItem', () => {
  const ReactModule = require('react');
  const { Pressable, Text } = require('react-native');
  return {
    __esModule: true,
    default: ({ button }: { button?: { disabled?: boolean; onPress?: () => void; testID?: string; text?: string } }) =>
      button
        ? ReactModule.createElement(
            Pressable,
            { disabled: button.disabled, onPress: button.onPress, testID: button.testID },
            ReactModule.createElement(Text, null, button.text),
          )
        : null,
    MultipleStepsListItemButtonType: { Full: 'Full' },
    MultipleStepsListItemDashType: { Top: 'Top', TopAndBottom: 'TopAndBottom' },
  };
});
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
    mockFocusCleanup = undefined;
    mockIsElectrumDisabled = true;
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
  it('opens the dedicated 2-of-2 native hardware and phone route without changing generic defaults', () => {
    mockRouteParams = { walletLabel: 'Dedicated vault' };
    const view = render(<WalletsAddMultisig />);
    fireEvent.press(view.getByTestId('VaultHardwareAndMobile'));
    expect(mockNavigate).toHaveBeenCalledWith('WalletsAddMultisigStep2', {
      m: 2,
      n: 2,
      format: MultisigHDWallet.FORMAT_P2WSH,
      walletLabel: 'Dedicated vault',
      hardwareAndMobile: true,
    });
  });

  it('opens the shared hardware account route only for supported BIP48 vault formats', async () => {
    mockRouteParams = { m: 1, n: 1, format: MultisigHDWallet.FORMAT_P2WSH, walletLabel: 'Hardware vault' };
    const native = render(<WalletsAddMultisigStep2 />);
    fireEvent.press(await native.findByTestId('VaultHardwareCosigner1'));
    expect(mockNavigate).toHaveBeenCalledWith('HardwareWalletAccount', {
      mode: 'multisig-cosigner',
      format: 'multisig-native',
      returnTo: 'WalletsAddMultisigStep2',
    });
    native.unmount();

    mockNavigate.mockClear();
    mockRouteParams = { m: 1, n: 1, format: MultisigHDWallet.FORMAT_P2SH, walletLabel: 'Legacy vault' };
    const legacy = render(<WalletsAddMultisigStep2 />);
    expect(legacy.queryByTestId('VaultHardwareCosigner1')).toBeNull();
  });

  it('returns a hardware account into the active multisig slot and persists its exact public binding', async () => {
    const hardwarePath = MultisigHDWallet.PATH_NATIVE_SEGWIT;
    const hardwareXpub = convertExtendedKey(MultisigHDWallet.seedToXpub(MNEMONIC, hardwarePath), 'legacy');
    const hardwareAccount = {
      family: 'ledger' as const,
      fingerprint: 'd34db33f',
      path: hardwarePath,
      xpub: hardwareXpub,
      format: 'multisig-native' as const,
    };
    mockRouteParams = {
      m: 1,
      n: 1,
      format: MultisigHDWallet.FORMAT_P2WSH,
      walletLabel: 'Hardware vault',
      hardwareAccount,
    };
    const view = render(<WalletsAddMultisigStep2 />);
    await waitFor(() => {
      const create = view.getByTestId('CreateButton');
      expect(create.props.accessibilityState?.disabled ?? create.props.disabled ?? false).toBe(false);
    });

    fireEvent.press(view.getByTestId('CreateButton'));
    await waitFor(() => expect(mockAddAndSaveWallet).toHaveBeenCalledTimes(1));
    const staged = mockAddAndSaveWallet.mock.calls[0][0] as MultisigHDWallet;
    expect(staged.getHardwareWalletAssociations()).toEqual([hardwareAccount]);

    fireEvent.press(view.getByTestId('CreateButton'));
    await waitFor(expectSameRetry);
    expect(mockAddAndSaveWallet.mock.calls[1][0]).toBe(staged);
  });

  it('creates only the acknowledged BIP48 phone plus hardware vault and retries the exact phone seed', async () => {
    const generate = jest.spyOn(HDSegwitBech32Wallet.prototype, 'generate').mockImplementation(async function (this: HDSegwitBech32Wallet) {
      this.setSecret(MNEMONIC);
    });
    const hardwareSeed = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
    const path = MultisigHDWallet.PATH_NATIVE_SEGWIT;
    const hardwareAccount = {
      family: 'ledger' as const,
      fingerprint: 'd34db33f',
      path,
      xpub: convertExtendedKey(MultisigHDWallet.seedToXpub(hardwareSeed, path), 'legacy'),
      format: 'multisig-native' as const,
    };
    mockRouteParams = {
      m: 2,
      n: 2,
      format: MultisigHDWallet.FORMAT_P2WSH,
      walletLabel: 'Hardware and phone',
      hardwareAndMobile: true,
    };
    const view = render(<WalletsAddMultisigStep2 />);
    const generateButton = await view.findByTestId('VaultKeyGenerate');
    fireEvent.press(generateButton);
    fireEvent.press(generateButton);
    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith('WalletsAddMultisigVaultKeySheet', {
        keyIndex: 1,
        seed: MNEMONIC,
        requireBackupAcknowledgement: true,
        seedToken: 'key-1',
      }),
    );
    expect(generate).toHaveBeenCalledTimes(1);
    expect(view.queryByTestId('VaultCosignerImport2')).toBeNull();
    expect(view.getByTestId('CreateButton').props.accessibilityState?.disabled ?? true).toBe(true);
    fireEvent.press(view.getByTestId('VaultHardwareCosigner2'));
    expect(mockNavigate).toHaveBeenLastCalledWith('HardwareWalletAccount', {
      mode: 'multisig-cosigner',
      format: 'multisig-native',
      returnTo: 'WalletsAddMultisigStep2',
    });
    expect(JSON.stringify(mockNavigate.mock.calls.at(-1))).not.toContain(MNEMONIC);

    mockRouteParams.hardwareAccount = hardwareAccount;
    view.rerender(<WalletsAddMultisigStep2 />);
    await waitFor(() => expect(view.queryByTestId('VaultHardwareCosigner2')).toBeNull());
    expect(view.getByTestId('CreateButton').props.accessibilityState?.disabled ?? view.getByTestId('CreateButton').props.disabled).toBe(
      true,
    );
    mockRouteParams.sheetAction = 'backupAcknowledged';
    mockRouteParams.sheetSeedToken = 'key-0';
    view.rerender(<WalletsAddMultisigStep2 />);
    expect(view.getByTestId('CreateButton').props.accessibilityState?.disabled ?? view.getByTestId('CreateButton').props.disabled).toBe(
      true,
    );
    mockRouteParams.sheetSeedToken = 'key-1';
    view.rerender(<WalletsAddMultisigStep2 />);
    await waitFor(() => {
      const create = view.getByTestId('CreateButton');
      expect(create.props.accessibilityState?.disabled ?? create.props.disabled ?? false).toBe(false);
    });
    fireEvent.press(view.getByTestId('CreateButton'));
    await waitFor(() => expect(mockAddAndSaveWallet).toHaveBeenCalledTimes(1));
    const staged = mockAddAndSaveWallet.mock.calls[0][0] as MultisigHDWallet;
    expect(staged.getCosigner(1)).toBe(MNEMONIC);
    expect(staged.getPublicCosigners()[0]?.path).toBe(path);
    expect(staged.getHardwareWalletAssociations()).toEqual([hardwareAccount]);
    const signingPolicy = getBhwiHardwareMobilePolicy(staged);
    expect(signingPolicy?.association).toEqual(hardwareAccount);
    expect(signingPolicy?.phone).toEqual(staged.getPublicCosigners()[0]);
    expect(mockParentGoBack).not.toHaveBeenCalled();

    fireEvent.press(view.getByTestId('CreateButton'));
    await waitFor(expectSameRetry);
    expect(mockAddAndSaveWallet.mock.calls[1][0]).toBe(staged);
  });

  it('ignores a generated key that completes after the creation screen loses focus', async () => {
    let resolveGeneration: (() => void) | undefined;
    const generate = jest.spyOn(HDSegwitBech32Wallet.prototype, 'generate').mockImplementation(async function (this: HDSegwitBech32Wallet) {
      await new Promise<void>(resolve => {
        resolveGeneration = resolve;
      });
      this.setSecret(MNEMONIC);
    });
    mockRouteParams = {
      m: 2,
      n: 2,
      format: MultisigHDWallet.FORMAT_P2WSH,
      walletLabel: 'Exited generation',
      hardwareAndMobile: true,
    };
    const view = render(<WalletsAddMultisigStep2 />);
    fireEvent.press(await view.findByTestId('VaultKeyGenerate'));
    act(() => mockFocusCleanup?.());
    await act(async () => {
      resolveGeneration?.();
      await Promise.resolve();
    });
    expect(mockNavigate).not.toHaveBeenCalledWith('WalletsAddMultisigVaultKeySheet', expect.objectContaining({ seed: MNEMONIC }));

    view.rerender(<WalletsAddMultisigStep2 />);
    const retry = await view.findByTestId('VaultKeyGenerate');
    expect(retry.props.accessibilityState?.disabled ?? retry.props.disabled ?? false).toBe(false);
    fireEvent.press(retry);
    expect(generate).toHaveBeenCalledTimes(2);
    await act(async () => {
      resolveGeneration?.();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith(
        'WalletsAddMultisigVaultKeySheet',
        expect.objectContaining({ seed: MNEMONIC, seedToken: 'key-3' }),
      ),
    );
  });

  it('hides seed words until protection is acquired and acknowledges only the current seed token', async () => {
    mockRouteParams = {
      keyIndex: 1,
      seed: MNEMONIC,
      seedToken: 'key-7',
      requireBackupAcknowledgement: true,
    };
    const view = render(<WalletsAddMultisigVaultKeySheet />);
    expect(view.queryByTestId('VaultSeedWords')).toBeNull();
    expect(view.getByTestId('VaultSeedProtectionPending')).toBeTruthy();
    await view.findByTestId('VaultSeedWords');
    mockDisableScreenProtect.mockImplementationOnce(async () => {
      expect(view.queryByTestId('VaultSeedWords')).toBeNull();
    });
    expect(mockEnableScreenProtect).toHaveBeenCalledTimes(1);
    fireEvent.press(view.getByTestId('VaultKeyDone'));
    await waitFor(() => expect(mockDispatch).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(mockDispatch.mock.calls[0]?.[0])).toContain('backupAcknowledged');
    expect(JSON.stringify(mockDispatch.mock.calls[0]?.[0])).toContain('key-7');
    view.unmount();
    expect(mockDisableScreenProtect).toHaveBeenCalled();
  });

  it('keeps seed words hidden when screen protection acquisition fails', async () => {
    mockEnableScreenProtect.mockRejectedValueOnce(new Error('capture unavailable'));
    mockRouteParams = {
      keyIndex: 1,
      seed: MNEMONIC,
      seedToken: 'key-8',
      requireBackupAcknowledgement: true,
    };
    const view = render(<WalletsAddMultisigVaultKeySheet />);
    await waitFor(() => expect(view.queryByTestId('VaultSeedProtectionPending')).toBeNull());
    expect(view.queryByTestId('VaultSeedWords')).toBeNull();
    fireEvent.press(view.getByTestId('VaultKeyDone'));
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('never persists or navigates when vault creation loses focus during balance fetch', async () => {
    mockIsElectrumDisabled = false;
    mockRouteParams = {
      m: 1,
      n: 1,
      format: MultisigHDWallet.FORMAT_P2WSH,
      walletLabel: 'Abandoned vault',
      sheetAction: 'importMnemonic',
      sheetImportText: MNEMONIC,
      sheetAskPassphrase: false,
    };
    let resolveFetch: (() => void) | undefined;
    const fetch = jest.spyOn(MultisigHDWallet.prototype, 'fetchBalance').mockImplementation(
      () =>
        new Promise<void>(resolve => {
          resolveFetch = resolve;
        }),
    );
    const view = render(<WalletsAddMultisigStep2 />);
    await waitFor(() => {
      const create = view.getByTestId('CreateButton');
      expect(create.props.accessibilityState?.disabled ?? create.props.disabled ?? false).toBe(false);
    });
    fireEvent.press(view.getByTestId('CreateButton'));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    act(() => mockFocusCleanup?.());
    await act(async () => {
      resolveFetch?.();
      await Promise.resolve();
    });
    expect(mockAddAndSaveWallet).not.toHaveBeenCalled();
    expect(mockParentGoBack).not.toHaveBeenCalled();
  });

  it('rejects duplicate create presses while the same operation is awaiting', async () => {
    mockRouteParams = {
      m: 1,
      n: 1,
      format: MultisigHDWallet.FORMAT_P2WSH,
      walletLabel: 'Single operation',
      sheetAction: 'importMnemonic',
      sheetImportText: MNEMONIC,
      sheetAskPassphrase: false,
    };
    let resolveSleep: (() => void) | undefined;
    mockSleep.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          resolveSleep = resolve;
        }),
    );
    const view = render(<WalletsAddMultisigStep2 />);
    await waitFor(() => {
      const create = view.getByTestId('CreateButton');
      expect(create.props.accessibilityState?.disabled ?? create.props.disabled ?? false).toBe(false);
    });
    const create = view.getByTestId('CreateButton');
    fireEvent.press(create);
    fireEvent.press(create);
    expect(mockSleep).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveSleep?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(mockAddAndSaveWallet).toHaveBeenCalledTimes(1));
  });
});
