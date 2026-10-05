import { StackActions, useNavigation, useRoute } from '@react-navigation/native';
import type { RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, StyleSheet, TextInput, View } from 'react-native';

import {
  BHWI_SINGLESIG_FORMATS,
  BhwiError,
  getBhwiAccountPath,
  isBhwiAvailable,
  isCanonicalBhwiFingerprint,
  isBhwiSinglesigFormat,
  startBhwiSession,
  supportsBhwiAccountFormat,
  verifyBhwiAccount,
} from '../../blue_modules/bhwi';
import type { BhwiErrorCode, BhwiImportFormat, BhwiSelection, BhwiSession, HardwareWalletAssociation } from '../../blue_modules/bhwi';
import { WatchOnlyWallet } from '../../class/wallets/watch-only-wallet';
import BlueButtonLink from '../../components/BlueButtonLink';
import BlueFormLabel from '../../components/BlueFormLabel';
import { BlueSpacing10, BlueSpacing20 } from '../../components/BlueSpacing';
import BlueText from '../../components/BlueText';
import Button from '../../components/Button';
import ListItem from '../../components/ListItem';
import SafeAreaScrollView from '../../components/SafeAreaScrollView';
import SegmentedControl from '../../components/SegmentedControl';
import { useTheme } from '../../components/themes';
import { useStorage } from '../../hooks/context/useStorage';
import { useScreenProtect } from '../../hooks/useScreenProtect';
import loc from '../../loc';
import type { AddWalletStackParamList } from '../../navigation/AddWalletStack';
import type { Device, DeviceInfo } from '../../codegen/NativeBhwi';

type RouteProps = RouteProp<AddWalletStackParamList, 'HardwareWalletAccount'>;
type NavigationProps = NativeStackNavigationProp<AddWalletStackParamList, 'HardwareWalletAccount'>;
type Transport = 'usb' | 'ble';

const formatLabels: Record<BhwiImportFormat, string> = {
  legacy: loc.wallets.hardware_format_legacy,
  'nested-segwit': loc.wallets.hardware_format_nested,
  'native-segwit': loc.wallets.hardware_format_native,
  taproot: loc.wallets.hardware_format_taproot,
  'multisig-wrapped': loc.wallets.hardware_format_multisig_wrapped,
  'multisig-native': loc.wallets.hardware_format_multisig_native,
};

const bhwiErrorMessages: Partial<Record<BhwiErrorCode, string>> = {
  BHWI_UNAVAILABLE: loc.wallets.hardware_unavailable,
  BHWI_BUSY: loc.wallets.hardware_busy,
  BHWI_PERMISSION_DENIED: loc.wallets.hardware_permission_denied,
  BHWI_USER_REFUSED: loc.wallets.hardware_refused,
  BHWI_AUTH_REFUSED: loc.wallets.hardware_refused,
  BHWI_CANCELLED: loc.wallets.hardware_cancelled,
  BHWI_DISCONNECTED: loc.wallets.hardware_disconnected,
  BHWI_TIMEOUT: loc.wallets.hardware_timeout,
  BHWI_UNSUPPORTED: loc.wallets.hardware_unsupported,
  BHWI_INVALID_INPUT: loc.wallets.hardware_mismatch,
};

const localizedBhwiError = (error: unknown): string => {
  const code = error instanceof BhwiError ? error.code : undefined;
  return (code && bhwiErrorMessages[code]) || loc.wallets.hardware_operation_failed;
};

