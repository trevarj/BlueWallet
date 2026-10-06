import { createNativeStackNavigator } from '@react-navigation/native-stack';
import React, { lazy } from 'react';

import navigationStyle, { CloseButtonPosition } from '../components/navigationStyle';
import { useTheme } from '../components/themes';
import loc from '../loc';
import { withLazySuspense } from './LazyLoadingIndicator';
import { labelForNetwork } from '../models/bitcoinNetwork';
import type { BhwiOperationRouteParams } from '../blue_modules/bhwi';

export type SignVerifyScreenParams = {
  walletID: string;
  address: string;
  bhwiMessageAttempt?: number;
  bhwiMessageSignature?: string;
};

export type SignVerifyStackParamList = {
  SignVerify: SignVerifyScreenParams;
  HardwareWalletAccount: BhwiOperationRouteParams;
};

const Stack = createNativeStackNavigator<SignVerifyStackParamList>();

const SignVerify = lazy(() => import('../screen/wallets/signVerify'));
const HardwareWalletAccount = lazy(() => import('../screen/wallets/HardwareWalletAccount'));
const SignVerifyComponent = withLazySuspense(SignVerify);
const HardwareWalletAccountComponent = withLazySuspense(HardwareWalletAccount);

const SignVerifyStackRoot = () => {
  const theme = useTheme();

  return (
    <Stack.Navigator screenOptions={{ headerShadowVisible: false }}>
      <Stack.Screen
        name="SignVerify"
        component={SignVerifyComponent}
        options={navigationStyle({
          headerBackVisible: false,
          statusBarStyle: 'light',
          title: labelForNetwork(loc.addresses.sign_title),
          closeButtonPosition: CloseButtonPosition.Right,
        })(theme)}
      />
      <Stack.Screen
        name="HardwareWalletAccount"
        component={HardwareWalletAccountComponent}
        options={navigationStyle({ title: loc.wallets.hardware_title })(theme)}
      />
    </Stack.Navigator>
  );
};

export default SignVerifyStackRoot;
