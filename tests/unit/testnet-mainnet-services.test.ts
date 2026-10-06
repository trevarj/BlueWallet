import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform, Alert, Linking } from 'react-native';
import { BoltzSwapProvider, type BoltzReverseSwap } from '@arkade-os/boltz-swap';
import { RealmSwapRepository } from '@arkade-os/boltz-swap/repositories/realm';
import type * as BitcoinProfile from '../../models/bitcoinNetwork';
import type * as BitcoinUnits from '../../models/bitcoinUnits';
import type * as Localization from '../../loc';
import type * as LightningWalletModule from '../../class/wallets/lightning-custodian-wallet';
import type * as LightningArkWalletModule from '../../class/wallets/lightning-ark-wallet';
import type * as HDSegwitWalletModule from '../../class/wallets/hd-segwit-bech32-wallet';
import type * as BlueAppModule from '../../class/blue-app';
import type StartImport from '../../class/wallet-import';
import type LnurlClass from '../../class/lnurl';
import type AztecoClass from '../../class/azteco';
import type DeeplinkClass from '../../class/deeplink-schema-match';
import type PayjoinClass from '../../class/payjoin-transaction';
import type * as NotificationsModule from '../../blue_modules/notifications';
import type * as BuyBitcoinModule from '../../components/BuyBitcoinButton';
import type * as BitcoinJs from 'bitcoinjs-lib';
import type * as PermissionsModule from 'react-native-permissions';
import type * as ArkBackgroundModule from '../../blue_modules/arkade-background';
import type BackgroundFetchModule from 'react-native-background-fetch';
import type * as ClipboardPaymentModule from '../../blue_modules/clipboardPayment';
import type * as RealmInstanceModule from '../../blue_modules/arkade-adapters/realm/realmInstance';

jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  Object.defineProperty(actual, 'Platform', {
    value: actual.Platform,
    configurable: true,
  });
  return actual;
});

jest.mock('../../codegen/NativeSettingsModule', () => ({
  __esModule: true,
  default: { getConstants: () => ({ bitcoinNetwork: 'testnet4' }) },
}));

jest.mock('../../util/fetch', () => ({ fetch: jest.fn() }));
jest.mock('../../blue_modules/arkade-adapters/realm/realmInstance', () => ({
  ...jest.requireActual('../../blue_modules/arkade-adapters/realm/realmInstance'),
  getArkadeRealm: jest.fn().mockResolvedValue({}),
}));

jest.mock('../../blue_modules/BlueElectrum', () => ({
  ensureConnected: jest.fn().mockResolvedValue(true),
  multiGetHistoryByAddress: jest.fn().mockResolvedValue({}),
  multiGetTransactionByTxid: jest.fn().mockResolvedValue({}),
  multiGetBalanceByAddress: jest.fn().mockResolvedValue({ addresses: {} }),
  multiGetUtxoByAddress: jest.fn().mockResolvedValue({}),
  getTransactionsByAddress: jest.fn().mockResolvedValue([]),
  estimateFees: jest.fn().mockResolvedValue({ fast: 1, medium: 1, slow: 1 }),
}));

Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });

const profile = require('../../models/bitcoinNetwork') as typeof BitcoinProfile;
const { BitcoinUnit, Chain } = require('../../models/bitcoinUnits') as typeof BitcoinUnits;
const { formatBalance } = require('../../loc') as typeof Localization;
const { LightningCustodianWallet } = require('../../class/wallets/lightning-custodian-wallet') as typeof LightningWalletModule;
const { HDSegwitBech32Wallet } = require('../../class/wallets/hd-segwit-bech32-wallet') as typeof HDSegwitWalletModule;
const { LightningArkWallet } = require('../../class/wallets/lightning-ark-wallet') as typeof LightningArkWalletModule;
const { BlueApp } = require('../../class/blue-app') as typeof BlueAppModule;
const startImport = require('../../class/wallet-import').default as typeof StartImport;
const Lnurl = require('../../class/lnurl').default as typeof LnurlClass;
const Azteco = require('../../class/azteco').default as typeof AztecoClass;
const DeeplinkSchemaMatch = require('../../class/deeplink-schema-match').default as typeof DeeplinkClass;
const PayjoinTransaction = require('../../class/payjoin-transaction').default as typeof PayjoinClass;
const notifications = require('../../blue_modules/notifications') as typeof NotificationsModule;
const buyBitcoin = require('../../components/BuyBitcoinButton') as typeof BuyBitcoinModule;
const bitcoin = require('bitcoinjs-lib') as typeof BitcoinJs;
const arkBackground = require('../../blue_modules/arkade-background') as typeof ArkBackgroundModule;
const backgroundFetch = require('react-native-background-fetch').default as typeof BackgroundFetchModule;
const clipboardPayment = require('../../blue_modules/clipboardPayment') as typeof ClipboardPaymentModule;
const realmInstance = require('../../blue_modules/arkade-adapters/realm/realmInstance') as typeof RealmInstanceModule;
const getArkadeRealmMock = realmInstance.getArkadeRealm as jest.MockedFunction<typeof realmInstance.getArkadeRealm>;
const serviceFetch = require('../../util/fetch').fetch as jest.MockedFunction<(input: string, init?: RequestInit) => Promise<Response>>;
const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

beforeEach(async () => {
  await AsyncStorage.clear();
  BlueApp.getInstance().wallets = [];
  arkBackground.__testing__.reset();
  getArkadeRealmMock.mockClear();
  serviceFetch.mockReset();
  jest.spyOn(Alert, 'alert').mockClear();
  jest.spyOn(Linking, 'openURL').mockClear();
});
const bip47PaymentCode =
  'PM8TJS2JxQ5ztXUpBBRnpTbcUXbUHy2T1abfrb3KkAAtMEGNbey4oumH7Hc578WgQJhPjBxteQ5GHHToTYHE3A1w6p7tU6KSoFmWBVbFGjKPisZDbP97';
const lnurlPayment = 'LNURL1DP68GURN8GHJ7MRWW3UXYMM59E3XJEMNW4HZU7RE0GHKCMN4WFKZ7URP0YLH2UM9WF5KG0FHXYCNV9G9W58';

afterAll(() => {
  jest.restoreAllMocks();
});

it('labels Testnet4 and suppresses fiat formatting', () => {
  expect(profile.mainnetServicesEnabled).toBe(false);
  expect(profile.labelForNetwork('Confirm')).toBe('Confirm — Testnet4');
  expect(formatBalance(100_000_000, BitcoinUnit.BTC)).toBe('1 BTC');
  expect(formatBalance(100_000_000, BitcoinUnit.SATS)).toContain('sats');
  expect(formatBalance(100_000_000, BitcoinUnit.LOCAL_CURRENCY)).toBe('1 BTC');
});

it('rejects Lightning, LNURL, purchase, and redemption before service work', async () => {
  const lightning = new LightningCustodianWallet();
  lightning.setBaseURI('https://lndhub.example');
  lightning.setSecret('lndhub://login:password');
  const ark = new LightningArkWallet();
  ark.setSecret(`arkade://${mnemonic}`);
  await expect(ark.init()).rejects.toThrow(profile.MAINNET_SERVICES_UNAVAILABLE);

  await expect(lightning.init()).rejects.toThrow(profile.MAINNET_SERVICES_UNAVAILABLE);
  await expect(lightning.fetchBalance()).rejects.toThrow(profile.MAINNET_SERVICES_UNAVAILABLE);
  await expect(LightningCustodianWallet.isValidNodeAddress('https://lndhub.example')).rejects.toThrow(profile.MAINNET_SERVICES_UNAVAILABLE);
  await expect(new Lnurl('LNURL1DP68GURN8GHJ7MRWW4EXCTN0D3SKCCNE9E3K7MF0D3H82UNVWQHK2MN5DA5KU6M').callLnurlPayService()).rejects.toThrow(
    profile.MAINNET_SERVICES_UNAVAILABLE,
  );
  await expect(Azteco.redeem({ c1: '1111', c2: '2222', c3: '3333', c4: '4444' }, 'tb1qexample')).rejects.toThrow(
    profile.MAINNET_SERVICES_UNAVAILABLE,
  );
  expect(() => buyBitcoin.buyBitcoinUrl('tb1qexample')).toThrow(profile.MAINNET_SERVICES_UNAVAILABLE);
  expect(buyBitcoin.buyBitcoinButtonVariant(Chain.ONCHAIN, 0, 'US')).toBeNull();

  const getAddressAsync = jest.fn().mockResolvedValue('tb1qexample');
  await expect(
    buyBitcoin.resolveBuyBitcoinReceiveAddress(
      { getAddressAsync, getAddress: jest.fn() },
      { isElectrumDisabled: false, sleep: jest.fn(), saveToDisk: jest.fn() },
    ),
  ).rejects.toThrow(profile.MAINNET_SERVICES_UNAVAILABLE);
  expect(getAddressAsync).not.toHaveBeenCalled();
  expect(serviceFetch).not.toHaveBeenCalled();
  expect(Linking.openURL).not.toHaveBeenCalled();
});

