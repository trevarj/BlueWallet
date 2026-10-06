import Clipboard from '@react-native-clipboard/clipboard';
import { useNavigation, RouteProp, StackActions, useIsFocused, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as bitcoin from 'bitcoinjs-lib';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Linking, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import * as BlueElectrum from '../../blue_modules/BlueElectrum';
import triggerHapticFeedback, { HapticFeedbackTypes } from '../../blue_modules/hapticFeedback';
import { isBhwiAvailable } from '../../blue_modules/bhwi';
import {
  BHWI_SIGNING_SESSION_EXPIRED,
  assertBhwiCpfpPackageTarget,
  assertBhwiPsbtAttemptCurrent,
  bhwiAssociationIdentity,
  bhwiWatchOnlyWalletIdentity,
  getBhwiPsbtReview,
  hydrateBhwiPsbt,
  requireBhwiCpfpContext,
  validateBhwiBoundPsbt,
} from '../../blue_modules/bhwiPsbt';
import type { BhwiCpfpContext, BhwiPsbtAttemptSnapshot, BhwiPsbtReview } from '../../blue_modules/bhwiPsbt';
import { validateBhwiPsbtOriginal } from '../../blue_modules/validateBhwiPsbt';
import BlueCard from '../../components/BlueCard';
import BlueText from '../../components/BlueText';
import presentAlert from '../../components/Alert';
import CopyToClipboardButton from '../../components/CopyToClipboardButton';
import { DynamicQRCode } from '../../components/DynamicQRCode';
import SaveFileButton from '../../components/SaveFileButton';
import { SecondButton } from '../../components/SecondButton';
import { useTheme } from '../../components/themes';
import { useBiometrics, unlockWithBiometrics } from '../../hooks/useBiometrics';
import { useScreenProtect } from '../../hooks/useScreenProtect';
import loc from '../../loc';
import { useStorage } from '../../hooks/context/useStorage';
import { useSettings } from '../../hooks/context/useSettings';
import { majorTomToGroundControl } from '../../blue_modules/notifications';
import { openSignedTransactionRaw } from '../../blue_modules/fs';
import { BlueSpacing10, BlueSpacing20 } from '../../components/BlueSpacing';
import { SendDetailsStackParamList } from '../../navigation/SendDetailsStackParamList';
import { WatchOnlyWallet } from '../../class/wallets/watch-only-wallet';
import { network } from '../../models/bitcoinNetwork';
import { isAssociatedWatchOnlySegwitBech32 } from '../../util/isWatchOnlySegwitBech32';

type NavigationProps = NativeStackNavigationProp<SendDetailsStackParamList, 'PsbtWithHardwareWallet'>;

const PsbtWithHardwareWallet = () => {
  const { txMetadata, fetchAndSaveWalletTransactions, wallets } = useStorage();
  const { isElectrumDisabled } = useSettings();
  const { isBiometricUseCapableAndEnabled } = useBiometrics();
  const { enableScreenProtect, disableScreenProtect } = useScreenProtect();
  const navigation = useNavigation<NavigationProps>();
  const route = useRoute<RouteProp<SendDetailsStackParamList, 'PsbtWithHardwareWallet'>>();
  const cpfpRouteSnapshotRef = useRef<{ initialized: boolean; invalid: boolean; value?: BhwiCpfpContext }>({
    initialized: false,
    invalid: false,
  });
  if (!cpfpRouteSnapshotRef.current.initialized) {
    try {
      cpfpRouteSnapshotRef.current = { initialized: true, invalid: false, value: requireBhwiCpfpContext(route.params.cpfp) };
    } catch {
      cpfpRouteSnapshotRef.current = { initialized: true, invalid: true };
    }
  }
  const routeParamsRef = useRef(route.params);
  routeParamsRef.current = { ...routeParamsRef.current, ...route.params };
  const { walletID, memo, psbt, launchedBy } = routeParamsRef.current;
  const wallet = wallets.find(candidate => candidate.getID() === walletID);
  const currentAssociation = wallet instanceof WatchOnlyWallet ? wallet.getHardwareWalletAssociation() : undefined;
  const currentWalletIdentity =
    wallet instanceof WatchOnlyWallet && currentAssociation ? bhwiWatchOnlyWalletIdentity(wallet, currentAssociation) : undefined;
  const hardwareBoundFlowRef = useRef(!!currentAssociation || routeParamsRef.current.bhwiBound === true);
  const hardwareBoundFlow = hardwareBoundFlowRef.current;
  if (hardwareBoundFlow) routeParamsRef.current = { ...routeParamsRef.current, bhwiBound: true };
  const association = hardwareBoundFlow ? currentAssociation : undefined;
  const routeParamsPSBT = useRef(psbt);
  if (!hardwareBoundFlow && route.params.psbt) routeParamsPSBT.current = route.params.psbt;
  const walletsRef = useRef(wallets);
  walletsRef.current = wallets;
  const { colors } = useTheme();
  const [isLoading, setIsLoading] = useState(false);
  const [displayPsbt, setDisplayPsbt] = useState(psbt);
  const [review, setReview] = useState<BhwiPsbtReview & { cpfp?: BhwiCpfpContext }>();
  const [hardwareStatus, setHardwareStatus] = useState('');
  const [txHex, setTxHex] = useState<string | undefined>(hardwareBoundFlow ? undefined : routeParamsRef.current.txhex);
  const [hardwareRouteBound, setHardwareRouteBound] = useState(!hardwareBoundFlow || route.params.bhwiBound === true);
  const [hasStagedFileResult, setHasStagedFileResult] = useState(false);
  const openScannerButton = useRef<View | null>(null);
  const dynamicQRCode = useRef<DynamicQRCode | null>(null);
  const mountedRef = useRef(true);
  const foregroundRef = useRef(AppState.currentState === 'active');
  const isFocused = useIsFocused();
  const focusedRef = useRef(isFocused);
  const currentFocusRef = useRef(isFocused);
  currentFocusRef.current = isFocused;
  const attemptRef = useRef(0);
  const boundAttemptRef = useRef<BhwiPsbtAttemptSnapshot | undefined>(undefined);
  const verifiedAttemptRef = useRef<BhwiPsbtAttemptSnapshot | undefined>(undefined);
  const autoPreparationRef = useRef('');
  const handledReturnRef = useRef('');
  const allowedContinuationRef = useRef<'hardware' | 'scanner' | undefined>(undefined);
  const stagedFileResultRef = useRef<string | undefined>(undefined);
  const foregroundResumeRef = useRef<(() => void) | undefined>(undefined);

  const stylesHook = StyleSheet.create({
    scrollViewContent: {
      backgroundColor: colors.elevated,
    },
    rootPadding: {
      backgroundColor: colors.elevated,
    },
    hexWrap: {
      backgroundColor: colors.elevated,
    },
    hexLabel: {
      color: colors.foregroundColor,
    },
    hexInput: {
      borderColor: colors.formBorder,
      backgroundColor: colors.inputBackgroundColor,
      color: colors.foregroundColor,
    },
    hexText: {
      color: colors.foregroundColor,
    },
    review: {
      borderColor: colors.formBorder,
    },
    reviewSecondary: {
      color: colors.alternativeTextColor,
    },
  });

  const preparationIsCurrent = useCallback(
    (generation: number, sourceBase64: string, walletIdentity: string, associationIdentity: string) => {
      if (!mountedRef.current || !foregroundRef.current || !focusedRef.current || attemptRef.current !== generation) return false;
      const liveWallet = walletsRef.current.find(candidate => candidate.getID() === walletID);
      if (!(liveWallet instanceof WatchOnlyWallet)) return false;
      const liveAssociation = liveWallet.getHardwareWalletAssociation();
      if (!liveAssociation || bhwiAssociationIdentity(liveAssociation) !== associationIdentity) return false;
      if (bhwiWatchOnlyWalletIdentity(liveWallet, liveAssociation) !== walletIdentity) return false;
      try {
        const currentCpfp = requireBhwiCpfpContext(routeParamsRef.current.cpfp);
        const expectedCpfp = cpfpRouteSnapshotRef.current;
        const sameCpfp =
          currentCpfp?.parentFee === expectedCpfp.value?.parentFee &&
          currentCpfp?.parentVsize === expectedCpfp.value?.parentVsize &&
          currentCpfp?.targetFeeRate === expectedCpfp.value?.targetFeeRate;
        return (
          !expectedCpfp.invalid &&
          sameCpfp &&
          routeParamsPSBT.current?.toBase64() === sourceBase64 &&
          (!routeParamsRef.current.psbt || routeParamsRef.current.psbt.toBase64() === sourceBase64)
        );
      } catch {
        return false;
      }
    },
    [walletID],
  );

  const requireCurrentAttempt = useCallback(
    (expected: BhwiPsbtAttemptSnapshot) => {
      let routePsbtIsCurrent = true;
      try {
        routePsbtIsCurrent = !route.params.psbt || route.params.psbt.toBase64() === routeParamsPSBT.current?.toBase64();
      } catch {
        routePsbtIsCurrent = false;
      }
      if (
        !mountedRef.current ||
        !foregroundRef.current ||
        !focusedRef.current ||
        walletID !== expected.walletID ||
        !routePsbtIsCurrent ||
        routeParamsRef.current.bhwiBound !== true ||
        routeParamsRef.current.bhwiAttempt !== expected.generation ||
        routeParamsRef.current.bhwiOriginalBase64 !== expected.originalBase64
      ) {
        throw new Error(BHWI_SIGNING_SESSION_EXPIRED);
      }
      const liveWallet = walletsRef.current.find(candidate => candidate.getID() === expected.walletID);
      if (!(liveWallet instanceof WatchOnlyWallet)) throw new Error(BHWI_SIGNING_SESSION_EXPIRED);
      const liveAssociation = liveWallet.getHardwareWalletAssociation();
      if (expected.cpfp && !isAssociatedWatchOnlySegwitBech32(liveWallet)) throw new Error(BHWI_SIGNING_SESSION_EXPIRED);
      if (!liveAssociation) throw new Error(BHWI_SIGNING_SESSION_EXPIRED);
      const walletIdentity = bhwiWatchOnlyWalletIdentity(liveWallet, liveAssociation);
      let currentCpfp: BhwiCpfpContext | undefined;
      try {
        currentCpfp = requireBhwiCpfpContext(routeParamsRef.current.cpfp);
      } catch {
        throw new Error(BHWI_SIGNING_SESSION_EXPIRED);
      }
      const current =
        walletIdentity && bhwiAssociationIdentity(liveAssociation) === expected.associationIdentity
          ? { ...expected, walletIdentity, associationIdentity: bhwiAssociationIdentity(liveAssociation), cpfp: currentCpfp }
          : undefined;
      assertBhwiPsbtAttemptCurrent(expected, current);
      return { wallet: liveWallet, association: liveAssociation };
    },
    [route.params.psbt, walletID],
  );

  const expireHardwareAttempt = useCallback(() => {
    attemptRef.current += 1;
    boundAttemptRef.current = undefined;
    verifiedAttemptRef.current = undefined;
    setTxHex(undefined);
    setReview(undefined);
    setDisplayPsbt(routeParamsPSBT.current);
    setIsLoading(false);
    stagedFileResultRef.current = undefined;
    setHasStagedFileResult(false);
    if (!mountedRef.current) return;
    routeParamsRef.current = {
      ...routeParamsRef.current,
      bhwiBound: true,
      bhwiOriginalBase64: undefined,
      bhwiReturnedBase64: undefined,
      onBarScanned: undefined,
      deepLinkPSBT: undefined,
      txhex: undefined,
    };
    navigation.setParams({
      bhwiBound: true,
      bhwiOriginalBase64: undefined,
      bhwiReturnedBase64: undefined,
      onBarScanned: undefined,
      deepLinkPSBT: undefined,
      txhex: undefined,
    });
  }, [navigation]);

  const prepareHardwareSigning = useCallback(
    async (preserveStagedFileResult = false) => {
      const generation = ++attemptRef.current;
      boundAttemptRef.current = undefined;
      verifiedAttemptRef.current = undefined;
      setTxHex(undefined);
      setHardwareStatus('');
      setIsLoading(true);
      if (!preserveStagedFileResult) {
        stagedFileResultRef.current = undefined;
        setHasStagedFileResult(false);
      }
      try {
        const cpfpSnapshot = cpfpRouteSnapshotRef.current;
        if (cpfpSnapshot.invalid) throw new Error(BHWI_SIGNING_SESSION_EXPIRED);
        const walletCandidate = walletsRef.current.find(candidate => candidate.getID() === walletID);
        const source = routeParamsPSBT.current;
        if (!(walletCandidate instanceof WatchOnlyWallet) || !source) throw new Error(BHWI_SIGNING_SESSION_EXPIRED);
        if (!isBhwiAvailable()) throw new Error(loc.wallets.hardware_unavailable);
        const liveWallet = walletCandidate;
        const liveAssociation = liveWallet.getHardwareWalletAssociation();
        if (cpfpSnapshot.value && !isAssociatedWatchOnlySegwitBech32(liveWallet)) throw new Error(BHWI_SIGNING_SESSION_EXPIRED);
        if (!liveAssociation) throw new Error(BHWI_SIGNING_SESSION_EXPIRED);
        const walletIdentity = bhwiWatchOnlyWalletIdentity(liveWallet, liveAssociation);
        if (!walletIdentity) throw new Error(BHWI_SIGNING_SESSION_EXPIRED);
        const associationIdentity = bhwiAssociationIdentity(liveAssociation);
        const sourceBase64 = source.toBase64();
        const assertPreparationCurrent = () => {
          if (!preparationIsCurrent(generation, sourceBase64, walletIdentity, associationIdentity)) {
            throw new Error(BHWI_SIGNING_SESSION_EXPIRED);
          }
        };
        if (source.data.inputs.some(input => !input.nonWitnessUtxo)) {
          if (isElectrumDisabled) throw new Error(loc.errors.network);
          const connected = await BlueElectrum.ensureConnected();
          assertPreparationCurrent();
          if (!connected) throw new Error(loc.errors.network);
        }
        const hydrated = await hydrateBhwiPsbt(source, undefined, assertPreparationCurrent);
        assertPreparationCurrent();
        const originalBase64 = hydrated.toBase64();
        validateBhwiPsbtOriginal(originalBase64, liveWallet, liveAssociation);
        const baseReview = getBhwiPsbtReview(hydrated);
        const nextReview = Object.freeze({ ...baseReview, cpfp: cpfpSnapshot.value });
        const snapshot: BhwiPsbtAttemptSnapshot = Object.freeze({
          generation,
          originalBase64,
          walletID,
          walletIdentity,
          associationIdentity,
          policyIdentity: 'none',
          fee: nextReview.fee.toString(),
          cpfp: cpfpSnapshot.value,
        });
        boundAttemptRef.current = snapshot;
        setDisplayPsbt(hydrated);
        setReview(nextReview);
        routeParamsRef.current = {
          ...routeParamsRef.current,
          bhwiBound: true,
          bhwiOriginalBase64: originalBase64,
          bhwiAttempt: generation,
          bhwiReturnedBase64: undefined,
          txhex: undefined,
        };
        navigation.setParams({
          bhwiBound: true,
          bhwiOriginalBase64: originalBase64,
          bhwiAttempt: generation,
          bhwiReturnedBase64: undefined,
          txhex: undefined,
        });
      } catch (error) {
        if (attemptRef.current === generation && mountedRef.current && foregroundRef.current) {
          boundAttemptRef.current = undefined;
          stagedFileResultRef.current = undefined;
          setHasStagedFileResult(false);
          const message = error instanceof Error ? error.message : loc.wallets.hardware_operation_failed;
          setHardwareStatus(message);
        }
      } finally {
        if (attemptRef.current === generation && mountedRef.current) setIsLoading(false);
      }
    },
    [isElectrumDisabled, navigation, preparationIsCurrent, walletID],
  );

  const startHardwareSigning = useCallback(() => {
    const expected = boundAttemptRef.current;
    if (!expected) {
      prepareHardwareSigning().catch(() => undefined);
      return;
    }
    try {
      const { association: liveAssociation } = requireCurrentAttempt(expected);
      allowedContinuationRef.current = 'hardware';
      navigation.navigate('HardwareWalletAccount', {
        mode: 'sign-psbt',
        walletID: expected.walletID,
        hardwareAccount: liveAssociation,
        originalBase64: expected.originalBase64,
        attempt: expected.generation,
      });
    } catch (error) {
      expireHardwareAttempt();
      presentAlert({ message: error instanceof Error ? error.message : BHWI_SIGNING_SESSION_EXPIRED });
    }
  }, [expireHardwareAttempt, navigation, prepareHardwareSigning, requireCurrentAttempt]);

  const _combinePSBT = useCallback(
    (receivedPSBT: bitcoin.Psbt | string): bitcoin.Transaction | undefined => {
      const original = routeParamsPSBT.current;
      const liveWallet = walletsRef.current.find(candidate => candidate.getID() === walletID);
      if (!original || !(liveWallet instanceof WatchOnlyWallet)) throw new Error('No PSBT to combine');
      return liveWallet.combinePsbt(original, receivedPSBT);
    },
    [walletID],
  );

  const consumeBoundResult = useCallback(
    (returnedBase64: string, generation: number | undefined) => {
      const expected = boundAttemptRef.current;
      try {
        if (!expected || generation !== expected.generation) throw new Error(BHWI_SIGNING_SESSION_EXPIRED);
        const { wallet: liveWallet, association: liveAssociation } = requireCurrentAttempt(expected);
        const result = validateBhwiBoundPsbt(routeParamsRef.current.bhwiOriginalBase64, returnedBase64, liveWallet, liveAssociation);
        requireCurrentAttempt(expected);
        const returnedReview = getBhwiPsbtReview(result.psbt);
        if (returnedReview.fee.toString() !== expected.fee) throw new Error(BHWI_SIGNING_SESSION_EXPIRED);
        if (result.tx && expected.cpfp) assertBhwiCpfpPackageTarget(expected.cpfp, returnedReview.fee, result.tx);
        setDisplayPsbt(result.psbt);
        if (result.tx) {
          verifiedAttemptRef.current = expected;
          setTxHex(result.tx.toHex());
        } else {
          verifiedAttemptRef.current = undefined;
          setTxHex(undefined);
        }
        routeParamsRef.current = {
          ...routeParamsRef.current,
          bhwiReturnedBase64: undefined,
          deepLinkPSBT: undefined,
          onBarScanned: undefined,
          txhex: undefined,
        };
        navigation.setParams({
          bhwiReturnedBase64: undefined,
          deepLinkPSBT: undefined,
          onBarScanned: undefined,
          txhex: undefined,
        });
        if (result.tx && launchedBy) {
          navigation.dispatch(StackActions.popTo(launchedBy, { psbt: result.psbt }, { merge: true }));
        }
      } catch (error) {
        expireHardwareAttempt();
        presentAlert({ message: error instanceof Error ? error.message : BHWI_SIGNING_SESSION_EXPIRED });
      }
    },
    [expireHardwareAttempt, launchedBy, navigation, requireCurrentAttempt],
  );

  const onBarScanned = useCallback(
    (ret: string | { data: string }) => {
      const data = typeof ret === 'string' ? ret : ret.data;
      if (hardwareBoundFlow || routeParamsRef.current.bhwiBound) {
        consumeBoundResult(data, routeParamsRef.current.bhwiAttempt);
        return;
      }
      if (data.toUpperCase().startsWith('UR')) {
        presentAlert({ message: 'BC-UR not decoded. This should never happen' });
      }
      if (!data.includes('+') && !data.includes('=')) {
        setTxHex(data);
        return;
      }
      try {
        const transaction = _combinePSBT(data);
        setTxHex(transaction?.toHex());
        if (transaction && launchedBy) {
          const original = routeParamsPSBT.current;
          navigation.dispatch(StackActions.popTo(launchedBy, { psbt: original }, { merge: true }));
        }
      } catch (error) {
        console.log('error in _combinePSBT():', error);
        presentAlert({ message: error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error' });
      }
    },
    [_combinePSBT, consumeBoundResult, hardwareBoundFlow, launchedBy, navigation],
  );

  useEffect(() => {
    focusedRef.current = isFocused;
    if (isFocused) {
      allowedContinuationRef.current = undefined;
      dynamicQRCode.current?.startAutoMove();
      return;
    }
    dynamicQRCode.current?.stopAutoMove();
    if (allowedContinuationRef.current) {
      allowedContinuationRef.current = undefined;
      return;
    }
    if (hardwareBoundFlow) {
      expireHardwareAttempt();
      setHardwareStatus(BHWI_SIGNING_SESSION_EXPIRED);
    }
  }, [expireHardwareAttempt, hardwareBoundFlow, isFocused]);

  useEffect(() => {
    mountedRef.current = true;
    foregroundRef.current = AppState.currentState === 'active';
    focusedRef.current = currentFocusRef.current;
    if (hardwareBoundFlow) {
      navigation.setParams({ bhwiBound: true, txhex: undefined });
      setHardwareRouteBound(true);
    }
    enableScreenProtect();
    const appState = AppState.addEventListener('change', nextState => {
      foregroundRef.current = nextState === 'active';
      if (foregroundRef.current) {
        const resume = foregroundResumeRef.current;
        foregroundResumeRef.current = undefined;
        resume?.();
        return;
      }
      if (hardwareBoundFlow || boundAttemptRef.current || verifiedAttemptRef.current || routeParamsRef.current.bhwiBound) {
        expireHardwareAttempt();
        setHardwareStatus(BHWI_SIGNING_SESSION_EXPIRED);
      }
    });
    return () => {
      mountedRef.current = false;
      foregroundRef.current = false;
      focusedRef.current = false;
      attemptRef.current += 1;
      boundAttemptRef.current = undefined;
      verifiedAttemptRef.current = undefined;
      autoPreparationRef.current = '';
      appState.remove();
      disableScreenProtect();
      stagedFileResultRef.current = undefined;
      const resume = foregroundResumeRef.current;
      foregroundResumeRef.current = undefined;
      resume?.();
    };
  }, [disableScreenProtect, enableScreenProtect, expireHardwareAttempt, hardwareBoundFlow, navigation]);

  useEffect(() => {
    if (!association || !psbt || !isFocused || !hardwareRouteBound) return;
    const key = `${psbt.toBase64()}\0${bhwiAssociationIdentity(association)}`;
    if (autoPreparationRef.current === key) return;
    autoPreparationRef.current = key;
    prepareHardwareSigning().catch(() => undefined);
  }, [association, hardwareRouteBound, isFocused, prepareHardwareSigning, psbt]);

  useEffect(() => {
    const {
      bhwiBound,
      bhwiOriginalBase64,
      bhwiReturnedBase64,
      bhwiAttempt,
      deepLinkPSBT,
      onBarScanned: scanned,
      txhex,
    } = routeParamsRef.current;
    const hasReturnedValue = !!(bhwiReturnedBase64 || deepLinkPSBT || scanned || txhex);
    if (bhwiBound && !bhwiOriginalBase64 && !hasReturnedValue && (!hardwareBoundFlow || !psbt)) {
      const key = `missing:${String(bhwiAttempt)}`;
      if (handledReturnRef.current !== key) {
        handledReturnRef.current = key;
        expireHardwareAttempt();
        presentAlert({ message: BHWI_SIGNING_SESSION_EXPIRED });
      }
      return;
    }
    if (bhwiReturnedBase64) {
      const key = `direct:${String(bhwiAttempt)}:${bhwiReturnedBase64}`;
      if (handledReturnRef.current !== key) {
        handledReturnRef.current = key;
        consumeBoundResult(bhwiReturnedBase64, bhwiAttempt);
      }
    }
  }, [consumeBoundResult, expireHardwareAttempt, hardwareBoundFlow, psbt, route.params]);

  useEffect(() => {
    const expected = boundAttemptRef.current;
    if (!expected || !isFocused) return;
    try {
      requireCurrentAttempt(expected);
    } catch {
      expireHardwareAttempt();
      setHardwareStatus(BHWI_SIGNING_SESSION_EXPIRED);
    }
  }, [currentWalletIdentity, expireHardwareAttempt, isFocused, requireCurrentAttempt, route.params.cpfp]);

  useEffect(() => {
    const data = routeParamsRef.current.onBarScanned;
    const bhwiBound = hardwareBoundFlow || route.params.bhwiBound === true || routeParamsRef.current.bhwiBound === true;
    const bhwiAttempt = route.params.bhwiAttempt ?? routeParamsRef.current.bhwiAttempt;
    if (!data) return;
    if (bhwiBound) {
      consumeBoundResult(data, bhwiAttempt);
      return;
    }
    onBarScanned({ data });
    navigation.setParams({ onBarScanned: undefined });
  }, [
    consumeBoundResult,
    hardwareBoundFlow,
    navigation,
    onBarScanned,
    route.params.bhwiAttempt,
    route.params.bhwiBound,
    route.params.onBarScanned,
  ]);

  useEffect(() => {
    const { deepLinkPSBT, txhex } = routeParamsRef.current;
    const bhwiBound = hardwareBoundFlow || route.params.bhwiBound === true || routeParamsRef.current.bhwiBound === true;
    const bhwiAttempt = route.params.bhwiAttempt ?? routeParamsRef.current.bhwiAttempt;
    if (deepLinkPSBT) {
      const key = `deeplink:${String(bhwiAttempt)}:${deepLinkPSBT}`;
      if (handledReturnRef.current === key) return;
      handledReturnRef.current = key;
      if (bhwiBound) {
        consumeBoundResult(deepLinkPSBT, bhwiAttempt);
        return;
      }
      try {
        if (routeParamsPSBT.current) {
          const transaction = _combinePSBT(bitcoin.Psbt.fromBase64(deepLinkPSBT, { network }));
          setTxHex(transaction?.toHex());
        }
      } catch (error) {
        console.log('error in wallet.combinePsbt():', error);
        presentAlert({ message: error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error' });
      }
    } else if (txhex) {
      if (bhwiBound) consumeBoundResult(txhex, bhwiAttempt);
      else setTxHex(txhex);
    }
  }, [
    _combinePSBT,
    consumeBoundResult,
    hardwareBoundFlow,
    route.params.bhwiAttempt,
    route.params.bhwiBound,
    route.params.deepLinkPSBT,
    route.params.txhex,
  ]);

  useEffect(() => {
    if (!psbt && !route.params.txhex) presentAlert({ message: loc.send.no_tx_signing_in_progress });
  }, [psbt, route.params.txhex]);

  const broadcast = async () => {
    const expected = verifiedAttemptRef.current;
    const requireBroadcastAttempt = () => {
      if (expected) {
        if (verifiedAttemptRef.current !== expected) throw new Error(BHWI_SIGNING_SESSION_EXPIRED);
        requireCurrentAttempt(expected);
      }
    };
    setIsLoading(true);
    try {
      if (!txHex) throw new Error('No transaction hex available');
      const isBiometricsEnabled = await isBiometricUseCapableAndEnabled();
      requireBroadcastAttempt();
      if (isBiometricsEnabled) {
        const unlocked = await unlockWithBiometrics();
        requireBroadcastAttempt();
        if (!unlocked) {
          setIsLoading(false);
          return;
        }
      }
      const connected = await BlueElectrum.ensureConnected();
      requireBroadcastAttempt();
      if (!connected) throw new Error(loc.errors.network);
      const liveWallet = walletsRef.current.find(candidate => candidate.getID() === walletID);
      if (!(liveWallet instanceof WatchOnlyWallet)) throw new Error(BHWI_SIGNING_SESSION_EXPIRED);
      const txDecoded = bitcoin.Transaction.fromHex(txHex);
      if (expected?.cpfp) {
        assertBhwiCpfpPackageTarget(expected.cpfp, BigInt(expected.fee), txDecoded);
      }
      const result = await liveWallet.broadcastTx(txHex);
      requireBroadcastAttempt();
      if (!result) {
        triggerHapticFeedback(HapticFeedbackTypes.NotificationError);
        throw new Error(loc.errors.broadcast);
      }
      setIsLoading(false);
      const txid = txDecoded.getId();
      majorTomToGroundControl([], [], [txid]);
      if (memo) txMetadata[txid] = { memo };
      if (expected) {
        fetchAndSaveWalletTransactions(liveWallet.getID());
        navigation.navigate('Success', { amount: 0 });
        return;
      }
      navigation.navigate('Success', { amount: 0 });
      await new Promise<void>(resolve => {
        setTimeout(resolve, 3000);
      });
      if (expected && !mountedRef.current) return;
      requireBroadcastAttempt();
      fetchAndSaveWalletTransactions(liveWallet.getID());
    } catch (error) {
      triggerHapticFeedback(HapticFeedbackTypes.NotificationError);
      if (mountedRef.current) {
        setIsLoading(false);
        console.log('error broadcasting:', error);
        if (expected) expireHardwareAttempt();
        presentAlert({ message: error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error' });
      }
    }
  };

  const handleOnVerifyPressed = () => {
    Linking.openURL('https://coinb.in/?verify=' + txHex);
  };

  const copyHexToClipboard = () => {
    if (txHex) Clipboard.setString(txHex);
  };

  const renderBroadcastHex = () => (
    <View style={[styles.rootPadding, stylesHook.rootPadding]}>
      <BlueCard style={[styles.hexWrap, stylesHook.hexWrap]}>
        <BlueText style={[styles.hexLabel, stylesHook.hexLabel]}>{loc.send.create_this_is_hex}</BlueText>
        <TextInput style={[styles.hexInput, stylesHook.hexInput]} multiline editable={false} value={txHex} />
        <TouchableOpacity accessibilityRole="button" style={styles.hexTouch} onPress={copyHexToClipboard}>
          <Text style={[styles.hexText, stylesHook.hexText]}>{loc.send.create_copy}</Text>
        </TouchableOpacity>
        <TouchableOpacity accessibilityRole="button" style={styles.hexTouch} onPress={handleOnVerifyPressed}>
          <Text style={[styles.hexText, stylesHook.hexText]}>{loc.send.create_verify}</Text>
        </TouchableOpacity>
        <BlueSpacing20 />
        <SecondButton
          disabled={isElectrumDisabled}
          onPress={broadcast}
          title={loc.send.confirm_sendNow}
          testID="PsbtWithHardwareWalletBroadcastTransactionButton"
        />
      </BlueCard>
    </View>
  );

  const saveFileButtonBeforeOnPress = () => {
    dynamicQRCode.current?.stopAutoMove();
  };

  const saveFileButtonAfterOnPress = () => {
    dynamicQRCode.current?.startAutoMove();
  };

  const onOpenSignedTransaction = async () => {
    try {
      const file = await openSignedTransactionRaw();
      if (!hardwareBoundFlow) {
        if (file) onBarScanned({ data: file });
        return;
      }
      if (!file) return;
      if (!foregroundRef.current) {
        await new Promise<void>(resolve => {
          foregroundResumeRef.current = resolve;
        });
      }
      if (!mountedRef.current || !foregroundRef.current || !focusedRef.current) {
        throw new Error(BHWI_SIGNING_SESSION_EXPIRED);
      }
      stagedFileResultRef.current = file;
      setHasStagedFileResult(true);
      await prepareHardwareSigning(true);
    } catch (error) {
      stagedFileResultRef.current = undefined;
      if (mountedRef.current) {
        setHasStagedFileResult(false);
        expireHardwareAttempt();
        presentAlert({ message: error instanceof Error ? error.message : BHWI_SIGNING_SESSION_EXPIRED });
      }
    }
  };

  const confirmStagedFileResult = () => {
    const returnedBase64 = stagedFileResultRef.current;
    const expected = boundAttemptRef.current;
    stagedFileResultRef.current = undefined;
    setHasStagedFileResult(false);
    if (!returnedBase64 || !expected) {
      expireHardwareAttempt();
      presentAlert({ message: BHWI_SIGNING_SESSION_EXPIRED });
      return;
    }
    consumeBoundResult(returnedBase64, expected.generation);
  };

  const openScanner = () => {
    allowedContinuationRef.current = 'scanner';
    navigation.navigate('ScanQRCode', { showFileImportButton: true });
  };

  if (txHex) return renderBroadcastHex();
  const hardwareControlsReady = !hardwareBoundFlow || !!boundAttemptRef.current;
  const hardwareStatusMessage =
    hardwareStatus ||
    (!isBhwiAvailable()
      ? loc.wallets.hardware_unavailable
      : (!association || !psbt) && hardwareBoundFlow
        ? BHWI_SIGNING_SESSION_EXPIRED
        : '');

  const renderView = isLoading ? (
    <ActivityIndicator />
  ) : (
    <View style={styles.container}>
      <BlueCard>
        {hardwareBoundFlow && review && (
          <View style={[styles.review, stylesHook.review]} testID="BhwiTransactionReview">
            <BlueText bold>{loc.send.psbt_hardware_review}</BlueText>
            {review.outputs.map((output, index) => (
              <View key={`${output.destination}:${index}`} style={styles.reviewOutput}>
                <BlueText selectable>{output.destination}</BlueText>
                <BlueText selectable style={stylesHook.reviewSecondary}>
                  {loc.formatString(loc.send.psbt_hardware_output_value, { value: output.value.toString() })}
                </BlueText>
              </View>
            ))}
            <BlueText bold>{loc.formatString(loc.send.psbt_hardware_fee, { fee: review.fee.toString() })}</BlueText>
            <BlueSpacing10 />
            {hasStagedFileResult && (
              <>
                <SecondButton testID="BhwiVerifyStagedFile" title={loc.send.psbt_hardware_verify_file} onPress={confirmStagedFileResult} />
                <BlueSpacing10 />
              </>
            )}
            <SecondButton testID="BhwiSignPsbt" title={loc.wallets.hardware_sign_transaction} onPress={startHardwareSigning} />
          </View>
        )}
        {hardwareBoundFlow && !review && (
          <>
            <SecondButton
              testID="BhwiPreparePsbt"
              title={loc.send.psbt_hardware_prepare}
              onPress={() => prepareHardwareSigning().catch(() => undefined)}
              disabled={!association || !psbt || !isBhwiAvailable() || !hardwareRouteBound}
            />
            {!!hardwareStatusMessage && (
              <BlueText testID="BhwiHardwareStatus" style={stylesHook.reviewSecondary}>
                {hardwareStatusMessage}
              </BlueText>
            )}
            <BlueSpacing10 />
          </>
        )}
        {hardwareControlsReady && (
          <>
            <BlueText testID="TextHelperForPSBT">{loc.send.psbt_this_is_psbt}</BlueText>
            <BlueSpacing10 />
            <Text testID="PSBTHex" style={styles.hidden}>
              {displayPsbt?.toHex()}
            </Text>
            {displayPsbt && <DynamicQRCode value={displayPsbt.toHex()} ref={dynamicQRCode} walletID={walletID} />}
            <BlueSpacing10 />
            <SecondButton
              testID="PsbtTxScanButton"
              icon={{ name: 'qrcode', type: 'font-awesome', color: colors.secondButtonTextColor }}
              onPress={openScanner}
              ref={openScannerButton}
              title={loc.send.psbt_tx_scan}
            />
            <BlueSpacing10 />
            <SecondButton
              testID="PsbtTxOpenButton"
              icon={{ name: 'login', type: 'entypo', color: colors.secondButtonTextColor }}
              onPress={onOpenSignedTransaction}
              title={loc.send.psbt_tx_open}
            />
            <BlueSpacing10 />
            {displayPsbt && (
              <SecondButton
                testID="PsbtViewRawButton"
                icon={{ name: 'code', type: 'font-awesome', color: colors.secondButtonTextColor }}
                onPress={() => {
                  navigation.navigate('PsbtRaw', { psbtBase64: displayPsbt.toBase64() });
                }}
                title={loc.send.psbt_view_raw}
              />
            )}
            <BlueSpacing10 />
            {displayPsbt && (
              <SaveFileButton
                fileName={`${Date.now()}.psbt`}
                fileContent={displayPsbt.toBase64()}
                beforeOnPress={saveFileButtonBeforeOnPress}
                afterOnPress={saveFileButtonAfterOnPress}
                style={styles.exportButton}
              >
                <SecondButton
                  icon={{ name: 'share-alternative', type: 'entypo', color: colors.secondButtonTextColor }}
                  title={loc.send.psbt_tx_export}
                />
              </SaveFileButton>
            )}
            <BlueSpacing10 />
            {displayPsbt && (
              <View style={styles.copyToClipboard}>
                <CopyToClipboardButton stringToCopy={displayPsbt.toBase64()} displayText={loc.send.psbt_clipboard} />
              </View>
            )}
          </>
        )}
      </BlueCard>
    </View>
  );

  return (
    <ScrollView
      centerContent
      style={stylesHook.scrollViewContent}
      automaticallyAdjustContentInsets
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={[styles.scrollViewContent, stylesHook.scrollViewContent]}
      testID="PsbtWithHardwareScrollView"
    >
      {renderView}
    </ScrollView>
  );
};

export default PsbtWithHardwareWallet;

const styles = StyleSheet.create({
  scrollViewContent: {
    flexGrow: 1,
    justifyContent: 'space-between',
  },
  container: {
    flexDirection: 'row',
    justifyContent: 'center',
    paddingTop: 16,
    paddingBottom: 16,
  },
  exportButton: {
    alignSelf: 'stretch',
    width: '100%',
  },
  review: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    marginBottom: 16,
    padding: 12,
  },
  reviewOutput: {
    marginVertical: 8,
  },
  rootPadding: {
    flex: 1,
    paddingTop: 20,
  },
  hexWrap: {
    alignItems: 'center',
    flex: 1,
    width: '100%',
  },
  hexLabel: {
    fontWeight: '500',
  },
  hexInput: {
    alignSelf: 'stretch',
    borderRadius: 4,
    marginTop: 20,
    maxHeight: 220,
    minHeight: 120,
    fontWeight: '500',
    fontSize: 14,
    paddingHorizontal: 16,
    paddingBottom: 16,
    paddingTop: 16,
  },
  hexTouch: {
    marginVertical: 24,
  },
  hexText: {
    fontSize: 15,
    fontWeight: '500',
    alignSelf: 'center',
  },
  copyToClipboard: {
    marginVertical: 16,
    justifyContent: 'center',
    alignItems: 'center',
  },
  hidden: {
    width: 0,
    height: 0,
  },
});
