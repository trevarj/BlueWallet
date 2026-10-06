import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useIsFocused, useNavigation, useRoute } from '@react-navigation/native';
import type { RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { AlertButton } from 'react-native';
import {
  ActivityIndicator,
  AppState,
  findNodeHandle,
  Keyboard,
  LayoutAnimation,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import Share from 'react-native-share';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import triggerHapticFeedback, { HapticFeedbackTypes } from '../../blue_modules/hapticFeedback';
import BlueFormLabel from '../../components/BlueFormLabel';
import Button from '../../components/Button';
import Icon from '../../components/Icon';
import { FButton, FContainer, FloatButtonsBottomFade } from '../../components/FloatButtons';
import { SecondButton } from '../../components/SecondButton';
import { useTheme } from '../../components/themes';
import loc from '../../loc';
import { useStorage } from '../../hooks/context/useStorage';
import {
  DoneAndDismissKeyboardInputAccessory,
  DoneAndDismissKeyboardInputAccessoryViewID,
} from '../../components/DoneAndDismissKeyboardInputAccessory';
import { BlueSpacing10, BlueSpacing20, BlueSpacing40 } from '../../components/BlueSpacing';
import useWalletSubscribe from '../../hooks/useWalletSubscribe.tsx';
import ActionSheet from '../ActionSheet.ts';
import {
  isBhwiAvailable,
  matchesBhwiAddressSnapshot,
  resolveBhwiAddressSnapshot,
  supportsBhwiMessageSigning,
} from '../../blue_modules/bhwi';
import type { BhwiAddressSnapshot, BhwiSinglesigFormat } from '../../blue_modules/bhwi';
import { bhwiAssociationIdentity, bhwiWatchOnlyWalletIdentity } from '../../blue_modules/bhwiPsbt';
import { WatchOnlyWallet } from '../../class/wallets/watch-only-wallet';
import type { SignVerifyStackParamList } from '../../navigation/SignVerifyStack';

type NavigationProps = NativeStackNavigationProp<SignVerifyStackParamList, 'SignVerify'>;
type RouteProps = RouteProp<SignVerifyStackParamList, 'SignVerify'>;
type HardwareMessageAttempt = Readonly<{
  generation: number;
  walletID: string;
  walletIdentity: string;
  associationIdentity: string;
  address: string;
  message: string;
  path: string;
  format: BhwiSinglesigFormat;
  snapshot: BhwiAddressSnapshot;
}>;

const SignVerify = () => {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { sleep, wallets } = useStorage();
  const navigation = useNavigation<NavigationProps>();
  const isFocused = useIsFocused();
  const route = useRoute<RouteProps>();
  const { address: initialAddress, walletID, bhwiMessageAttempt, bhwiMessageSignature } = route.params;
  const scrollViewRef = useRef<ScrollView>(null);
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
  const [address, setAddress] = useState(initialAddress);
  const [message, setMessage] = useState('');
  const [signature, setSignature] = useState('');
  const [loading, setLoading] = useState(false);
  const [messageHasFocus, setMessageHasFocus] = useState(false);
  const [isShareVisible, setIsShareVisible] = useState(false);
  const wallet = useWalletSubscribe(walletID);
  const walletsRef = useRef(wallets);
  const addressRef = useRef(address);
  const messageRef = useRef(message);
  const mountedRef = useRef(true);
  const foregroundRef = useRef(AppState.currentState === 'active');
  const focusedRef = useRef(isFocused);
  const generationRef = useRef(0);
  const hardwareAttemptRef = useRef<HardwareMessageAttempt | undefined>(undefined);
  const allowedHardwareBlurRef = useRef(false);
  walletsRef.current = wallets;
  addressRef.current = address;
  messageRef.current = message;
  focusedRef.current = isFocused;
  const isToolbarVisibleForAndroid = Platform.OS === 'android' && messageHasFocus && isKeyboardVisible;

  useEffect(() => {
    const showSubscription = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () =>
      setIsKeyboardVisible(true),
    );
    const hideSubscription = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () =>
      setIsKeyboardVisible(false),
    );
    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  const stylesHooks = StyleSheet.create({
    screen: {
      backgroundColor: colors.elevated,
    },
    text: {
      borderColor: colors.formBorder,
      borderBottomColor: colors.formBorder,
      backgroundColor: colors.inputBackgroundColor,
      color: colors.foregroundColor,
    },
  });

  const handleShare = () => {
    const baseUri = 'https://bluewallet.github.io/VerifySignature';
    const uri = `${baseUri}?a=${address}&m=${encodeURIComponent(message)}&s=${encodeURIComponent(signature)}`;
    Share.open({ message: uri }).catch(error => console.log(error));
  };

  const presentAlert = useCallback(
    ({ title, alertMessage, buttons = [{ text: loc._.ok }] }: { title?: string; alertMessage: string; buttons?: AlertButton[] }) => {
      const anchor = findNodeHandle(scrollViewRef.current);
      if (anchor === null) return;
      const cancelButtonIndex = buttons.findIndex(button => button.style === 'cancel');
      const destructiveButtonIndex = buttons.findIndex(button => button.style === 'destructive');
      ActionSheet.showActionSheetWithOptions(
        {
          title,
          message: alertMessage,
          options: buttons.map(button => button.text ?? ''),
          cancelButtonIndex: cancelButtonIndex >= 0 ? cancelButtonIndex : undefined,
          destructiveButtonIndex: destructiveButtonIndex >= 0 ? destructiveButtonIndex : undefined,
          anchor,
        },
        buttonIndex => buttons[buttonIndex]?.onPress?.(),
      );
    },
    [],
  );

  const clearSignedOutput = useCallback(() => {
    setSignature('');
    setIsShareVisible(false);
  }, []);

  const expireHardwareAttempt = useCallback(() => {
    const hadHardwareAttempt = hardwareAttemptRef.current !== undefined || allowedHardwareBlurRef.current;
    if (hadHardwareAttempt) generationRef.current += 1;
    hardwareAttemptRef.current = undefined;
    allowedHardwareBlurRef.current = false;
    if (hadHardwareAttempt) {
      clearSignedOutput();
      setLoading(false);
    }
  }, [clearSignedOutput]);

  const updateAddress = useCallback(
    (value: string) => {
      const nextAddress = value.replace('\n', '');
      addressRef.current = nextAddress;
      expireHardwareAttempt();
      clearSignedOutput();
      setAddress(nextAddress);
    },
    [clearSignedOutput, expireHardwareAttempt],
  );

  const updateMessage = useCallback(
    (value: string) => {
      messageRef.current = value;
      expireHardwareAttempt();
      clearSignedOutput();
      setMessage(value);
    },
    [clearSignedOutput, expireHardwareAttempt],
  );

  useEffect(() => {
    mountedRef.current = true;
    foregroundRef.current = AppState.currentState === 'active';
    const appState = AppState.addEventListener('change', nextState => {
      foregroundRef.current = nextState === 'active';
      if (!foregroundRef.current) expireHardwareAttempt();
    });
    return () => {
      mountedRef.current = false;
      foregroundRef.current = false;
      focusedRef.current = false;
      generationRef.current += 1;
      hardwareAttemptRef.current = undefined;
      allowedHardwareBlurRef.current = false;
      appState.remove();
    };
  }, [expireHardwareAttempt]);

  useEffect(() => {
    focusedRef.current = isFocused;
    const hasHardwareResult = bhwiMessageAttempt !== undefined || bhwiMessageSignature !== undefined;
    if (!isFocused) {
      if (!allowedHardwareBlurRef.current) expireHardwareAttempt();
      return;
    }
    if (!hasHardwareResult) {
      if (allowedHardwareBlurRef.current) expireHardwareAttempt();
      return;
    }

    navigation.setParams({ bhwiMessageAttempt: undefined, bhwiMessageSignature: undefined });
    const expected = hardwareAttemptRef.current;
    hardwareAttemptRef.current = undefined;
    allowedHardwareBlurRef.current = false;
    const liveWallet = walletsRef.current.find(candidate => candidate.getID() === walletID);
    const liveAssociation = liveWallet instanceof WatchOnlyWallet ? liveWallet.getHardwareWalletAssociation() : undefined;
    const attemptIsCurrent =
      !!expected &&
      Number.isSafeInteger(bhwiMessageAttempt) &&
      bhwiMessageAttempt === expected.generation &&
      typeof bhwiMessageSignature === 'string' &&
      bhwiMessageSignature.length > 0 &&
      mountedRef.current &&
      foregroundRef.current &&
      focusedRef.current &&
      generationRef.current === expected.generation &&
      expected.walletID === walletID &&
      addressRef.current === expected.address &&
      messageRef.current === expected.message &&
      liveWallet instanceof WatchOnlyWallet &&
      !!liveAssociation &&
      bhwiAssociationIdentity(liveAssociation) === expected.associationIdentity &&
      bhwiWatchOnlyWalletIdentity(liveWallet, liveAssociation) === expected.walletIdentity &&
      liveAssociation.format === expected.format &&
      `${liveAssociation.path}/${expected.snapshot.isInternal ? 1 : 0}/${expected.snapshot.index}` === expected.path &&
      matchesBhwiAddressSnapshot(liveWallet, expected.snapshot);
    generationRef.current += 1;
    clearSignedOutput();
    if (!attemptIsCurrent || !expected || typeof bhwiMessageSignature !== 'string' || !(liveWallet instanceof WatchOnlyWallet)) {
      triggerHapticFeedback(HapticFeedbackTypes.NotificationError);
      presentAlert({ title: loc.errors.error, alertMessage: loc.addresses.hardware_signing_expired });
      return;
    }
    try {
      if (!liveWallet.verifyMessage(expected.message, expected.address, bhwiMessageSignature)) {
        throw new Error(loc.addresses.hardware_signature_invalid);
      }
      setSignature(bhwiMessageSignature);
      setIsShareVisible(true);
      triggerHapticFeedback(HapticFeedbackTypes.NotificationSuccess);
    } catch {
      triggerHapticFeedback(HapticFeedbackTypes.NotificationError);
      presentAlert({ title: loc.errors.error, alertMessage: loc.addresses.hardware_signature_invalid });
    }
  }, [bhwiMessageAttempt, bhwiMessageSignature, clearSignedOutput, expireHardwareAttempt, isFocused, navigation, presentAlert, walletID]);

  const handleSign = async () => {
    clearSignedOutput();
    const associated = wallet instanceof WatchOnlyWallet ? wallet.getHardwareWalletAssociation() : undefined;
    if (associated) {
      const liveWallet = walletsRef.current.find(candidate => candidate.getID() === walletID);
      const liveAssociation = liveWallet instanceof WatchOnlyWallet ? liveWallet.getHardwareWalletAssociation() : undefined;
      const walletIdentity =
        liveWallet instanceof WatchOnlyWallet && liveAssociation ? bhwiWatchOnlyWalletIdentity(liveWallet, liveAssociation) : undefined;
      if (
        !(liveWallet instanceof WatchOnlyWallet) ||
        !liveAssociation ||
        !walletIdentity ||
        bhwiAssociationIdentity(liveAssociation) !== bhwiAssociationIdentity(associated)
      ) {
        presentAlert({ title: loc.errors.error, alertMessage: loc.addresses.hardware_signing_expired });
        return;
      }
      if (!isBhwiAvailable()) {
        presentAlert({ title: loc.errors.error, alertMessage: loc.wallets.hardware_unavailable });
        return;
      }
      if (!supportsBhwiMessageSigning({ family: liveAssociation.family, model: null }, liveAssociation.format)) {
        presentAlert({ title: loc.errors.error, alertMessage: loc.wallets.hardware_unsupported });
        return;
      }
      const messageFormat = liveAssociation.format;
      const snapshot = resolveBhwiAddressSnapshot(liveWallet, addressRef.current);
      if (!snapshot) {
        presentAlert({ title: loc.errors.error, alertMessage: loc.wallets.hardware_address_unknown });
        return;
      }
      const path = `${liveAssociation.path}/${snapshot.isInternal ? 1 : 0}/${snapshot.index}`;
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      const attempt: HardwareMessageAttempt = Object.freeze({
        generation,
        walletID,
        walletIdentity,
        associationIdentity: bhwiAssociationIdentity(liveAssociation),
        address: addressRef.current,
        message: messageRef.current,
        path,
        format: messageFormat,
        snapshot: Object.freeze({ ...snapshot }),
      });
      hardwareAttemptRef.current = attempt;
      allowedHardwareBlurRef.current = true;
      navigation.navigate('HardwareWalletAccount', {
        mode: 'sign-message',
        walletID,
        hardwareAccount: { ...liveAssociation },
        snapshot: attempt.snapshot,
        path: attempt.path,
        message: attempt.message,
        attempt: attempt.generation,
      });
      return;
    }

    setLoading(true);
    await sleep(10); // wait for loading indicator to appear
    try {
      const newSignature = wallet.signMessage(messageRef.current, addressRef.current);
      setSignature(newSignature);
      setIsShareVisible(true);
    } catch (error) {
      triggerHapticFeedback(HapticFeedbackTypes.NotificationError);
      presentAlert({ title: loc.errors.error, alertMessage: error instanceof Error ? error.message : loc.errors.error });
    }
    setLoading(false);
  };

  const handleVerify = async () => {
    setLoading(true);
    await sleep(10); // wait for loading indicator to appear
    try {
      const res = wallet.verifyMessage(message, address, signature);
      presentAlert({
        title: res ? loc._.success : loc.errors.error,
        alertMessage: res ? loc.addresses.sign_signature_correct : loc.addresses.sign_signature_incorrect,
      });
      if (res) {
        triggerHapticFeedback(HapticFeedbackTypes.NotificationSuccess);
      }
    } catch (error) {
      triggerHapticFeedback(HapticFeedbackTypes.NotificationError);
      presentAlert({ title: loc.errors.error, alertMessage: error instanceof Error ? error.message : loc.errors.error });
    }
    setLoading(false);
  };

  const handleFocus = (value: boolean) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setMessageHasFocus(value);
  };

  if (loading)
    return (
      <View style={[styles.screenRoot, stylesHooks.screen, styles.loading]}>
        <ActivityIndicator />
      </View>
    );

  const scrollBottomPad = isShareVisible && !isKeyboardVisible ? insets.bottom + 80 : undefined;

  return (
    <View style={[styles.screenRoot, stylesHooks.screen]}>
      <ScrollView
        ref={scrollViewRef}
        automaticallyAdjustContentInsets
        automaticallyAdjustKeyboardInsets
        contentInsetAdjustmentBehavior="automatic"
        scrollToOverflowEnabled
        contentContainerStyle={[styles.root, scrollBottomPad !== undefined && { paddingBottom: scrollBottomPad }]}
        style={styles.scroll}
      >
        {!isKeyboardVisible && (
          <>
            <BlueSpacing20 />
            <BlueFormLabel>{loc.addresses.sign_help}</BlueFormLabel>
            <BlueSpacing20 />
          </>
        )}

        <TextInput
          multiline
          textAlignVertical="top"
          blurOnSubmit
          placeholder={loc.addresses.sign_placeholder_address}
          placeholderTextColor="#81868e"
          value={address}
          onChangeText={updateAddress}
          testID="SignVerifyAddress"
          style={[styles.text, stylesHooks.text]}
          autoCorrect={false}
          autoCapitalize="none"
          spellCheck={false}
        />
        <BlueSpacing10 />

        <TextInput
          multiline
          placeholder={loc.addresses.sign_placeholder_message}
          placeholderTextColor="#81868e"
          value={message}
          onChangeText={updateMessage}
          testID="Message"
          inputAccessoryViewID={DoneAndDismissKeyboardInputAccessoryViewID}
          style={[styles.text, styles.messageInput, stylesHooks.text]}
          autoCorrect={false}
          autoCapitalize="none"
          spellCheck={false}
          scrollEnabled
          textAlignVertical="top"
          onFocus={() => handleFocus(true)}
          onBlur={() => handleFocus(false)}
        />
        <BlueSpacing10 />

        <TextInput
          multiline
          textAlignVertical="top"
          blurOnSubmit
          placeholder={loc.addresses.sign_placeholder_signature}
          placeholderTextColor="#81868e"
          value={signature}
          onChangeText={t => setSignature(t.replace('\n', ''))}
          testID="SignVerifySignature"
          style={[styles.text, stylesHooks.text]}
          autoCorrect={false}
          autoCapitalize="none"
          spellCheck={false}
        />
        <BlueSpacing40 />

        {!isKeyboardVisible && (
          <>
            <View style={styles.actionButtons}>
              <SecondButton onPress={handleVerify} title={loc.addresses.sign_verify} />
              <BlueSpacing20 />
              <Button onPress={handleSign} title={loc.addresses.sign_sign} />
            </View>
            <BlueSpacing10 />
          </>
        )}

        {Platform.select({
          ios: (
            <DoneAndDismissKeyboardInputAccessory
              onClearTapped={() => updateMessage('')}
              onPasteTapped={text => {
                updateMessage(text);
                Keyboard.dismiss();
              }}
            />
          ),
          android: isToolbarVisibleForAndroid && (
            <DoneAndDismissKeyboardInputAccessory
              onClearTapped={() => {
                updateMessage('');
                Keyboard.dismiss();
              }}
              onPasteTapped={text => {
                updateMessage(text);
                Keyboard.dismiss();
              }}
            />
          ),
        })}
      </ScrollView>

      {isShareVisible && !isKeyboardVisible && (
        <>
          <FloatButtonsBottomFade />
          <FContainer>
            <FButton
              onPress={handleShare}
              text={loc.multisig.share}
              icon={
                <View>
                  <Icon name="external-link" size={16} type="font-awesome" color={colors.buttonAlternativeTextColor} />
                </View>
              }
            />
          </FContainer>
        </>
      )}
    </View>
  );
};

export default SignVerify;

const styles = StyleSheet.create({
  screenRoot: {
    flex: 1,
  },
  scroll: {
    flex: 1,
  },
  root: {
    flexGrow: 1,
  },
  text: {
    paddingHorizontal: 8,
    paddingVertical: 8,
    marginTop: 5,
    marginHorizontal: 20,
    borderWidth: 1,
    borderBottomWidth: 0.5,
    borderRadius: 4,
    textAlignVertical: 'top',
  },
  messageInput: {
    minHeight: 80,
    maxHeight: 200,
  },
  actionButtons: {
    alignSelf: 'stretch',
    marginHorizontal: 20,
  },
  loading: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
