import React, { lazy } from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import navigationStyle from '../components/navigationStyle';
import { useTheme } from '../components/themes';
import loc from '../loc';
import { withLazySuspense } from './LazyLoadingIndicator';
import { mainnetServicesEnabled } from '../models/bitcoinNetwork';
import BlueTextCentered from '../components/BlueTextCentered';

const Stack = createNativeStackNavigator();

const AztecoRedeem = lazy(() => import('../screen/receive/AztecoRedeem'));
const SelectWallet = lazy(() => import('../screen/wallets/SelectWallet'));

const AztecoRedeemComponent = withLazySuspense(AztecoRedeem);
const SelectWalletComponent = withLazySuspense(SelectWallet);

const AztecoRedeemStackRoot = () => {
  const theme = useTheme();
  if (!mainnetServicesEnabled) return <BlueTextCentered>{loc._.mainnet_services_unavailable}</BlueTextCentered>;

  return (
    <Stack.Navigator screenOptions={{ headerShadowVisible: false }}>
      <Stack.Screen
        name="AztecoRedeem"
        component={AztecoRedeemComponent}
        options={navigationStyle({
          title: loc.azteco.title,
        })(theme)}
      />
      <Stack.Screen
        name="SelectWallet"
        component={SelectWalletComponent}
        options={navigationStyle({
          title: loc.wallets.select_wallet,
        })(theme)}
      />
    </Stack.Navigator>
  );
};

export default AztecoRedeemStackRoot;
