import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RouteProp, StackActions, useIsFocused, useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import BigNumber from 'bignumber.js';
import * as bitcoin from 'bitcoinjs-lib';
import { Buffer } from 'buffer';
import {
  AppState,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  ListRenderItemInfo,
  NativeSyntheticEvent,
  LayoutRectangle,
  NodeHandle,
} from 'react-native';
import Icon from '../../components/Icon';

import { satoshiToBTC, satoshiToLocalCurrency } from '../../blue_modules/currency';
import BlueCard from '../../components/BlueCard';
import BlueText from '../../components/BlueText';
import presentAlert from '../../components/Alert';
import Button from '../../components/Button';
import SafeArea from '../../components/SafeArea';
import { useTheme } from '../../components/themes';
import loc from '../../loc';
import { BitcoinUnit } from '../../models/bitcoinUnits';
import { useStorage } from '../../hooks/context/useStorage';
import { combinePSBTs } from '../../util/combinePSBTs.ts';
import { MultisigHDWallet } from '../../class/wallets/multisig-hd-wallet';
import { mainnetServicesEnabled, network } from '../../models/bitcoinNetwork';
import type { SendDetailsStackParamList } from '../../navigation/SendDetailsStackParamList';
import {
  BHWI_SIGNING_SESSION_EXPIRED,
  assertBhwiPsbtContinuationToken,
  bhwiAssociationIdentity,
  bhwiMultisigPolicyIdentity,
  bhwiMultisigWalletIdentity,
  getBhwiHardwareMobilePolicy,
  getBhwiPsbtReview,
  getUnsignedBhwiMultisigPsbt,
  hydrateBhwiPsbt,
} from '../../blue_modules/bhwiPsbt';
import type { BhwiHardwareMobilePolicy, BhwiPsbtAttemptSnapshot } from '../../blue_modules/bhwiPsbt';
import { addBhwiHostActiveListener, isBhwiAvailable } from '../../blue_modules/bhwi';
import { validateBhwiPsbt, validateBhwiPsbtOriginal } from '../../blue_modules/validateBhwiPsbt';
import { useScreenProtect } from '../../hooks/useScreenProtect';
import { useSettings } from '../../hooks/context/useSettings';

type NavigationProps = NativeStackNavigationProp<SendDetailsStackParamList, 'PsbtMultisig'>;
type SigningActor = 'phone' | 'hardware' | 'both';
type HardwareAttempt = BhwiPsbtAttemptSnapshot & { acceptedBase64: string };
type QrAttempt = BhwiPsbtAttemptSnapshot & { acceptedBase64: string; token: string };
type StagedQrResult = Readonly<{ returnedBase64: string; attempt: QrAttempt }>;

type AcceptedPsbt = {
  psbt: bitcoin.Psbt;
  unsignedBase64: string;
  actor?: SigningActor;
  exportPsbt?: bitcoin.Psbt;
  pendingActor?: Exclude<SigningActor, 'both'>;
  error?: string;
};

const acceptInitialHardwareMobilePsbt = (
  source: bitcoin.Psbt,
  wallet: MultisigHDWallet,
  policy: BhwiHardwareMobilePolicy,
): AcceptedPsbt => {
  try {
    const unsigned = getUnsignedBhwiMultisigPsbt(source);
    const unsignedBase64 = unsigned.toBase64();
    validateBhwiPsbtOriginal(unsignedBase64, wallet, policy.phone);
    validateBhwiPsbtOriginal(unsignedBase64, wallet, policy.association);
    const hasSignatures = source.data.inputs.some(
      input => !!input.finalScriptSig || !!input.finalScriptWitness || !!input.partialSig?.length || !!input.tapKeySig,
    );
    if (!hasSignatures) return { psbt: unsigned, unsignedBase64 };
    for (const [actor, signer] of [
      ['phone', policy.phone],
      ['hardware', policy.association],
    ] as const) {
      try {
        const result = validateBhwiPsbt(unsignedBase64, source.toBase64(), wallet, signer);
        return result.selectedSignerSignedAllInputs
          ? { psbt: result.psbt, unsignedBase64, actor }
          : {
              psbt: result.continuationPsbt,
              exportPsbt: result.psbt,
              unsignedBase64,
              pendingActor: actor,
            };
      } catch {}
    }
    throw new Error('The existing multisig signature is invalid.');
  } catch (error) {
    return {
      psbt: source,
      unsignedBase64: '',
      error: error instanceof Error ? error.message : loc.send.invalid_psbt,
    };
  }
};