it('restores serialized Lightning and Ark wallets without initializing or refreshing their services', async () => {
  const source = new BlueApp();
  const lightning = new LightningCustodianWallet();
  lightning.setSecret('lndhub://login:password');
  lightning.setBaseURI('https://lndhub.example');
  lightning.refill_addressess = ['bc1q-serialized-lnd-refill'];
  const ark = new LightningArkWallet();
  ark.setSecret(`arkade://${mnemonic}`);
  ark.refill_addressess = ['bc1q-serialized-ark-refill'];
  source.wallets = [lightning, ark];
  const walletIds = source.wallets.map(wallet => wallet.getID());
  const serializedData = JSON.stringify({
    wallets: source.wallets.map(wallet => JSON.stringify(wallet)),
    tx_metadata: {},
    counterparty_metadata: {},
    address_metadata: {},
  });

  const lightningInit = jest.spyOn(LightningCustodianWallet.prototype, 'init').mockResolvedValue();
  const arkInit = jest.spyOn(LightningArkWallet.prototype, 'init').mockResolvedValue();
  const restoredApp = new BlueApp();
  const storageRead = jest.spyOn(restoredApp, 'getItem').mockImplementation(async key => (key === 'data' ? serializedData : null));

  try {
    await restoredApp.loadFromDisk();
    const restoredWallets = restoredApp.getWallets();
    expect(restoredWallets.map(wallet => wallet.getID())).toEqual(walletIds);
    const restoredLightning = restoredWallets.find(wallet => wallet.type === LightningCustodianWallet.type);
    const restoredArk = restoredWallets.find(wallet => wallet.type === LightningArkWallet.type);
    expect(restoredLightning).toBeInstanceOf(LightningCustodianWallet);
    expect(restoredArk).toBeInstanceOf(LightningArkWallet);
    if (!(restoredLightning instanceof LightningCustodianWallet) || !(restoredArk instanceof LightningArkWallet)) {
      throw new Error('Serialized service wallets were not restored');
    }

    expect(restoredLightning.refill_addressess).toEqual(['bc1q-serialized-lnd-refill']);
    expect(restoredArk.refill_addressess).toEqual(['bc1q-serialized-ark-refill']);
    expect(restoredLightning.getAddress()).toBe(false);
    expect(restoredArk.getAddress()).toBe(false);
    expect(restoredLightning.getAllExternalAddresses()).toEqual([]);
    expect(restoredArk.getAllExternalAddresses()).toEqual([]);

    const balanceSpies = restoredWallets.map(wallet => jest.spyOn(wallet, 'fetchBalance').mockResolvedValue());
    const transactionSpies = restoredWallets.map(wallet => jest.spyOn(wallet, 'fetchTransactions').mockResolvedValue());
    await restoredApp.fetchWalletBalances();
    await restoredApp.fetchWalletTransactions();

    expect(lightningInit).not.toHaveBeenCalled();
    expect(arkInit).not.toHaveBeenCalled();
    expect(getArkadeRealmMock).not.toHaveBeenCalled();
    balanceSpies.forEach(spy => expect(spy).not.toHaveBeenCalled());
    transactionSpies.forEach(spy => expect(spy).not.toHaveBeenCalled());
  } finally {
    storageRead.mockRestore();
    lightningInit.mockRestore();
    arkInit.mockRestore();
  }
});

