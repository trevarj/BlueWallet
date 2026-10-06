import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, View, StyleSheet, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp, StackActions, useNavigation, useRoute } from '@react-navigation/native';

import { BlueSpacing10, BlueSpacing20 } from '../../components/BlueSpacing';
import BlueTextCentered from '../../components/BlueTextCentered';
import Button from '../../components/Button';
import Icon from '../../components/Icon';
import { useTheme } from '../../components/themes';
import loc from '../../loc';
import { AddWalletStackParamList } from '../../navigation/AddWalletStack';
import { useScreenProtect } from '../../hooks/useScreenProtect';

const WalletsAddMultisigVaultKeySheet = () => {
  const navigation = useNavigation<NativeStackNavigationProp<AddWalletStackParamList, 'WalletsAddMultisigVaultKeySheet'>>();
  const route = useRoute<RouteProp<AddWalletStackParamList, 'WalletsAddMultisigVaultKeySheet'>>();
  const { colors } = useTheme();
  const { enableScreenProtect, disableScreenProtect } = useScreenProtect();
  const { keyIndex, seed, seedToken, requireBackupAcknowledgement } = route.params;

  const [protectionReady, setProtectionReady] = useState(false);
  const [protectionFailed, setProtectionFailed] = useState(false);
  const finishing = useRef(false);

  useEffect(() => {
    let active = true;
    enableScreenProtect()
      .then(() => {
        if (active) setProtectionReady(true);
      })
      .catch(() => {
        if (active) setProtectionFailed(true);
      });
    return () => {
      active = false;
      disableScreenProtect().catch(() => undefined);
    };
  }, [disableScreenProtect, enableScreenProtect]);

  const finish = async () => {
    if (!protectionReady || finishing.current) return;
    finishing.current = true;
    setProtectionReady(false);
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    await disableScreenProtect().catch(() => undefined);
    if (requireBackupAcknowledgement) {
      navigation.dispatch(
        StackActions.popTo('WalletsAddMultisigStep2', { sheetAction: 'backupAcknowledged', sheetSeedToken: seedToken }, { merge: true }),
      );
    } else {
      navigation.goBack();
    }
  };
  const words = useMemo(() => seed.split(' '), [seed]);

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.elevated }]} edges={['bottom', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={[styles.vaultKeyCircleSuccess, { backgroundColor: colors.msSuccessBG }]}>
          <Icon size={24} name="checkmark" type="ionicons" color={colors.msSuccessCheck} />
        </View>
        <BlueSpacing20 />
        <BlueTextCentered>{loc.formatString(loc.multisig.vault_key, { number: keyIndex })}</BlueTextCentered>
        <BlueSpacing20 />
        <BlueTextCentered>{loc.multisig.wallet_key_created}</BlueTextCentered>
        {requireBackupAcknowledgement && (
          <>
            <BlueSpacing10 />
            <BlueTextCentered>{loc.multisig.hardware_and_mobile_backup_warning}</BlueTextCentered>
          </>
        )}
        <BlueSpacing20 />
        {protectionReady ? (
          <>
            <BlueTextCentered>{loc._.seed}</BlueTextCentered>
            <BlueSpacing10 />
            <View testID="VaultSeedWords" style={[styles.secretContainer, { borderColor: colors.formBorder }]}>
              {words.map((text, index) => (
                <View style={[styles.word, { backgroundColor: colors.inputBackgroundColor }]} key={`${text}${index}`}>
                  <BlueTextCentered>{`${index + 1}. ${text}`}</BlueTextCentered>
                </View>
              ))}
            </View>
          </>
        ) : protectionFailed ? (
          <BlueTextCentered>{loc.multisig.seed_protection_failed}</BlueTextCentered>
        ) : (
          <ActivityIndicator testID="VaultSeedProtectionPending" />
        )}
      </ScrollView>
      <View style={styles.footer}>
        <Button
          testID="VaultKeyDone"
          title={requireBackupAcknowledgement ? loc.multisig.backup_acknowledged : loc.send.success_done}
          onPress={() => finish().catch(() => undefined)}
          disabled={!protectionReady}
        />
      </View>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  content: {
    padding: 22,
    alignItems: 'center',
  },
  footer: {
    paddingHorizontal: 22,
    paddingVertical: 16,
  },
  vaultKeyCircleSuccess: {
    width: 42,
    height: 42,
    borderRadius: 25,
    justifyContent: 'center',
    alignItems: 'center',
  },
  secretContainer: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
    flexWrap: 'wrap',
  },
  word: {
    marginRight: 8,
    marginBottom: 8,
    paddingTop: 6,
    paddingBottom: 6,
    paddingLeft: 8,
    paddingRight: 8,
    borderRadius: 4,
  },
});

export default WalletsAddMultisigVaultKeySheet;
