import { act, renderHook } from '@testing-library/react-native';
import { AppState, AppStateStatus } from 'react-native';

import { CLIPBOARD_IDLE_DELAY_MS } from '../../blue_modules/clipboardPayment';
import { readClipboardForDetection } from '../../blue_modules/clipboard';
import useClipboardDetection from '../../hooks/useClipboardDetection';
import { navigationRef } from '../../NavigationService';
import presentAlert from '../../components/Alert';

jest.mock('../../models/bitcoinNetwork', () => ({
  ...jest.requireActual('../../models/bitcoinNetwork'),
  mainnetServicesEnabled: false,
}));
jest.mock('../../components/Alert', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('@react-navigation/native', () => ({
  CommonActions: { navigate: (name: string, params: unknown) => ({ type: 'NAVIGATE', name, params }) },
}));
jest.mock('../../blue_modules/clipboard', () => ({
  readClipboardForDetection: jest.fn(),
  getLastSeenClipboardHash: jest.fn(async () => undefined),
  setLastSeenClipboardHash: jest.fn(async () => {}),
  isClipboardSheetFocused: jest.fn(() => false),
}));
jest.mock('../../blue_modules/hapticFeedback', () => ({
  __esModule: true,
  default: jest.fn(),
  HapticFeedbackTypes: { ImpactLight: 'impactLight', NotificationError: 'notificationError' },
}));
jest.mock('../../blue_modules/environment', () => ({ isDesktop: false }));
jest.mock('../../hooks/context/useStorage', () => ({
  useStorage: () => ({ wallets: [{ chain: 'ONCHAIN', isAddressValid: () => true, weOwnAddress: () => false }] }),
}));
jest.mock('../../NavigationService', () => ({
  navigationRef: { isReady: jest.fn(() => true), getCurrentRoute: jest.fn(() => ({ name: 'WalletsList' })), dispatch: jest.fn() },
}));

const P2WPKH = 'bc1qykcp2x3djgdtdwelxn9z4j2y956npte0a4sref';
const BIP47 = 'PM8TJS2JxQ5ztXUpBBRnpTbcUXbUHy2T1abfrb3KkAAtMEGNbey4oumH7Hc578WgQJhPjBxteQ5GHHToTYHE3A1w6p7tU6KSoFmWBVbFGjKPisZDbP97';

const appStateListeners: Array<(state: AppStateStatus) => void> = [];
const emitAppState = (state: AppStateStatus) => {
  (AppState as { currentState: AppStateStatus }).currentState = state;
  act(() => {
    appStateListeners.forEach(listener => listener(state));
  });
};
const flush = async (ms: number) => {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
};

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  appStateListeners.length = 0;
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
    appStateListeners.push(listener as (state: AppStateStatus) => void);
    return { remove: () => appStateListeners.splice(appStateListeners.indexOf(listener as never), 1) } as never;
  });
  (AppState as { currentState: AppStateStatus }).currentState = 'active';
  jest.mocked(readClipboardForDetection).mockResolvedValue({ content: P2WPKH, pasteBlocked: false });
  jest.mocked(navigationRef.isReady).mockReturnValue(true);
  jest.mocked(navigationRef.getCurrentRoute).mockReturnValue({ name: 'WalletsList', key: 'WalletsList' });
});

afterEach(() => {
  jest.useRealTimers();
});

/** Mirrors what useCompanionListeners does around a background → active cycle. */
const resume = async (hook: ReturnType<typeof renderHook<ReturnType<typeof useClipboardDetection>, boolean>>, skipRead: boolean) => {
  emitAppState('background');
  act(() => hook.result.current.onLeaveForeground('background'));
  emitAppState('active');
  act(() => hook.result.current.onEnterForeground('background', { skipRead }));
  await flush(CLIPBOARD_IDLE_DELAY_MS + 1);
};

it('presents the Detected sheet after a plain resume', async () => {
  const hook = renderHook(useClipboardDetection, { initialProps: true });
  await flush(CLIPBOARD_IDLE_DELAY_MS + 1); // launch read
  jest.mocked(readClipboardForDetection).mockClear();
  jest.mocked(navigationRef.dispatch).mockClear();

  await resume(hook, false);

  expect(readClipboardForDetection).toHaveBeenCalledTimes(1);
  expect(navigationRef.dispatch).toHaveBeenCalledWith(expect.objectContaining({ name: 'ClipboardDetected' }));
});

it('shows the Testnet3 unavailable message for an unsupported clipboard payment', async () => {
  jest.mocked(readClipboardForDetection).mockResolvedValue({ content: BIP47, pasteBlocked: false });
  renderHook(useClipboardDetection, { initialProps: true });

  await flush(CLIPBOARD_IDLE_DELAY_MS + 1);

  expect(presentAlert).toHaveBeenCalledWith({ message: expect.stringContaining('Testnet3') });
  expect(navigationRef.dispatch).not.toHaveBeenCalled();
});

it('defers the launch read until the app is active and the companion reports it', async () => {
  (AppState as { currentState: AppStateStatus }).currentState = 'inactive';
  const hook = renderHook(useClipboardDetection, { initialProps: true });
  await flush(CLIPBOARD_IDLE_DELAY_MS + 1);
  expect(readClipboardForDetection).not.toHaveBeenCalled();

  emitAppState('active');
  act(() => hook.result.current.onEnterForeground('inactive'));
  await flush(CLIPBOARD_IDLE_DELAY_MS + 1);

  expect(readClipboardForDetection).toHaveBeenCalledTimes(1);
  expect(navigationRef.dispatch).toHaveBeenCalledWith(expect.objectContaining({ name: 'ClipboardDetected' }));
});

it('does not read the clipboard on resume when a push notification was handled', async () => {
  const hook = renderHook(useClipboardDetection, { initialProps: true });
  await flush(CLIPBOARD_IDLE_DELAY_MS + 1);
  jest.mocked(readClipboardForDetection).mockClear();
  jest.mocked(navigationRef.dispatch).mockClear();

  await resume(hook, true);

  expect(readClipboardForDetection).not.toHaveBeenCalled();
  expect(navigationRef.dispatch).not.toHaveBeenCalled();
});