const PsbtMultisig = () => {
  const { wallets } = useStorage();
  const { colors } = useTheme();
  const { isElectrumDisabled } = useSettings();
  const { enableScreenProtect, disableScreenProtect } = useScreenProtect();
  const navigation = useNavigation<NavigationProps>();
  const { navigate, setParams, dispatch } = navigation;
  const route = useRoute<RouteProp<SendDetailsStackParamList, 'PsbtMultisig'>>();
  const routeParamsRef = useRef(route.params);
  routeParamsRef.current = { ...routeParamsRef.current, ...route.params };
  const { walletID, psbtBase64, memo, receivedPSBTBase64, txhex, launchedBy, multisigContinuation, bhwiBound } = routeParamsRef.current;
  const walletCandidate = wallets.find(candidate => candidate.getID() === walletID);
  const wallet = walletCandidate instanceof MultisigHDWallet ? walletCandidate : undefined;
  const policy = wallet ? getBhwiHardwareMobilePolicy(wallet) : undefined;
  const initialized = useRef(false);
  const initial = useRef<AcceptedPsbt | undefined>(undefined);
  if (!initialized.current) {
    initialized.current = true;
    try {
      const source = bitcoin.Psbt.fromBase64(psbtBase64, { network });
      initial.current = wallet && policy ? acceptInitialHardwareMobilePsbt(source, wallet, policy) : { psbt: source, unsignedBase64: '' };
    } catch (error) {
      console.error('Error loading initial PSBT:', error);
      initial.current = undefined;
    }
  }
  const hardwareBound = useRef(!!policy || bhwiBound === true).current;
  const [psbt, setPsbt] = useState(initial.current?.psbt ?? null);
  const [actor, setActor] = useState<SigningActor | undefined>(initial.current?.actor);
  const [pendingActor, setPendingActor] = useState<'phone' | 'hardware' | undefined>(initial.current?.pendingActor);
  const [hardwareStatus, setHardwareStatus] = useState(
    initial.current?.error ?? (initial.current?.pendingActor ? loc.multisig.partial_signature_incomplete : ''),
  );
  const [isHardwareLoading, setIsHardwareLoading] = useState(false);
  const [verifiedTxHex, setVerifiedTxHex] = useState<string>();
  const [hasStagedQrResult, setHasStagedQrResult] = useState(false);
  const [flatListHeight, setFlatListHeight] = useState(0);
  const [isFiltered, setIsFiltered] = useState(true);
  const psbtRef = useRef(psbt);
  psbtRef.current = psbt;
  const actorRef = useRef(actor);
  actorRef.current = actor;
  const pendingActorRef = useRef(pendingActor);
  pendingActorRef.current = pendingActor;
  const partialExportRef = useRef(initial.current?.exportPsbt);
  const pendingBaseRef = useRef(initial.current?.pendingActor ? initial.current.unsignedBase64 : undefined);
  const reviewedOriginalRef = useRef(initial.current?.unsignedBase64);
  const attemptRef = useRef(0);
  const hardwareAttemptRef = useRef<HardwareAttempt | undefined>(undefined);
  const mountedRef = useRef(true);
  const foregroundRef = useRef(AppState.currentState === 'active');
  const isFocused = useIsFocused();
  const focusedRef = useRef(isFocused);
  focusedRef.current = isFocused;
  const walletsRef = useRef(wallets);
  walletsRef.current = wallets;
  const allowedContinuationRef = useRef<'hardware' | 'qr' | undefined>(undefined);
  const handledHardwareReturnRef = useRef('');
  const qrGenerationRef = useRef(0);
  const qrAttemptRef = useRef<QrAttempt | undefined>(undefined);
  const stagedQrResultRef = useRef<StagedQrResult | undefined>(undefined);
  const foregroundResumeRef = useRef<(() => void) | undefined>(undefined);
  const initialBindingRef = useRef(
    wallet && policy
      ? {
          walletIdentity: bhwiMultisigWalletIdentity(wallet, policy.association),
          associationIdentity: bhwiAssociationIdentity(policy.association),
          policyIdentity: bhwiMultisigPolicyIdentity(wallet, policy.association),
        }
      : undefined,
  );

  const expireHardwareAttempt = useCallback(
    (message = BHWI_SIGNING_SESSION_EXPIRED) => {
      attemptRef.current += 1;
      hardwareAttemptRef.current = undefined;
      qrGenerationRef.current += 1;
      qrAttemptRef.current = undefined;
      stagedQrResultRef.current = undefined;
      setHasStagedQrResult(false);
      setVerifiedTxHex(undefined);
      setIsHardwareLoading(false);
      if (hardwareBound) setHardwareStatus(message);
      routeParamsRef.current = {
        ...routeParamsRef.current,
        bhwiOriginalBase64: undefined,
        bhwiReturnedBase64: undefined,
        bhwiAttempt: undefined,
        multisigContinuation: undefined,
        onBarScannedFromPicker: undefined,
        receivedPSBTBase64: undefined,
        txhex: undefined,
      };
      if (mountedRef.current) {
        setParams({
          bhwiOriginalBase64: undefined,
          bhwiReturnedBase64: undefined,
          bhwiAttempt: undefined,
          multisigContinuation: undefined,
          onBarScannedFromPicker: undefined,
          receivedPSBTBase64: undefined,
          txhex: undefined,
        });
      }
    },
    [hardwareBound, setParams],
  );

  const liveBinding = useCallback(() => {
    const liveWallet = walletsRef.current.find(candidate => candidate.getID() === walletID);
    if (!(liveWallet instanceof MultisigHDWallet)) return undefined;
    const livePolicy = getBhwiHardwareMobilePolicy(liveWallet);
    if (!livePolicy) return undefined;
    const walletIdentity = bhwiMultisigWalletIdentity(liveWallet, livePolicy.association);
    const policyIdentity = bhwiMultisigPolicyIdentity(liveWallet, livePolicy.association);
    if (!walletIdentity || !policyIdentity) return undefined;
    return {
      wallet: liveWallet,
      policy: livePolicy,
      walletIdentity,
      associationIdentity: bhwiAssociationIdentity(livePolicy.association),
      policyIdentity,
    };
  }, [walletID]);

  const mintQrAttempt = useCallback((): QrAttempt => {
    const current = liveBinding();
    const originalBase64 = reviewedOriginalRef.current;
    const accepted = psbtRef.current;
    if (!current || !originalBase64 || !accepted || !mountedRef.current || !foregroundRef.current || !focusedRef.current) {
      throw new Error(BHWI_SIGNING_SESSION_EXPIRED);
    }
    validateBhwiPsbtOriginal(originalBase64, current.wallet, current.policy.association);
    const generation = ++qrGenerationRef.current;
    const snapshot: QrAttempt = Object.freeze({
      generation,
      token: `qr-${generation}`,
      originalBase64,
      acceptedBase64: accepted.toBase64(),
      walletID,
      walletIdentity: current.walletIdentity,
      associationIdentity: current.associationIdentity,
      policyIdentity: current.policyIdentity,
      fee: getBhwiPsbtReview(bitcoin.Psbt.fromBase64(originalBase64, { network })).fee.toString(),
    });
    qrAttemptRef.current = snapshot;
    return snapshot;
  }, [liveBinding, walletID]);

  const openQrContinuation = useCallback(
    (source: bitcoin.Psbt, showOpenScanner: boolean) => {
      const snapshot = mintQrAttempt();
      allowedContinuationRef.current = 'qr';
      navigate('PsbtMultisigQRCode', {
        walletID,
        psbtBase64: source.toBase64(),
        isShowOpenScanner: showOpenScanner,
        multisigContinuation: snapshot.token,
      });
    },
    [mintQrAttempt, navigate, walletID],
  );

  const qrContinuationIsCurrent = useCallback(
    (expected: QrAttempt, token: string | undefined) => {
      const current = liveBinding();
      try {
        assertBhwiPsbtContinuationToken(expected.token, token);
      } catch {
        return undefined;
      }
      if (
        qrAttemptRef.current !== expected ||
        qrGenerationRef.current !== expected.generation ||
        !mountedRef.current ||
        !foregroundRef.current ||
        !focusedRef.current ||
        psbtRef.current?.toBase64() !== expected.acceptedBase64 ||
        reviewedOriginalRef.current !== expected.originalBase64 ||
        !current ||
        current.walletIdentity !== expected.walletIdentity ||
        current.associationIdentity !== expected.associationIdentity ||
        current.policyIdentity !== expected.policyIdentity ||
        getBhwiPsbtReview(bitcoin.Psbt.fromBase64(expected.originalBase64, { network })).fee.toString() !== expected.fee
      ) {
        return undefined;
      }
      return current;
    },
    [liveBinding],
  );

  const attemptIsCurrent = useCallback(
    (expected: HardwareAttempt) => {
      if (
        !mountedRef.current ||
        !foregroundRef.current ||
        !focusedRef.current ||
        attemptRef.current !== expected.generation ||
        psbtRef.current?.toBase64() !== expected.acceptedBase64 ||
        routeParamsRef.current.bhwiAttempt !== expected.generation ||
        routeParamsRef.current.bhwiOriginalBase64 !== expected.originalBase64
      ) {
        return undefined;
      }
      const current = liveBinding();
      if (
        !current ||
        current.walletIdentity !== expected.walletIdentity ||
        current.associationIdentity !== expected.associationIdentity ||
        current.policyIdentity !== expected.policyIdentity
      ) {
        return undefined;
      }
      return current;
    },
    [liveBinding],
  );

  const applyVerifiedTransition = useCallback(
    (returnedBase64: string, signer: 'phone' | 'hardware', expected?: HardwareAttempt) => {
      const current = expected ? attemptIsCurrent(expected) : liveBinding();
      const original = expected?.originalBase64 ?? psbtRef.current?.toBase64();
      if (!current || !original || !psbtRef.current) throw new Error(BHWI_SIGNING_SESSION_EXPIRED);
      const selectedSigner = signer === 'phone' ? current.policy.phone : current.policy.association;
      const result = validateBhwiPsbt(original, returnedBase64, current.wallet, selectedSigner);
      if (expected && !attemptIsCurrent(expected)) throw new Error(BHWI_SIGNING_SESSION_EXPIRED);
      const completedStage = result.selectedSignerSignedAllInputs;
      const previousActor = actorRef.current;
      const nextActor: SigningActor | undefined = completedStage
        ? previousActor === undefined || previousActor === signer
          ? signer
          : 'both'
        : previousActor;
      const nextPending = completedStage ? undefined : signer;
      const nextPsbt = completedStage ? result.psbt : result.continuationPsbt;
      psbtRef.current = nextPsbt;
      partialExportRef.current = completedStage ? undefined : result.psbt;
      actorRef.current = nextActor;
      pendingActorRef.current = nextPending;
      pendingBaseRef.current = completedStage ? undefined : original;
      setPsbt(nextPsbt);
      setActor(nextActor);
      setPendingActor(nextPending);
      setVerifiedTxHex(completedStage ? result.tx?.toHex() : undefined);
      setHardwareStatus(completedStage ? '' : loc.multisig.partial_signature_incomplete);
      hardwareAttemptRef.current = undefined;
      qrGenerationRef.current += 1;
      qrAttemptRef.current = undefined;
      stagedQrResultRef.current = undefined;
      setHasStagedQrResult(false);
      routeParamsRef.current = {
        ...routeParamsRef.current,
        bhwiReturnedBase64: undefined,
        receivedPSBTBase64: undefined,
        txhex: undefined,
        multisigContinuation: undefined,
        onBarScannedFromPicker: undefined,
      };
      setParams({
        bhwiReturnedBase64: undefined,
        receivedPSBTBase64: undefined,
        txhex: undefined,
        multisigContinuation: undefined,
        onBarScannedFromPicker: undefined,
      });
      return result;
    },
    [attemptIsCurrent, liveBinding, setParams],
  );

  const applyVerifiedQrResult = useCallback(
    (returnedBase64: string, expected: QrAttempt, token: string | undefined) => {
      if (!qrContinuationIsCurrent(expected, token)) throw new Error(BHWI_SIGNING_SESSION_EXPIRED);
      const currentActor = actorRef.current;
      const pending = pendingActorRef.current;
      if (currentActor === 'both') throw new Error('This transaction is already fully signed.');
      const signers: Array<'phone' | 'hardware'> = pending
        ? [pending]
        : currentActor === 'phone'
          ? ['hardware']
          : currentActor === 'hardware'
            ? ['phone']
            : ['phone', 'hardware'];
      let failure: unknown;
      for (const signer of signers) {
        try {
          applyVerifiedTransition(returnedBase64, signer);
          return;
        } catch (error) {
          failure = error;
        }
      }
      throw failure ?? new Error(loc.send.invalid_psbt);
    },
    [applyVerifiedTransition, qrContinuationIsCurrent],
  );

  const prepareHardwareSigning = useCallback(
    async (destination: 'hardware' | 'phone' | 'qr' | 'stage' = 'hardware', stagedReturn?: string) => {
      const generation = ++attemptRef.current;
      hardwareAttemptRef.current = undefined;
      stagedQrResultRef.current = undefined;
      setHasStagedQrResult(false);
      if (destination !== 'qr') {
        qrGenerationRef.current += 1;
        qrAttemptRef.current = undefined;
      }
      if (destination === 'hardware' || destination === 'stage') setVerifiedTxHex(undefined);
      setHardwareStatus('');
      setIsHardwareLoading(true);
      try {
        const current = liveBinding();
        const source = psbtRef.current;
        const pendingSigner = pendingActorRef.current;
        if (
          !current ||
          !source ||
          (destination === 'hardware' &&
            (actorRef.current === 'hardware' || actorRef.current === 'both' || (!!pendingSigner && pendingSigner !== 'hardware'))) ||
          (destination === 'phone' &&
            (actorRef.current === 'phone' || actorRef.current === 'both' || (!!pendingSigner && pendingSigner !== 'phone'))) ||
          (destination === 'stage' && actorRef.current === 'both')
        ) {
          throw new Error(BHWI_SIGNING_SESSION_EXPIRED);
        }
        if (destination === 'hardware' && !isBhwiAvailable()) throw new Error(loc.wallets.hardware_unavailable);
        const sourceBase64 = source.toBase64();
        const preparationIsCurrent = () => {
          const live = liveBinding();
          if (
            !mountedRef.current ||
            !foregroundRef.current ||
            !focusedRef.current ||
            attemptRef.current !== generation ||
            psbtRef.current?.toBase64() !== sourceBase64 ||
            !live ||
            live.walletIdentity !== current.walletIdentity ||
            live.associationIdentity !== current.associationIdentity ||
            live.policyIdentity !== current.policyIdentity
          ) {
            throw new Error(BHWI_SIGNING_SESSION_EXPIRED);
          }
        };
        if (source.data.inputs.some(input => !input.nonWitnessUtxo) && isElectrumDisabled) throw new Error(loc.errors.network);
        const hydrated = await hydrateBhwiPsbt(source, undefined, preparationIsCurrent);
        preparationIsCurrent();
        const unsigned = getUnsignedBhwiMultisigPsbt(hydrated);
        const unsignedBase64 = unsigned.toBase64();
        validateBhwiPsbtOriginal(unsignedBase64, current.wallet, current.policy.phone);
        const previousOriginal = reviewedOriginalRef.current;
        if (previousOriginal) {
          const previous = bitcoin.Psbt.fromBase64(previousOriginal, { network });
          const previousReview = getBhwiPsbtReview(previous);
          const nextReview = getBhwiPsbtReview(unsigned);
          const sameOutputs =
            previousReview.outputs.length === nextReview.outputs.length &&
            previousReview.outputs.every(
              (output, index) =>
                output.destination === nextReview.outputs[index]?.destination && output.value === nextReview.outputs[index]?.value,
            );
          if (
            !Buffer.from(previous.data.globalMap.unsignedTx.toBuffer()).equals(
              Buffer.from(unsigned.data.globalMap.unsignedTx.toBuffer()),
            ) ||
            previousReview.fee !== nextReview.fee ||
            !sameOutputs ||
            (previous.data.inputs.every(input => !!input.nonWitnessUtxo) && previousOriginal !== unsignedBase64)
          ) {
            throw new Error(BHWI_SIGNING_SESSION_EXPIRED);
          }
        }
        validateBhwiPsbtOriginal(unsignedBase64, current.wallet, current.policy.association);
        let accepted = unsigned;
        const currentActor = actorRef.current;
        if (pendingSigner) {
          if (!pendingBaseRef.current) throw new Error(BHWI_SIGNING_SESSION_EXPIRED);
          const signer = pendingSigner === 'phone' ? current.policy.phone : current.policy.association;
          validateBhwiPsbtOriginal(hydrated.toBase64(), current.wallet, signer);
          accepted = hydrated;
        } else if (currentActor === 'phone' || currentActor === 'hardware') {
          const signer = currentActor === 'phone' ? current.policy.phone : current.policy.association;
          accepted = validateBhwiPsbt(unsignedBase64, hydrated.toBase64(), current.wallet, signer).psbt;
        }
        if (destination === 'stage') {
          if (!stagedReturn) throw new Error(BHWI_SIGNING_SESSION_EXPIRED);
          reviewedOriginalRef.current = unsignedBase64;
          psbtRef.current = accepted;
          setPsbt(accepted);
          const freshAttempt = mintQrAttempt();
          stagedQrResultRef.current = Object.freeze({ returnedBase64: stagedReturn, attempt: freshAttempt });
          setHasStagedQrResult(true);
          return;
        }
        if (destination === 'phone') {
          reviewedOriginalRef.current = unsignedBase64;
          psbtRef.current = accepted;
          setPsbt(accepted);
          const returned = accepted.clone();
          current.wallet.cosignPsbt(returned);
          applyVerifiedTransition(returned.toBase64(), 'phone');
          return;
        }
        const requestBase64 = accepted.toBase64();
        if (destination === 'qr') {
          reviewedOriginalRef.current = unsignedBase64;
          psbtRef.current = accepted;
          setPsbt(accepted);
          openQrContinuation(partialExportRef.current ?? accepted, !!verifiedTxHex);
          return;
        }
        validateBhwiPsbtOriginal(requestBase64, current.wallet, current.policy.association);
        reviewedOriginalRef.current = unsignedBase64;
        const review = getBhwiPsbtReview(unsigned);
        const snapshot: HardwareAttempt = Object.freeze({
          generation,
          originalBase64: requestBase64,
          acceptedBase64: requestBase64,
          walletID,
          walletIdentity: current.walletIdentity,
          associationIdentity: current.associationIdentity,
          policyIdentity: current.policyIdentity,
          fee: review.fee.toString(),
        });
        psbtRef.current = accepted;
        setPsbt(accepted);
        hardwareAttemptRef.current = snapshot;
        routeParamsRef.current = {
          ...routeParamsRef.current,
          bhwiOriginalBase64: requestBase64,
          bhwiReturnedBase64: undefined,
          bhwiAttempt: generation,
          txhex: undefined,
        };
        setParams({
          bhwiOriginalBase64: requestBase64,
          bhwiReturnedBase64: undefined,
          bhwiAttempt: generation,
          txhex: undefined,
        });
        if (!attemptIsCurrent(snapshot)) throw new Error(BHWI_SIGNING_SESSION_EXPIRED);
        allowedContinuationRef.current = 'hardware';
        navigate('HardwareWalletAccount', {
          mode: 'sign-psbt',
          walletID,
          hardwareAccount: current.policy.association,
          originalBase64: requestBase64,
          attempt: generation,
        });
      } catch (error) {
        if (attemptRef.current === generation && mountedRef.current) {
          hardwareAttemptRef.current = undefined;
          setHardwareStatus(error instanceof Error ? error.message : BHWI_SIGNING_SESSION_EXPIRED);
        }
      } finally {
        if (attemptRef.current === generation && mountedRef.current) setIsHardwareLoading(false);
      }
    },
    [
      applyVerifiedTransition,
      attemptIsCurrent,
      isElectrumDisabled,
      liveBinding,
      navigate,
      openQrContinuation,
      mintQrAttempt,
      setParams,
      verifiedTxHex,
      walletID,
    ],
  );

  const stagePickerResult = useCallback(
    async (returnedBase64: string) => {
      if (!foregroundRef.current) {
        await new Promise<void>(resolve => {
          foregroundResumeRef.current = resolve;
        });
      }
      if (!mountedRef.current || !foregroundRef.current || !focusedRef.current) throw new Error(BHWI_SIGNING_SESSION_EXPIRED);
      await prepareHardwareSigning('stage', returnedBase64);
    },
    [prepareHardwareSigning],
  );

  useEffect(() => {
    mountedRef.current = true;
    foregroundRef.current = AppState.currentState === 'active';
    enableScreenProtect();
    const onHostActiveChange = (active: boolean) => {
      foregroundRef.current = active;
      if (active) {
        const resume = foregroundResumeRef.current;
        foregroundResumeRef.current = undefined;
        resume?.();
        return;
      }
      if (hardwareBound) expireHardwareAttempt();
    };
    // ponytail: native owns the distinction between USB permission pause and actual background.
    const lifecycle =
      (hardwareBound ? addBhwiHostActiveListener(onHostActiveChange) : undefined) ??
      AppState.addEventListener('change', nextState => onHostActiveChange(nextState === 'active'));
    return () => {
      mountedRef.current = false;
      foregroundRef.current = false;
      focusedRef.current = false;
      attemptRef.current += 1;
      hardwareAttemptRef.current = undefined;
      qrGenerationRef.current += 1;
      qrAttemptRef.current = undefined;
      stagedQrResultRef.current = undefined;
      const resume = foregroundResumeRef.current;
      foregroundResumeRef.current = undefined;
      resume?.();
      lifecycle.remove();
      disableScreenProtect();
    };
  }, [disableScreenProtect, enableScreenProtect, expireHardwareAttempt, hardwareBound]);

  useEffect(() => {
    focusedRef.current = isFocused;
    if (isFocused) {
      allowedContinuationRef.current = undefined;
      if (qrAttemptRef.current && !routeParamsRef.current.receivedPSBTBase64) {
        qrGenerationRef.current += 1;
        qrAttemptRef.current = undefined;
        setParams({ multisigContinuation: undefined });
      }
    } else if (allowedContinuationRef.current) {
      allowedContinuationRef.current = undefined;
    } else if (hardwareBound) {
      expireHardwareAttempt();
    }
  }, [expireHardwareAttempt, hardwareBound, isFocused, setParams]);

  useEffect(() => {
    if (!hardwareBound) return;
    const expected = initialBindingRef.current;
    const current = liveBinding();
    if (
      !expected ||
      !current ||
      expected.walletIdentity !== current.walletIdentity ||
      expected.associationIdentity !== current.associationIdentity ||
      expected.policyIdentity !== current.policyIdentity
    ) {
      expireHardwareAttempt();
    }
  }, [expireHardwareAttempt, hardwareBound, liveBinding, wallets]);

  useEffect(() => {
    const returned = routeParamsRef.current.bhwiReturnedBase64;
    const generation = routeParamsRef.current.bhwiAttempt;
    if (!hardwareBound || !returned) return;
    const key = `${String(generation)}\0${returned}`;
    if (handledHardwareReturnRef.current === key) return;
    handledHardwareReturnRef.current = key;
    try {
      const expected = hardwareAttemptRef.current;
      if (!expected || generation !== expected.generation) throw new Error(BHWI_SIGNING_SESSION_EXPIRED);
      applyVerifiedTransition(returned, 'hardware', expected);
    } catch (error) {
      expireHardwareAttempt(error instanceof Error ? error.message : BHWI_SIGNING_SESSION_EXPIRED);
    }
  }, [applyVerifiedTransition, expireHardwareAttempt, hardwareBound, route.params]);

  useEffect(() => {
    if (!receivedPSBTBase64 || !psbtRef.current) return;
    const fromPicker = routeParamsRef.current.onBarScannedFromPicker === true;
    if (!hardwareBound && receivedPSBTBase64 === psbtRef.current.toBase64()) return;
    if (!hardwareBound) {
      try {
        const combined = combinePSBTs({
          psbtBase64: psbtRef.current.toBase64(),
          newPSBTBase64: receivedPSBTBase64,
        });
        psbtRef.current = combined;
        setPsbt(combined);
        setParams({ receivedPSBTBase64: undefined, onBarScannedFromPicker: undefined });
      } catch (error) {
        presentAlert({ message: error instanceof Error ? error.message : loc.send.invalid_psbt });
      }
      return;
    }
    routeParamsRef.current = {
      ...routeParamsRef.current,
      receivedPSBTBase64: undefined,
      onBarScannedFromPicker: undefined,
      multisigContinuation: undefined,
    };
    setParams({ receivedPSBTBase64: undefined, onBarScannedFromPicker: undefined, multisigContinuation: undefined });
    if (fromPicker) {
      stagePickerResult(receivedPSBTBase64).catch(error => {
        expireHardwareAttempt(error instanceof Error ? error.message : BHWI_SIGNING_SESSION_EXPIRED);
      });
      return;
    }
    try {
      const expected = qrAttemptRef.current;
      if (!expected) throw new Error(BHWI_SIGNING_SESSION_EXPIRED);
      applyVerifiedQrResult(receivedPSBTBase64, expected, multisigContinuation);
    } catch (error) {
      qrGenerationRef.current += 1;
      qrAttemptRef.current = undefined;
      stagedQrResultRef.current = undefined;
      setHasStagedQrResult(false);
      setVerifiedTxHex(undefined);
      setHardwareStatus(error instanceof Error ? error.message : loc.send.invalid_psbt);
    }
  }, [applyVerifiedQrResult, expireHardwareAttempt, hardwareBound, multisigContinuation, receivedPSBTBase64, setParams, stagePickerResult]);

  const confirmStagedQrResult = useCallback(() => {
    const staged = stagedQrResultRef.current;
    stagedQrResultRef.current = undefined;
    setHasStagedQrResult(false);
    try {
      if (!staged) throw new Error(BHWI_SIGNING_SESSION_EXPIRED);
      applyVerifiedQrResult(staged.returnedBase64, staged.attempt, staged.attempt.token);
    } catch (error) {
      expireHardwareAttempt(error instanceof Error ? error.message : BHWI_SIGNING_SESSION_EXPIRED);
    }
  }, [applyVerifiedQrResult, expireHardwareAttempt]);

  useEffect(() => {
    if (!txhex) return;
    if (hardwareBound) {
      qrGenerationRef.current += 1;
      qrAttemptRef.current = undefined;
      setVerifiedTxHex(undefined);
      setHardwareStatus(loc.multisig.hardware_psbt_required);
      setParams({ txhex: undefined, multisigContinuation: undefined });
      return;
    }
    try {
      const tx = bitcoin.Transaction.fromHex(txhex);
      const currentPsbt = psbtRef.current;
      const liveWallet = walletsRef.current.find(candidate => candidate.getID() === walletID);
      if (!currentPsbt || !(liveWallet instanceof MultisigHDWallet)) throw new Error(loc.send.invalid_psbt);
      const fee = liveWallet.calculateFeeFromPsbt(currentPsbt);
      const recipients = currentPsbt.txOutputs
        .filter(output => !!output.address && !liveWallet.weOwnAddress(output.address))
        .map(output => ({ address: output.address!, value: Number(output.value) }));
      navigate('Confirm', {
        fee: new BigNumber(fee).dividedBy(100000000).toNumber(),
        memo,
        walletID,
        tx: txhex,
        recipients,
        satoshiPerByte: Math.round(fee / tx.virtualSize()),
        psbt: currentPsbt,
      });
    } catch (error) {
      presentAlert({ message: error instanceof Error ? error.message : loc.send.invalid_psbt });
    }
  }, [hardwareBound, memo, navigate, setParams, txhex, walletID]);
  useEffect(() => {
    if (!initial.current) presentAlert({ message: loc.send.invalid_psbt });
  }, []);

  const stylesHook = StyleSheet.create({
    root: {
      backgroundColor: colors.elevated,
    },
    textBtc: {
      color: colors.buttonAlternativeTextColor,
    },
    textBtcUnitValue: {
      color: colors.buttonAlternativeTextColor,
    },
    textFiat: {
      color: colors.alternativeTextColor,
    },
    provideSignatureButton: {
      backgroundColor: colors.buttonDisabledBackgroundColor,
    },
    provideSignatureButtonText: {
      color: colors.buttonTextColor,
    },
    vaultKeyCircle: {
      backgroundColor: colors.buttonDisabledBackgroundColor,
    },
    vaultKeyText: {
      color: colors.alternativeTextColor,
    },
    feeFiatText: {
      color: colors.alternativeTextColor,
    },
    vaultKeyCircleSuccess: {
      backgroundColor: colors.msSuccessBG,
    },
    vaultKeyTextSigned: {
      color: colors.msSuccessBG,
    },
    addressSection: {
      color: colors.alternativeTextColor2,
    },
  });

  if (!psbt || !wallet) return null;
  const data = new Array(wallet.getM());

  // if useFilter is true, include only non-owned addresses.
  const getDestinationData = (useFilter = true) => {
    const addresses = [];
    let totalSat = 0;
    const targets = [];
    for (const output of psbt.txOutputs) {
      if (output.address) {
        if (useFilter && wallet.weOwnAddress(output.address)) continue;
        totalSat += Number(output.value);
        addresses.push(output.address);
        targets.push({ address: output.address, value: Number(output.value) });
      }
    }
    return { addresses, totalSat, targets };
  };

  const filteredData = getDestinationData(true);
  const unfilteredData = getDestinationData(false);

  const targets = filteredData.targets;

  const displayData = isFiltered ? filteredData : unfilteredData;
  const displayTotalBtc = new BigNumber(displayData.totalSat).dividedBy(100000000).toNumber();
  const displayTotalFiat = mainnetServicesEnabled ? satoshiToLocalCurrency(displayData.totalSat) : undefined;

  const getFee = () => {
    return wallet.calculateFeeFromPsbt(psbt);
  };

  const _renderItem = (el: ListRenderItemInfo<any>) => {
    if (el.index >= howManySignaturesWeHave) return _renderItemUnsigned(el);
    else return _renderItemSigned(el);
  };

  const navigateToPSBTMultisigQRCode = () => {
    if (hardwareBound) {
      let reviewedParents = false;
      try {
        const reviewed = reviewedOriginalRef.current ? bitcoin.Psbt.fromBase64(reviewedOriginalRef.current, { network }) : undefined;
        reviewedParents = !!reviewed && reviewed.data.inputs.every(input => !!input.nonWitnessUtxo);
      } catch {}
      const hasFinalInput = psbt.data.inputs.some(input => !!input.finalScriptSig || !!input.finalScriptWitness);
      if (!reviewedParents && !hasFinalInput) {
        prepareHardwareSigning('qr').catch(() => undefined);
        return;
      }
      try {
        openQrContinuation(partialExportRef.current ?? psbt, isConfirmEnabled());
      } catch (error) {
        expireHardwareAttempt(error instanceof Error ? error.message : BHWI_SIGNING_SESSION_EXPIRED);
      }
      return;
    }
    allowedContinuationRef.current = 'qr';
    navigate('PsbtMultisigQRCode', {
      walletID,
      psbtBase64: psbt.toBase64(),
      isShowOpenScanner: isConfirmEnabled(),
    });
  };

  const _renderItemUnsigned = (el: ListRenderItemInfo<any>) => {
    const renderProvideSignature = el.index === howManySignaturesWeHave;
    return (
      <View testID="ItemUnsigned">
        <View style={styles.itemUnsignedWrapper}>
          <View style={[styles.vaultKeyCircle, stylesHook.vaultKeyCircle]}>
            <Text style={[styles.vaultKeyText, stylesHook.vaultKeyText]}>{el.index + 1}</Text>
          </View>
          <View style={styles.vaultKeyTextWrapper}>
            <Text style={[styles.vaultKeyText, stylesHook.vaultKeyText]}>
              {loc.formatString(loc.multisig.vault_key, {
                number: el.index + 1,
              })}
            </Text>
          </View>
        </View>

        {renderProvideSignature && (
          <View>
            <TouchableOpacity
              accessibilityRole="button"
              testID="ProvideSignature"
              style={[styles.provideSignatureButton, stylesHook.provideSignatureButton]}
              onPress={navigateToPSBTMultisigQRCode}
            >
              <Text style={[styles.provideSignatureButtonText, stylesHook.provideSignatureButtonText]}>
                {loc.multisig.provide_signature}
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    );
  };

  const _renderItemSigned = (el: ListRenderItemInfo<any>) => {
    return (
      <View style={styles.flexDirectionRow} testID="ItemSigned">
        <View style={[styles.vaultKeyCircleSuccess, stylesHook.vaultKeyCircleSuccess]}>
          <Icon size={24} name="checkmark" type="ionicons" color={colors.msSuccessCheck} />
        </View>
        <View style={styles.vaultKeyTextSignedWrapper}>
          <Text style={[styles.vaultKeyTextSigned, stylesHook.vaultKeyTextSigned]}>
            {loc.formatString(loc.multisig.vault_key, { number: el.index + 1 })}
          </Text>
        </View>
      </View>
    );
  };

  const onConfirm = () => {
    if (hardwareBound && !verifiedTxHex) return;
    const confirmedPsbt = psbt;
    let transaction: bitcoin.Transaction;
    try {
      if (hardwareBound) {
        transaction = bitcoin.Transaction.fromHex(verifiedTxHex!);
      } else {
        for (let index = 0; index < confirmedPsbt.inputCount; index++) {
          const input = confirmedPsbt.data.inputs[index];
          if (input && !input.finalScriptSig && !input.finalScriptWitness) confirmedPsbt.finalizeInput(index);
        }
        transaction = confirmedPsbt.extractTransaction();
      }
      if (launchedBy) {
        dispatch(StackActions.popTo(launchedBy, { psbt: confirmedPsbt }, { merge: true }));
        return;
      }
      const fee = getFee();
      navigate('Confirm', {
        fee: new BigNumber(fee).dividedBy(100000000).toNumber(),
        memo,
        walletID,
        tx: transaction.toHex(),
        recipients: targets,
        satoshiPerByte: Math.round(fee / transaction.virtualSize()),
        psbt: confirmedPsbt,
      });
    } catch (error) {
      presentAlert({ message: error instanceof Error ? error.message : String(error) });
    }
  };

  const howManySignaturesWeHave = wallet.calculateHowManySignaturesWeHaveFromPsbt(psbt);
  const isConfirmEnabled = () => {
    return hardwareBound ? !!verifiedTxHex : howManySignaturesWeHave >= wallet.getM();
  };

  const destinationAddress = (useFilter = true) => {
    const addrs = useFilter ? filteredData.addresses : unfilteredData.addresses;
    const displayAddrs = useFilter ? addrs : [...new Set(addrs)];
    const destinationAddressView = [];
    const destinations = Object.entries(displayAddrs);
    for (const [index, address] of destinations) {
      if (Number(index) > 1) {
        destinationAddressView.push(
          <View style={styles.destinationTextContainer} key={`end-${index}`}>
            <Text numberOfLines={0} style={[styles.addressSection, stylesHook.textFiat]}>
              and {destinations.length - 2} more...
            </Text>
          </View>,
        );
        break;
      } else {
        destinationAddressView.push(
          <View style={styles.destinationTextContainer} key={`${address}-${index}`}>
            <Text style={styles.textAlignCenter} selectable>
              <Text style={[styles.addressSection, stylesHook.addressSection]}>{address.slice(0, 6)}</Text>
              <Text style={[styles.textDestination, stylesHook.textFiat]}>{address.slice(6, -6)}</Text>
              <Text style={[styles.addressSection, stylesHook.addressSection]}>{address?.slice(-6)}</Text>
            </Text>
          </View>,
        );
      }
    }
    return destinationAddressView;
  };

  const handleToggleFilter = () => {
    setIsFiltered(prev => !prev);
  };

  const header = (
    <View style={stylesHook.root}>
      <View style={styles.containerText}>
        <TouchableOpacity onPress={handleToggleFilter}>
          <BlueText selectable style={[styles.textBtc, stylesHook.textBtc]}>
            {displayTotalBtc}
          </BlueText>
        </TouchableOpacity>
        <View style={styles.textBtcUnit}>
          <BlueText selectable style={stylesHook.textBtcUnitValue}>
            {' '}
            {BitcoinUnit.BTC}
          </BlueText>
        </View>
      </View>
      {displayTotalFiat ? (
        <View style={styles.containerText}>
          <TouchableOpacity onPress={handleToggleFilter}>
            <BlueText selectable style={[styles.textFiat, stylesHook.textFiat]}>
              {displayTotalFiat}
            </BlueText>
          </TouchableOpacity>
        </View>
      ) : null}
      <View>{destinationAddress(isFiltered)}</View>
    </View>
  );

  const footer = null;

  const onLayout = (
    event: NativeSyntheticEvent<{
      layout: LayoutRectangle;
      target?: NodeHandle | null;
    }>,
  ) => {
    const newHeight = event.nativeEvent.layout.height;
    setFlatListHeight(newHeight);
  };

  return (
    <SafeArea style={stylesHook.root}>
      <View style={styles.flexColumnSpaceBetween}>
        <View style={styles.flexOne}>
          <View style={styles.container}>
            <View style={styles.mstopcontainer}>
              <View style={styles.mscontainer}>
                <View style={[styles.msleft, { height: flatListHeight - 260 }]} />
              </View>
              <View style={styles.msright}>
                <BlueCard>
                  <FlatList
                    data={data}
                    renderItem={_renderItem}
                    keyExtractor={(_item, index) => `${index}`}
                    extraData={psbt} // Ensure FlatList updates when psbt changes
                    ListHeaderComponent={header}
                    ListFooterComponent={footer}
                    onLayout={onLayout}
                  />
                  {hardwareBound && actor !== 'both' && (
                    <View style={styles.hardwareActions}>
                      {hasStagedQrResult && (
                        <Button
                          testID="PsbtMultisigVerifyStagedFile"
                          title={loc.send.psbt_hardware_verify_file}
                          onPress={confirmStagedQrResult}
                          disabled={isHardwareLoading}
                        />
                      )}
                      {actor !== 'phone' && (!pendingActor || pendingActor === 'phone') && (
                        <Button
                          testID="PsbtMultisigSignWithPhone"
                          title={loc.multisig.sign_with_phone}
                          onPress={() => prepareHardwareSigning('phone').catch(() => undefined)}
                          disabled={isHardwareLoading || !reviewedOriginalRef.current}
                          showActivityIndicator={isHardwareLoading}
                        />
                      )}
                      {actor !== 'hardware' && (!pendingActor || pendingActor === 'hardware') && (
                        <Button
                          testID="PsbtMultisigSignWithHardware"
                          title={loc.wallets.hardware_sign_transaction}
                          onPress={() => prepareHardwareSigning().catch(() => undefined)}
                          disabled={isHardwareLoading || !reviewedOriginalRef.current}
                          showActivityIndicator={isHardwareLoading}
                        />
                      )}
                      {!!hardwareStatus && (
                        <BlueText style={styles.hardwareStatus} testID="PsbtMultisigHardwareStatus">
                          {hardwareStatus}
                        </BlueText>
                      )}
                    </View>
                  )}
                  {isConfirmEnabled() && (
                    <View style={styles.height80}>
                      <TouchableOpacity
                        accessibilityRole="button"
                        testID="ExportSignedPsbt"
                        style={[styles.provideSignatureButton, stylesHook.provideSignatureButton]}
                        onPress={() => {
                          navigateToPSBTMultisigQRCode();
                        }}
                      >
                        <Text style={[styles.provideSignatureButtonText, stylesHook.provideSignatureButtonText]}>
                          {loc.multisig.export_signed_psbt}
                        </Text>
                      </TouchableOpacity>
                    </View>
                  )}
                </BlueCard>
              </View>
            </View>
          </View>
        </View>
        <View style={styles.feeConfirmContainer}>
          <View style={styles.feeContainer}>
            <View style={styles.bottomWrapper}>
              <View style={styles.bottomFeesWrapper}>
                {mainnetServicesEnabled ? (
                  <BlueText selectable style={stylesHook.feeFiatText}>
                    {loc.formatString(loc.multisig.fee, {
                      number: satoshiToLocalCurrency(getFee()),
                    })}{' '}
                    -{' '}
                  </BlueText>
                ) : null}
                <BlueText selectable>
                  {loc.formatString(loc.multisig.fee_btc, {
                    number: satoshiToBTC(getFee()),
                  })}
                </BlueText>
              </View>
            </View>
          </View>
          <View style={styles.flexConfirm}>
            <Button disabled={!isConfirmEnabled()} title={loc.multisig.confirm} onPress={onConfirm} testID="PsbtMultisigConfirmButton" />
          </View>
        </View>
      </View>
    </SafeArea>
  );
};

const styles = StyleSheet.create({
  mstopcontainer: {
    flex: 1,
    flexDirection: 'row',
  },
  mscontainer: {
    flex: 10,
  },
  flexOne: {
    flex: 1,
  },
  msleft: {
    width: 1,
    borderStyle: 'dashed',
    borderWidth: 0.8,
    borderColor: '#c4c4c4',
    marginLeft: 40,
    marginTop: 220,
  },
  msright: {
    flex: 90,
    marginLeft: '-11%',
  },
  container: {
    flexDirection: 'column',
    flex: 1,
  },
  containerText: {
    flexDirection: 'row',
    justifyContent: 'center',
  },
  destinationTextContainer: {
    flexDirection: 'row',
    marginBottom: 4,
    paddingHorizontal: 60,
    fontSize: 14,
    marginVertical: 8,
    justifyContent: 'center',
  },
  textFiat: {
    fontSize: 16,
    fontWeight: '500',
    marginBottom: 30,
  },
  textBtc: {
    fontWeight: 'bold',
    fontSize: 30,
  },
  textAlignCenter: {
    textAlign: 'center',
  },
  addressSection: {
    fontSize: 14,
    fontWeight: '500',
  },
  textDestination: {
    paddingTop: 10,
    paddingBottom: 40,
    fontSize: 14,
    flexWrap: 'wrap',
  },
  provideSignatureButton: {
    marginTop: 24,
    marginLeft: 40,
    height: 48,
    borderRadius: 8,
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  provideSignatureButtonText: { fontWeight: '600', fontSize: 15 },
  vaultKeyText: { fontSize: 18, fontWeight: 'bold' },
  vaultKeyTextWrapper: {
    justifyContent: 'center',
    alignItems: 'center',
    paddingLeft: 16,
  },
  vaultKeyCircle: {
    width: 42,
    height: 42,
    borderRadius: 25,
    justifyContent: 'center',
    alignItems: 'center',
  },
  vaultKeyCircleSuccess: {
    width: 42,
    height: 42,
    borderRadius: 25,
    justifyContent: 'center',
    alignItems: 'center',
  },
  itemUnsignedWrapper: { flexDirection: 'row', paddingTop: 16 },
  vaultKeyTextSigned: { fontSize: 18, fontWeight: 'bold' },
  vaultKeyTextSignedWrapper: {
    justifyContent: 'center',
    alignItems: 'center',
    paddingLeft: 16,
  },
  flexDirectionRow: { flexDirection: 'row', paddingVertical: 12 },
  textBtcUnit: { justifyContent: 'flex-end' },
  bottomFeesWrapper: {
    justifyContent: 'center',
    alignItems: 'center',
    flexDirection: 'row',
  },
  bottomWrapper: { marginTop: 16 },
  height80: {
    height: 80,
  },
  flexColumnSpaceBetween: {
    flex: 1,
    flexDirection: 'column',
    justifyContent: 'space-between',
  },
  flexConfirm: {
    paddingHorizontal: 32,
    paddingVertical: 16,
  },
  feeConfirmContainer: {
    paddingHorizontal: 32,
    paddingVertical: 16,
  },
  feeContainer: {
    marginBottom: 8,
  },
  hardwareActions: {
    paddingHorizontal: 24,
    paddingBottom: 16,
  },
  hardwareStatus: {
    marginTop: 12,
    textAlign: 'center',
  },
});

export default PsbtMultisig;
