import React from 'react';
import assert from 'assert';
import { render, waitFor } from '@testing-library/react-native';
import { AppState, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  getApplicationName,
  getBundleId,
  getDeviceType,
  getSystemName,
  getSystemVersion,
  getVersion,
  hasGmsSync,
  hasHmsSync,
  isTablet,
} from 'react-native-device-info';
import { Notification, NotificationBackgroundFetchResult, Notifications } from 'react-native-notifications';
import { checkNotifications, requestNotifications } from 'react-native-permissions';
import { fetch } from '../../util/fetch';
import NotificationSettings from '../../screen/settings/NotificationSettings';
import loc from '../../loc';
import type * as NotificationModuleExports from '../../blue_modules/notifications';

jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  // Keep configured native identities stable across isolateModules; leave other exports lazy.
  Object.defineProperty(actual, 'Platform', {
    value: actual.Platform,
    configurable: true,
  });
  Object.defineProperty(actual, 'AppState', {
    value: actual.AppState,
    configurable: true,
  });
  Object.defineProperty(actual.Platform, 'OS', {
    value: 'android',
    configurable: true,
  });
  actual.AppState.addEventListener = jest.fn(() => ({ remove: jest.fn() }));
  return actual;
});
jest.mock('react-native-device-info', () => ({
  getBundleId: jest.fn().mockReturnValue('io.bluewallet.bluewallet.bhwi'),
  hasGmsSync: jest.fn().mockReturnValue(true),
  hasHmsSync: jest.fn().mockReturnValue(false),
  getApplicationName: jest.fn().mockReturnValue('BlueWallet'),
  getSystemName: jest.fn().mockReturnValue('Android'),
  getSystemVersion: jest.fn().mockReturnValue('16'),
  getVersion: jest.fn().mockReturnValue('8.0.2'),
  getDeviceType: jest.fn().mockReturnValue('Handset'),
  isTablet: jest.fn().mockReturnValue(false),
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(),
    setItem: jest.fn().mockResolvedValue(undefined),
    removeItem: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('react-native-permissions', () => ({
  checkNotifications: jest.fn().mockResolvedValue({ status: 'granted' }),
  requestNotifications: jest.fn().mockResolvedValue({ status: 'granted' }),
  openSettings: jest.fn(),
  RESULTS: { GRANTED: 'granted' },
}));
jest.mock('../../util/fetch', () => ({
  fetch: jest.fn().mockResolvedValue({ ok: true, json: async () => ({ level_all: true }) }),
}));
jest.mock('react-native-notifications', () => {
  class MockNotification {
    identifier: string;
    title: string;
    body: string;
    constructor(
      public payload: {
        identifier: string;
        title: string;
        body: string;
        [key: string]: unknown;
      },
    ) {
      this.identifier = payload.identifier;
      this.title = payload.title;
      this.body = payload.body;
    }
  }
  const events = {
    registerRemoteNotificationsRegistered: jest.fn(() => ({
      remove: jest.fn(),
    })),
    registerRemoteNotificationsRegistrationFailed: jest.fn(() => ({
      remove: jest.fn(),
    })),
    registerRemoteNotificationsRegistrationDenied: jest.fn(() => ({
      remove: jest.fn(),
    })),
    registerNotificationReceivedForeground: jest.fn(() => ({
      remove: jest.fn(),
    })),
    registerNotificationReceivedBackground: jest.fn(() => ({
      remove: jest.fn(),
    })),
    registerNotificationOpened: jest.fn(() => ({ remove: jest.fn() })),
  };
  return {
    Notification: MockNotification,
    NotificationBackgroundFetchResult: {
      NEW_DATA: 'newData',
      NO_DATA: 'noData',
      FAILED: 'failed',
    },
    Notifications: {
      events: jest.fn(() => events),
      registerRemoteNotifications: jest.fn(),
      getInitialNotification: jest.fn().mockResolvedValue(undefined),
      setNotificationChannel: jest.fn(),
      removeAllDeliveredNotifications: jest.fn(),
      ios: {
        checkPermissions: jest.fn().mockResolvedValue({ alert: true, badge: true, sound: true }),
        setBadgeCount: jest.fn(),
      },
    },
  };
});
jest.mock('../../components/SafeAreaScrollView', () => jest.requireActual('react-native').ScrollView);
jest.mock('../../components/themes', () => ({
  useTheme: () => ({
    dark: false,
    colors: {
      foregroundColor: '#000000',
      alternativeTextColor: '#999999',
      cardSectionBackground: '#ffffff',
    },
  }),
}));

type NotificationModule = typeof NotificationModuleExports;
const mockNotificationEvents = jest.requireMock('react-native-notifications').Notifications.events();

function loadNotifications(os: 'android' | 'ios', bundleId: string, gms = true, hms = false): NotificationModule {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
  jest.mocked(getBundleId).mockReturnValue(bundleId);
  jest.mocked(hasGmsSync).mockReturnValue(gms);
  jest.mocked(hasHmsSync).mockReturnValue(hms);
  let subject: NotificationModule | undefined;
  jest.isolateModules(() => {
    subject = require('../../blue_modules/notifications');
  });
  if (!subject) throw new Error('Notification module did not load');
  return subject;
}

beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(Platform, 'OS', {
    value: 'android',
    configurable: true,
  });
  jest.mocked(AppState.addEventListener).mockReturnValue({ remove: jest.fn() });
  jest.mocked(getBundleId).mockReturnValue('io.bluewallet.bluewallet.bhwi');
  jest.mocked(getDeviceType).mockReturnValue('Handset');
  jest.mocked(isTablet).mockReturnValue(false);
  jest.mocked(hasGmsSync).mockReturnValue(true);
  jest.mocked(hasHmsSync).mockReturnValue(false);
  jest.mocked(getApplicationName).mockReturnValue('BlueWallet');
  jest.mocked(getSystemName).mockReturnValue('Android');
  jest.mocked(getSystemVersion).mockReturnValue('16');
  jest.mocked(getVersion).mockReturnValue('8.0.2');
  jest.mocked(checkNotifications).mockResolvedValue({ status: 'granted', settings: {} });
  jest.mocked(requestNotifications).mockResolvedValue({ status: 'granted', settings: {} });
  jest.mocked(fetch).mockResolvedValue({
    ok: true,
    json: async () => ({ level_all: true }),
  } as Response);
  jest.mocked(Notifications.events).mockReturnValue(mockNotificationEvents);
  for (const register of [
    mockNotificationEvents.registerRemoteNotificationsRegistered,
    mockNotificationEvents.registerRemoteNotificationsRegistrationFailed,
    mockNotificationEvents.registerRemoteNotificationsRegistrationDenied,
    mockNotificationEvents.registerNotificationReceivedForeground,
    mockNotificationEvents.registerNotificationReceivedBackground,
    mockNotificationEvents.registerNotificationOpened,
  ]) {
    jest.mocked(register).mockReturnValue({ remove: jest.fn() });
  }
  jest.mocked(Notifications.registerRemoteNotifications).mockImplementation(() => {
    const onRegistered = jest.mocked(mockNotificationEvents.registerRemoteNotificationsRegistered).mock.calls.at(-1)?.[0];
    onRegistered?.({ deviceToken: 'fresh-token' });
  });
  jest.mocked(Notifications.ios.checkPermissions).mockResolvedValue({
    alert: true,
    badge: true,
    sound: true,
    notificationCenter: true,
    lockScreen: true,
  });
  const entries = new Map<string, string>([['PUSH_TOKEN', JSON.stringify({ token: 'retained-token', os: 'android' })]]);
  jest.mocked(AsyncStorage.getItem).mockImplementation(async key => entries.get(key) ?? null);
  jest.mocked(AsyncStorage.setItem).mockImplementation(async (key, value) => {
    entries.set(key, value);
  });
  jest.mocked(AsyncStorage.removeItem).mockImplementation(async key => {
    entries.delete(key);
  });
  jest.mocked(Notifications.getInitialNotification).mockResolvedValue(undefined);
});

it.each([
  ['io.bluewallet.bluewallet.bhwi', true, false],
  ['io.bluewallet.bluewallet.bhwi', false, true],
  ['io.bluewallet.bluewallet.bhwi.testnet', true, false],
] as const)('blocks remote initialization and retained-token services for %s with GMS=%s HMS=%s', async (bundleId, gms, hms) => {
  const subject = loadNotifications('android', bundleId, gms, hms);
  assert.strictEqual(subject.isNotificationsCapable, false);
  await subject.initializeNotifications();
  assert.strictEqual(await subject.tryToObtainPermissions(), false);
  assert.strictEqual(await subject.checkNotificationPermissionStatus(), 'unavailable');
  assert.strictEqual(await subject.getPushToken(), null);
  assert.strictEqual(await subject.isNotificationsEnabled(), false);
  await subject.majorTomToGroundControl(['address'], ['hash'], ['txid']);
  await subject.unsubscribe(['address'], ['hash'], ['txid']);
  await subject.setLevels(true);
  await subject.setLevels(false);
  assert.strictEqual(await subject.isNotificationsRedacted(), false);
  await assert.rejects(subject.enqueueTestPushNotification(), /unavailable/);
  await assert.rejects(subject.setRedactNotifications(true), /unavailable/);
  const onAppStateChange = jest.mocked(AppState.addEventListener).mock.calls.at(-1)?.[1];
  await onAppStateChange?.('active');
  expect(fetch).not.toHaveBeenCalled();
  expect(checkNotifications).not.toHaveBeenCalled();
  expect(requestNotifications).not.toHaveBeenCalled();
  const events = Notifications.events();
  expect(events.registerRemoteNotificationsRegistered).not.toHaveBeenCalled();
  expect(events.registerRemoteNotificationsRegistrationFailed).not.toHaveBeenCalled();
  expect(events.registerRemoteNotificationsRegistrationDenied).not.toHaveBeenCalled();
  expect(events.registerNotificationReceivedForeground).toHaveBeenCalledTimes(1);
  expect(events.registerNotificationReceivedBackground).toHaveBeenCalledTimes(1);
  expect(events.registerNotificationOpened).toHaveBeenCalledTimes(1);
  expect(Notifications.registerRemoteNotifications).not.toHaveBeenCalled();
  expect(Notifications.getInitialNotification).toHaveBeenCalledTimes(1);
  expect(Notifications.setNotificationChannel).not.toHaveBeenCalled();
  expect(Notifications.removeAllDeliveredNotifications).not.toHaveBeenCalled();
});

it('ingests local Ark foreground, background and opened notifications without remote push', async () => {
  const subject = loadNotifications('android', 'io.bluewallet.bluewallet.bhwi');
  const processNotifications = jest.fn();
  await subject.initializeNotifications(processNotifications);
  const events = Notifications.events();
  const payload = {
    type: 100,
    walletID: 'ark-wallet',
    swapId: 'swap-id',
    action: 'claim',
    title: 'Claim swap',
    body: 'Open to claim',
  };
  const foregroundCompletion = jest.fn();
  const backgroundCompletion = jest.fn();
  const openedCompletion = jest.fn();

  await jest
    .mocked(events.registerNotificationReceivedForeground)
    .mock.calls[0][0](new Notification({ ...payload, identifier: 'foreground' }), foregroundCompletion);
  await jest
    .mocked(events.registerNotificationReceivedBackground)
    .mock.calls[0][0](new Notification({ ...payload, identifier: 'background' }), backgroundCompletion);
  await jest
    .mocked(events.registerNotificationOpened)
    .mock.calls[0][0](new Notification({ ...payload, identifier: 'opened' }), openedCompletion);

  expect(await subject.getStoredNotifications()).toEqual([
    expect.objectContaining({
      ...payload,
      identifier: 'foreground',
      foreground: true,
      userInteraction: false,
    }),
    expect.objectContaining({
      ...payload,
      identifier: 'background',
      foreground: false,
      userInteraction: false,
    }),
    expect.objectContaining({
      ...payload,
      identifier: 'opened',
      foreground: false,
      userInteraction: true,
    }),
  ]);
  expect(processNotifications).toHaveBeenCalledTimes(1);
  expect(foregroundCompletion).toHaveBeenCalledWith({
    alert: false,
    sound: false,
    badge: false,
  });
  expect(backgroundCompletion).toHaveBeenCalledWith(NotificationBackgroundFetchResult.NO_DATA);
  expect(openedCompletion).toHaveBeenCalledTimes(1);
  expect(Notifications.registerRemoteNotifications).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it('retains the Ark wallet and swap binding on a local-notification cold-start tap', async () => {
  const payload = {
    identifier: 'cold-start',
    type: 100,
    walletID: 'ark-wallet',
    swapId: 'cold-swap',
    action: 'refund',
    title: 'Refund swap',
    body: 'Open to refund',
  };
  jest.mocked(Notifications.getInitialNotification).mockResolvedValue(new Notification(payload));
  const subject = loadNotifications('android', 'io.bluewallet.bluewallet.bhwi');
  await subject.initializeNotifications();
  await waitFor(async () => {
    expect(await subject.getStoredNotifications()).toEqual([
      expect.objectContaining({
        ...payload,
        foreground: false,
        userInteraction: true,
      }),
    ]);
  });
  expect(Notifications.registerRemoteNotifications).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['io.bluewallet.bluewallet', 'another.wallet'])('retains normal Android remote registration for %s', async bundleId => {
  const subject = loadNotifications('android', bundleId);
  assert.strictEqual(await subject.tryToObtainPermissions(), true);
  expect(Notifications.registerRemoteNotifications).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalled();
});

it('retains iOS push and permission behavior independently of Android identity and mobile services', async () => {
  const subject = loadNotifications('ios', 'io.bluewallet.bluewallet.bhwi', false, false);
  assert.strictEqual(subject.isNotificationsCapable, true);
  assert.strictEqual(await subject.tryToObtainPermissions(), true);
  expect(Notifications.registerRemoteNotifications).toHaveBeenCalledTimes(1);
});

it('makes the directly opened notification settings route unavailable without permissions or push setup', () => {
  const { getByText, queryByTestId } = render(<NotificationSettings />);
  expect(getByText(loc.notifications.unavailable)).toBeTruthy();
  expect(queryByTestId('NotificationsSwitch')).toBeNull();
  expect(checkNotifications).not.toHaveBeenCalled();
  expect(requestNotifications).not.toHaveBeenCalled();
  expect(Notifications.registerRemoteNotifications).not.toHaveBeenCalled();
  expect(AppState.addEventListener).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