it.each(['lndhub://login:password', `arkade://${mnemonic}`])(
  'rejects unsupported import before yielding or storing %s',
  async importText => {
    const onWallet = jest.fn();
    const { promise } = startImport(importText, false, false, true, jest.fn(), onWallet, jest.fn().mockResolvedValue(''));

    await expect(promise).rejects.toThrow(profile.MAINNET_SERVICES_UNAVAILABLE);
    expect(onWallet).not.toHaveBeenCalled();
    expect(serviceFetch).not.toHaveBeenCalled();
  },
);

it('preserves a Payjoin intent while direct and hidden entrypoints reject it', () => {
  const address = bitcoin.payments.p2wpkh({ hash: Buffer.alloc(20, 3), network: profile.network }).address!;
  const uri = `bitcoin:${address}?amount=0.001&pj=https%3A%2F%2Fpayjoin.example%2Fpj`;
  const decoded = DeeplinkSchemaMatch.decodeBitcoinUri(uri);
  const navigate = jest.fn();

  expect(decoded.payjoinUrl).toBe('https://payjoin.example/pj');
  DeeplinkSchemaMatch.navigationRouteFor({ url: uri }, navigate);
  expect(navigate).not.toHaveBeenCalled();
  expect(Alert.alert).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('Payjoin'));

  const wallet = new HDSegwitBech32Wallet();
  wallet.setSecret(mnemonic);
  expect(() => new PayjoinTransaction(new bitcoin.Psbt({ network: profile.network }), jest.fn().mockResolvedValue(true), wallet)).toThrow(
    profile.MAINNET_SERVICES_UNAVAILABLE,
  );
});

it('rejects deep-linked mainnet-only services without navigating', () => {
  const navigate = jest.fn();

  DeeplinkSchemaMatch.navigationRouteFor({ url: 'https://azte.co/redeem?code=1111222233334444' }, navigate);
  expect(navigate).not.toHaveBeenCalled();
  expect(Alert.alert).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('Testnet4'));
  jest.mocked(Alert.alert).mockClear();
  const address = bitcoin.payments.p2wpkh({ hash: Buffer.alloc(20, 5), network: profile.network }).address!;
  DeeplinkSchemaMatch.navigationRouteFor({ url: `bitcoin:${address}?lightning=lnbc1unsupported` }, navigate);
  expect(navigate).not.toHaveBeenCalled();
  expect(Alert.alert).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('Testnet4'));
});

it('keeps ordinary test-encoded clipboard payments while suppressing mainnet-only intents', () => {
  const address = bitcoin.payments.p2wpkh({ hash: Buffer.alloc(20, 4), network: profile.network }).address!;

  expect(clipboardPayment.classifyClipboardPayment(address)).toEqual({
    kind: clipboardPayment.ClipboardPaymentKind.Bitcoin,
    payload: address,
  });
  const combined = `bitcoin:${address}?lightning=lnbc1unsupported`;
  expect(clipboardPayment.classifyClipboardPayment(combined)).toEqual({
    kind: clipboardPayment.ClipboardPaymentKind.Unsupported,
    payload: combined,
  });
  expect(clipboardPayment.classifyClipboardPayment(bip47PaymentCode)).toEqual({
    kind: clipboardPayment.ClipboardPaymentKind.Unsupported,
    payload: bip47PaymentCode,
  });
  expect(clipboardPayment.classifyClipboardPayment(lnurlPayment)).toEqual({
    kind: clipboardPayment.ClipboardPaymentKind.Unsupported,
    payload: lnurlPayment,
  });
});

