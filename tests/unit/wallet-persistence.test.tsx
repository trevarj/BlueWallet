import React from 'react';
import { act, renderHook } from '@testing-library/react-native';
import type Realm from 'realm';

import { BlueApp } from '../../class/blue-app';
import type { TWallet } from '../../class/wallets/types';
import presentAlert from '../../components/Alert';
import { StorageProvider } from '../../components/Context/StorageProvider';
import triggerHapticFeedback, { HapticFeedbackTypes } from '../../blue_modules/hapticFeedback';
import { majorTomToGroundControl } from '../../blue_modules/notifications';
import { useStorage } from '../../hooks/context/useStorage';

jest.mock('../../components/Alert', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../blue_modules/hapticFeedback', () => ({
  __esModule: true,
  default: jest.fn(),
  HapticFeedbackTypes: {
    NotificationError: 'notificationError',
    NotificationSuccess: 'notificationSuccess',
    ImpactHeavy: 'impactHeavy',
  },
}));
jest.mock('../../blue_modules/notifications', () => ({
  majorTomToGroundControl: jest.fn(),
  unsubscribe: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../blue_modules/arkade-background', () => ({
  registerArkBackgroundTask: jest.fn().mockResolvedValue(undefined),
  stopArkBackgroundTask: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../blue_modules/start-and-decrypt', () => ({ startAndDecrypt: jest.fn() }));
jest.mock('../../blue_modules/BlueElectrum', () => ({
  ENSURE_CONNECTED_MAX_WALL_MS: 1,
  ensureConnected: jest.fn().mockResolvedValue(false),
}));
jest.mock('../../helpers/scan-qr.ts', () => ({ getScanWasBBQR: jest.fn(() => false) }));
jest.mock('../../blue_modules/ur', () => ({ setWalletIdMustUseBBQR: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../NavigationService', () => ({ navigationRef: { current: null } }));

const makeWallet = (id: string): TWallet =>
  ({
    type: 'test-wallet',
    typeReadable: 'Test wallet',
    prepareForSerialization: jest.fn(),
    getID: jest.fn(() => id),
    getLabel: jest.fn(() => `Wallet ${id}`),
    setLabel: jest.fn(),
    setUserHasSavedExport: jest.fn(),
    fetchBalance: jest.fn().mockResolvedValue(undefined),
    getAllExternalAddresses: jest.fn(() => [`address-${id}`]),
  }) as unknown as TWallet;

const mockPersistenceDependencies = (app: BlueApp) => {
  jest.spyOn(app, 'getRealmForTransactions').mockResolvedValue({ close: jest.fn() } as unknown as Realm);
  jest.spyOn(app, 'openRealmKeyValue').mockResolvedValue({ close: jest.fn() } as unknown as Realm);
  return jest.spyOn(app, 'saveToRealmKeyValue').mockImplementation(() => undefined);
};

describe('BlueApp persistence results', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('returns false when primary storage fails', async () => {
    const app = new BlueApp();
    app.wallets = [makeWallet('primary-failure')];
    mockPersistenceDependencies(app);
    jest.spyOn(app, 'setItem').mockRejectedValue(new Error('primary failed'));

    await expect(app.saveToDisk()).resolves.toBe(false);
    expect(app.openRealmKeyValue).not.toHaveBeenCalled();
    expect(presentAlert).toHaveBeenCalledWith({ message: 'save to disk exception: primary failed' });
  });

  it('returns false without removing the staged wallet when Realm backup fails after primary storage', async () => {
    const app = new BlueApp();
    const wallet = makeWallet('realm-failure');
    app.wallets = [wallet];
    const realmWrite = mockPersistenceDependencies(app);
    const setItem = jest.spyOn(app, 'setItem').mockResolvedValue(undefined);
    realmWrite.mockImplementation(() => {
      throw new Error('realm backup failed');
    });

    await expect(app.saveToDisk()).resolves.toBe(false);
    expect(setItem).toHaveBeenCalledTimes(2);
    expect(app.wallets).toEqual([wallet]);
    expect(app.wallets[0]).toBe(wallet);
  });

  it('returns the final recursive save result to a concurrent caller', async () => {
    jest.useFakeTimers();
    const app = new BlueApp();
    app.wallets = [makeWallet('concurrent')];
    mockPersistenceDependencies(app);
    const setItem = jest
      .spyOn(app, 'setItem')
      .mockImplementationOnce(() => app.sleep(1_000))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('retry failed'));

    const firstSave = app.saveToDisk();
    const concurrentSave = app.saveToDisk();
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(firstSave).resolves.toBe(true);
    await jest.advanceTimersByTimeAsync(1_000);

    await expect(concurrentSave).resolves.toBe(false);
    expect(setItem).toHaveBeenCalledTimes(3);
  });
});

describe('StorageProvider persistence contract', () => {
  const app = BlueApp.getInstance();

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(majorTomToGroundControl).mockReset().mockResolvedValue(undefined);
    app.wallets = [];
    app.tx_metadata = {};
    app.counterparty_metadata = {};
    app.address_metadata = {};
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const mountProvider = () => {
    const { result } = renderHook(() => useStorage(), {
      wrapper: ({ children }) => <StorageProvider>{children}</StorageProvider>,
    });
    return result.current;
  };

  it('returns false for the intentional empty-save skip', async () => {
    const save = jest.spyOn(app, 'saveToDisk').mockResolvedValue(true);
    const context = mountProvider();

    await expect(context.saveToDisk()).resolves.toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it('rejects a distinct object with a duplicate wallet ID', async () => {
    app.wallets = [makeWallet('duplicate')];
    const save = jest.spyOn(app, 'saveToDisk').mockResolvedValue(true);
    const context = mountProvider();

    let result = true;
    await act(async () => {
      result = await context.addAndSaveWallet(makeWallet('duplicate'));
    });

    expect(result).toBe(false);
    expect(app.wallets).toHaveLength(1);
    expect(save).not.toHaveBeenCalled();
    expect(triggerHapticFeedback).toHaveBeenCalledWith(HapticFeedbackTypes.NotificationError);
  });

  it('retries the same staged object without duplicating it and keeps success after post-save sync failures', async () => {
    const wallet = makeWallet('retry');
    jest.mocked(wallet.fetchBalance).mockRejectedValue(new Error('sync failed'));
    jest.mocked(majorTomToGroundControl).mockRejectedValue(new Error('notifications failed'));
    const save = jest.spyOn(app, 'saveToDisk').mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const context = mountProvider();

    let firstResult = true;
    let retryResult = false;
    await act(async () => {
      firstResult = await context.addAndSaveWallet(wallet);
    });
    expect(firstResult).toBe(false);
    expect(app.wallets).toHaveLength(1);
    expect(app.wallets[0]).toBe(wallet);
    expect(triggerHapticFeedback).not.toHaveBeenCalledWith(HapticFeedbackTypes.NotificationSuccess);
    expect(majorTomToGroundControl).not.toHaveBeenCalled();

    await act(async () => {
      retryResult = await context.addAndSaveWallet(wallet);
    });

    expect(retryResult).toBe(true);
    expect(save).toHaveBeenCalledTimes(2);
    expect(app.wallets).toHaveLength(1);
    expect(app.wallets[0]).toBe(wallet);
    expect(wallet.setUserHasSavedExport).toHaveBeenCalledTimes(1);
    expect(triggerHapticFeedback).toHaveBeenCalledTimes(1);
    expect(presentAlert).toHaveBeenCalledTimes(1);
    expect(wallet.fetchBalance).toHaveBeenCalledTimes(1);
    expect(majorTomToGroundControl).toHaveBeenCalledTimes(1);
  });
});