const HardwareWalletAccount = () => {
  const navigation = useNavigation<NavigationProps>();
  const route = useRoute<RouteProps>();
  const { addAndSaveWallet } = useStorage();
  const { enableScreenProtect, disableScreenProtect } = useScreenProtect();
  const { colors } = useTheme();
  const multisigMode = route.params.mode === 'multisig-cosigner';
  const initialFormat: BhwiImportFormat = multisigMode ? route.params.format : 'native-segwit';

  const [transport, setTransport] = useState<Transport>('usb');
  const [devices, setDevices] = useState<Device[]>([]);
  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo>();
  const [format, setFormat] = useState<BhwiImportFormat>(initialFormat);
  const [accountIndex, setAccountIndex] = useState('0');
  const [stagedAssociation, setStagedAssociation] = useState<HardwareWalletAssociation>();
  const [status, setStatus] = useState(isBhwiAvailable() ? '' : loc.wallets.hardware_unavailable);
  const [busy, setBusy] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  const mountedRef = useRef(true);
  const attemptRef = useRef(0);
  const selectionRef = useRef<BhwiSelection | null>(null);
  const sessionRef = useRef<BhwiSession | undefined>(undefined);
  const draftRef = useRef<WatchOnlyWallet | undefined>(undefined);
  const completedRef = useRef(false);
  const stagedAssociationRef = useRef<HardwareWalletAssociation | undefined>(undefined);
  const operationRef = useRef(false);
  const foregroundRef = useRef(AppState.currentState === 'active');
  const restartRequiredRef = useRef(false);

  const stylesHook = StyleSheet.create({
    root: { backgroundColor: colors.elevated },
    card: { backgroundColor: colors.background, borderColor: colors.formBorder },
    input: { backgroundColor: colors.inputBackgroundColor, borderColor: colors.formBorder, color: colors.foregroundColor },
    status: { color: colors.alternativeTextColor },
  });

  const isCurrent = useCallback((attempt: number) => mountedRef.current && foregroundRef.current && attemptRef.current === attempt, []);

  const retireSession = useCallback(async () => {
    attemptRef.current += 1;
    selectionRef.current = null;
    const session = sessionRef.current;
    sessionRef.current = undefined;
    if (session) {
      try {
        await session.disconnect();
      } catch {}
    }
  }, []);

  const beginDiscovery = useCallback(
    async (nextTransport: Transport = transport) => {
      if (operationRef.current || completedRef.current || !foregroundRef.current) return;
      operationRef.current = true;
      restartRequiredRef.current = false;
      await retireSession();
      if (!mountedRef.current || !foregroundRef.current || restartRequiredRef.current) {
        operationRef.current = false;
        return;
      }
      const attempt = attemptRef.current;
      const selection: BhwiSelection = { walletId: 'hardware-account-import', accountId: String(attempt) };
      selectionRef.current = selection;
      setTransport(nextTransport);
      setDevices([]);
      setDeviceInfo(undefined);
      setStatus('');
      setBusy(true);
      try {
        const session = await startBhwiSession(selection, () => (isCurrent(attempt) ? selectionRef.current : null));
        if (!isCurrent(attempt)) {
          await session.disconnect().catch(() => undefined);
          return;
        }
        sessionRef.current = session;
        const discovered = await session.discover(nextTransport);
        if (!isCurrent(attempt)) return;
        setDevices(discovered);
        setStatus(discovered.length === 0 ? loc.wallets.hardware_no_devices : loc.wallets.hardware_select_device);
      } catch (error) {
        if (isCurrent(attempt)) setStatus(localizedBhwiError(error));
      } finally {
        operationRef.current = false;
        if (isCurrent(attempt)) setBusy(false);
      }
    },
    [isCurrent, retireSession, transport],
  );

  const connect = useCallback(
    async (device: Device) => {
      const session = sessionRef.current;
      const attempt = attemptRef.current;
      if (!session || operationRef.current || completedRef.current || !foregroundRef.current) return;
      operationRef.current = true;
      setBusy(true);
      setStatus('');
      try {
        const info = await session.connect(device.id);
        if (!isCurrent(attempt)) return;
        if (info.family !== device.family || !isCanonicalBhwiFingerprint(info.fingerprint)) {
          throw new BhwiError('BHWI_INVALID_INPUT');
        }
        const availableFormats = (multisigMode ? [initialFormat] : BHWI_SINGLESIG_FORMATS).filter(candidate =>
          supportsBhwiAccountFormat(info, candidate),
        );
        if (availableFormats.length === 0) throw new BhwiError('BHWI_UNSUPPORTED');
        setFormat(availableFormats.includes(format) ? format : availableFormats[0]);
        setDeviceInfo(info);
        setStatus(loc.formatString(loc.wallets.hardware_connected, { device: device.name }));
      } catch (error) {
        if (isCurrent(attempt)) setStatus(localizedBhwiError(error));
      } finally {
        operationRef.current = false;
        if (isCurrent(attempt)) setBusy(false);
      }
    },
    [format, initialFormat, isCurrent, multisigMode],
  );

  const availableFormats = useMemo(
    () =>
      deviceInfo
        ? (multisigMode ? [initialFormat] : BHWI_SINGLESIG_FORMATS).filter(candidate => supportsBhwiAccountFormat(deviceInfo, candidate))
        : [],
    [deviceInfo, initialFormat, multisigMode],
  );

  const getAccount = useCallback(async () => {
    const session = sessionRef.current;
    const info = deviceInfo;
    const attempt = attemptRef.current;
    if (!session || !info || operationRef.current || stagedAssociationRef.current || completedRef.current || !foregroundRef.current) return;
    let path: string;
    try {
      path = getBhwiAccountPath(format, accountIndex);
    } catch {
      setStatus(loc.wallets.hardware_index_invalid);
      return;
    }
    operationRef.current = true;
    setBusy(true);
    setStatus('');
    try {
      const account = await session.getAccount(path, format);
      if (!isCurrent(attempt)) return;
      const association = verifyBhwiAccount(info, path, format, account);
      if (!multisigMode) {
        if (!isBhwiSinglesigFormat(format)) throw new BhwiError('BHWI_INVALID_INPUT');
        draftRef.current = WatchOnlyWallet.fromBhwiAccount(info, account, path, format);
      }
      stagedAssociationRef.current = association;
      setStagedAssociation(association);
    } catch (error) {
      if (isCurrent(attempt)) setStatus(localizedBhwiError(error));
    } finally {
      operationRef.current = false;
      if (isCurrent(attempt)) setBusy(false);
    }
  }, [accountIndex, deviceInfo, format, isCurrent, multisigMode]);

  const finish = useCallback(async () => {
    if (!stagedAssociation || operationRef.current || completedRef.current || !foregroundRef.current) return;
    operationRef.current = true;
    restartRequiredRef.current = false;
    if (route.params.mode === 'multisig-cosigner') {
      completedRef.current = true;
      navigation.dispatch(StackActions.popTo(route.params.returnTo, { hardwareAccount: stagedAssociation }, { merge: true }));
      return;
    }
    const draft = draftRef.current;
    if (!draft) {
      operationRef.current = false;
      return;
    }
    const attempt = attemptRef.current;
    setBusy(true);
    setSaveFailed(false);
    let saved = false;
    try {
      saved = await addAndSaveWallet(draft);
    } catch {}
    operationRef.current = false;
    if (!isCurrent(attempt)) return;
    setBusy(false);
    if (!saved) {
      setSaveFailed(true);
      setStatus(loc.wallets.hardware_save_failed);
      return;
    }
    completedRef.current = true;
    navigation.getParent()?.goBack();
  }, [addAndSaveWallet, isCurrent, navigation, route.params, stagedAssociation]);

  const startOver = useCallback(() => {
    if (operationRef.current || completedRef.current || !foregroundRef.current) return;
    draftRef.current = undefined;
    stagedAssociationRef.current = undefined;
    setStagedAssociation(undefined);
    setAccountIndex('0');
    setFormat(initialFormat);
    beginDiscovery(transport).catch(() => undefined);
  }, [beginDiscovery, initialFormat, transport]);

  useEffect(() => {
    mountedRef.current = true;
    enableScreenProtect();
    const appState = AppState.addEventListener('change', nextState => {
      foregroundRef.current = nextState === 'active';
      if (foregroundRef.current) return;
      restartRequiredRef.current = true;
      const hadHardwareWork = attemptRef.current > 0 || operationRef.current || !!sessionRef.current || !!stagedAssociationRef.current;
      const hasDraft = !!draftRef.current || !!stagedAssociationRef.current;
      retireSession().catch(() => undefined);
      setBusy(false);
      if (hadHardwareWork) setStatus(loc.wallets.hardware_disconnected);
      if (!hasDraft) {
        setDevices([]);
        setDeviceInfo(undefined);
      }
    });
    return () => {
      mountedRef.current = false;
      foregroundRef.current = false;
      restartRequiredRef.current = true;
      attemptRef.current += 1;
      selectionRef.current = null;
      const session = sessionRef.current;
      sessionRef.current = undefined;
      if (session) session.disconnect().catch(() => undefined);
      appState.remove();
      disableScreenProtect();
    };
  }, [disableScreenProtect, enableScreenProtect, retireSession]);

  const controlsLocked = !!stagedAssociation;
  const finishTitle = multisigMode
    ? loc.wallets.hardware_add_cosigner
    : saveFailed
      ? loc.wallets.hardware_retry_save
      : loc.wallets.hardware_save;

  return (
    <SafeAreaScrollView style={stylesHook.root} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {!deviceInfo && !controlsLocked && (
        <>
          <BlueFormLabel>{loc.wallets.hardware_transport}</BlueFormLabel>
          <BlueSpacing10 />
          <SegmentedControl
            values={[loc.wallets.hardware_usb, loc.wallets.hardware_ble]}
            selectedIndex={transport === 'usb' ? 0 : 1}
            onChange={index => !busy && setTransport(index === 0 ? 'usb' : 'ble')}
            testID="HardwareTransport"
            usePlatformStyle
          />
        </>
      )}
      {!deviceInfo && !controlsLocked && (
        <Button
          testID="HardwareDiscover"
          title={loc.wallets.hardware_discover}
          onPress={() => beginDiscovery().catch(() => undefined)}
          disabled={busy || !isBhwiAvailable()}
          showActivityIndicator={busy}
          accessibilityLabel={loc.wallets.hardware_discover}
        />
      )}

      {devices.length > 0 && !deviceInfo && !controlsLocked && (
        <View style={[styles.card, stylesHook.card]}>
          {devices.map(device => (
            <ListItem
              key={device.id}
              testID={`HardwareDevice-${device.id}`}
              title={device.name}
              subtitle={`${device.family} · ${device.transport.toUpperCase()}`}
              onPress={() => connect(device).catch(() => undefined)}
              disabled={busy}
              chevron
            />
          ))}
        </View>
      )}

      {deviceInfo && (
        <>
          <BlueSpacing20 />
          <BlueFormLabel>{loc.wallets.hardware_format}</BlueFormLabel>
          <View style={[styles.card, stylesHook.card]}>
            {availableFormats.map(candidate => (
              <ListItem
                key={candidate}
                testID={`HardwareFormat-${candidate}`}
                title={formatLabels[candidate]}
                onPress={controlsLocked || busy || multisigMode ? undefined : () => setFormat(candidate)}
                disabled={controlsLocked || busy}
                checkmark={candidate === format}
              />
            ))}
          </View>
          <BlueSpacing20 />
          <BlueFormLabel>{loc.wallets.hardware_account_index}</BlueFormLabel>
          <TextInput
            testID="HardwareAccountIndex"
            value={accountIndex}
            onChangeText={setAccountIndex}
            editable={!controlsLocked && !busy}
            keyboardType="number-pad"
            inputMode="numeric"
            maxLength={10}
            autoCorrect={false}
            style={[styles.input, stylesHook.input]}
            accessibilityLabel={loc.wallets.hardware_account_index}
          />
          {!controlsLocked && (
            <>
              <Button
                testID="HardwareGetAccount"
                title={loc.wallets.hardware_get_account}
                onPress={() => getAccount().catch(() => undefined)}
                disabled={busy}
                showActivityIndicator={busy}
              />
              <BlueSpacing10 />
              <BlueButtonLink testID="HardwareStartOver" title={loc.wallets.hardware_start_over} onPress={startOver} disabled={busy} />
            </>
          )}
        </>
      )}

      {stagedAssociation && (
        <View style={[styles.account, styles.card, stylesHook.card]} testID="HardwarePublicAccount">
          <BlueText bold>{formatLabels[stagedAssociation.format]}</BlueText>
          <BlueText selectable>{stagedAssociation.fingerprint}</BlueText>
          <BlueText selectable>{stagedAssociation.path}</BlueText>
          <BlueText selectable numberOfLines={2} ellipsizeMode="middle">
            {stagedAssociation.xpub}
          </BlueText>
          <BlueSpacing20 />
          <Button
            testID="HardwareFinish"
            title={finishTitle}
            onPress={() => finish().catch(() => undefined)}
            disabled={busy}
            showActivityIndicator={busy}
          />
          <BlueSpacing10 />
          <BlueButtonLink testID="HardwareStartOver" title={loc.wallets.hardware_start_over} onPress={startOver} disabled={busy} />
        </View>
      )}

      {busy && !deviceInfo && <ActivityIndicator accessibilityRole="progressbar" style={styles.progress} />}
      {!!status && (
        <BlueText style={[styles.status, stylesHook.status]} accessibilityLiveRegion="polite" testID="HardwareStatus">
          {status}
        </BlueText>
      )}
    </SafeAreaScrollView>
  );
};

const styles = StyleSheet.create({
  content: { padding: 20, paddingBottom: 40 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, overflow: 'hidden', marginTop: 12 },
  account: { padding: 16 },
  input: { height: 48, borderWidth: 1, borderRadius: 4, marginVertical: 12, paddingHorizontal: 12, fontSize: 16 },
  progress: { marginTop: 20 },
  status: { marginTop: 20, textAlign: 'center' },
});

export default HardwareWalletAccount;