it('disables BIP47 and Silent Payment eager and persisted paths', () => {
  const wallet = new HDSegwitBech32Wallet();
  wallet.setSecret(mnemonic);
  wallet._receive_payment_codes = ['PM8TJpersisted'];
  wallet._send_payment_codes = ['sp1qpersisted'];

  expect(wallet.allowBIP47()).toBe(false);
  expect(wallet.allowSilentPaymentSend()).toBe(false);
  expect(wallet.isBIP47Enabled()).toBe(false);
  expect(wallet.getBIP47SenderPaymentCodes()).toEqual([]);
  expect(wallet.getBIP47ReceiverPaymentCodes()).toEqual([]);
  expect(() => wallet.getBIP47PaymentCode()).toThrow(profile.MAINNET_SERVICES_UNAVAILABLE);
  expect(() => wallet.addBIP47Receiver('PM8TJnew')).toThrow(profile.MAINNET_SERVICES_UNAVAILABLE);
});

it('finishes restored pending Ark work without Realm, Boltz, or reconciliation side effects', async () => {
  const configure = backgroundFetch.configure as jest.MockedFunction<typeof backgroundFetch.configure>;
  const finish = backgroundFetch.finish as jest.MockedFunction<typeof backgroundFetch.finish>;
  configure.mockClear();
  finish.mockClear();
  arkBackground.__testing__.reset();

  const sourceArk = new LightningArkWallet();
  sourceArk.setSecret(`arkade://${mnemonic}`);
  const restoredArk = LightningArkWallet.fromJson(JSON.stringify({ ...Object.assign({}, sourceArk), type: LightningArkWallet.type }));
  if (!(restoredArk instanceof LightningArkWallet)) throw new Error('Ark wallet restoration failed');
  BlueApp.getInstance().wallets = [restoredArk];

  const pendingSwap = { id: 'restored-pending-swap', type: 'reverse', status: 'swap.created' };
  const getAllSwaps = jest.spyOn(RealmSwapRepository.prototype, 'getAllSwaps').mockResolvedValue([pendingSwap] as never);
  const getSwapStatus = jest.spyOn(BoltzSwapProvider.prototype, 'getSwapStatus').mockResolvedValue({
    status: 'swap.created',
  } as never);
  arkBackground.__testing__.state.lastSwapUpdateAt = 2;
  arkBackground.__testing__.state.lastReconciledAt = 1;
  arkBackground.__testing__.swapStatusCache.set(restoredArk.getNamespace(), new Map([[pendingSwap.id, pendingSwap.status]]));
  const refresh = jest.fn();

  try {
    await arkBackground.registerArkBackgroundTask();
    await arkBackground.runArkBackgroundTask('testnet-task');
    arkBackground.reconcileArkBackgroundTaskResults(refresh);

    expect(configure).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledWith('testnet-task');
    expect(getArkadeRealmMock).not.toHaveBeenCalled();
    expect(getAllSwaps).not.toHaveBeenCalled();
    expect(getSwapStatus).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  } finally {
    getAllSwaps.mockRestore();
    getSwapStatus.mockRestore();
    BlueApp.getInstance().wallets = [];
    arkBackground.__testing__.reset();
  }
});

it('does not request permissions, tokens, or production push endpoints', async () => {
  const permissions = require('react-native-permissions') as typeof PermissionsModule;
  const requestNotifications = permissions.requestNotifications as jest.MockedFunction<typeof permissions.requestNotifications>;
  requestNotifications.mockClear();

  expect(notifications.isNotificationsCapable).toBe(false);
  await expect(notifications.tryToObtainPermissions()).resolves.toBe(false);
  await expect(notifications.getPushToken()).resolves.toBeNull();
  await expect(notifications.majorTomToGroundControl(['tb1qexample'], [], [])).resolves.toBeUndefined();
  await expect(notifications.registerArkPaymentPush('hash', 'label', {} as unknown as BoltzReverseSwap)).resolves.toBeUndefined();
  await expect(notifications.unsubscribe(['tb1qexample'], [], [])).resolves.toBeUndefined();
  await expect(notifications.enqueueTestPushNotification()).rejects.toThrow('unavailable');

  expect(requestNotifications).not.toHaveBeenCalled();
  expect(serviceFetch).not.toHaveBeenCalled();
});
