import { useNavigation } from '@react-navigation/native';
import React, { useState } from 'react';
import { ActivityIndicator, StyleSheet, TextInput, View } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import BlueFormLabel from '../../components/BlueFormLabel';
import BlueFormMultiInput from '../../components/BlueFormMultiInput';
import { HDSegwitBech32Wallet } from '../../class/wallets/hd-segwit-bech32-wallet';
import { WatchOnlyWallet } from '../../class/wallets/watch-only-wallet';
import presentAlert from '../../components/Alert';
import Button from '../../components/Button';
import SafeArea from '../../components/SafeArea';
import { useTheme } from '../../components/themes';
import { useStorage } from '../../hooks/context/useStorage';
import { AddWalletStackParamList } from '../../navigation/AddWalletStack';
import { BlueSpacing20 } from '../../components/BlueSpacing';

type NavigationProp = NativeStackNavigationProp<AddWalletStackParamList, 'ImportSpeed'>;

const ImportSpeed = () => {
  const navigation = useNavigation<NavigationProp>();
  const { colors } = useTheme();
  const [loading, setLoading] = useState<boolean>(false);
  const [importText, setImportText] = useState<string>('');
  const [walletType, setWalletType] = useState<string>('');
  const [passphrase, setPassphrase] = useState<string>('');
  const [stagedWallet, setStagedWallet] = useState<HDSegwitBech32Wallet | WatchOnlyWallet>();
  const { addAndSaveWallet } = useStorage();

  const styles = StyleSheet.create({
    root: {
      paddingTop: 40,
      backgroundColor: colors.elevated,
    },
    center: {
      flex: 1,
      marginHorizontal: 16,
      backgroundColor: colors.elevated,
    },
    pathInput: {
      flexDirection: 'row',
      borderWidth: 1,
      borderBottomWidth: 0.5,
      minHeight: 44,
      height: 44,
      alignItems: 'center',
      marginVertical: 8,
      borderRadius: 4,
      paddingHorizontal: 8,
      color: '#81868e',
      borderColor: colors.formBorder,
      borderBottomColor: colors.formBorder,
      backgroundColor: colors.inputBackgroundColor,
    },
  });

  const importMnemonic = async () => {
    setLoading(true);
    try {
      let wallet = stagedWallet;
      if (!wallet) {
        let WalletClass;
        switch (walletType) {
          case HDSegwitBech32Wallet.type:
            WalletClass = HDSegwitBech32Wallet;
            break;
          case WatchOnlyWallet.type:
            WalletClass = WatchOnlyWallet;
            break;
        }

        if (!WalletClass) {
          throw new Error('Invalid wallet type');
        }

        wallet = new WalletClass();
        wallet.setSecret(importText);
        if (passphrase && wallet instanceof HDSegwitBech32Wallet) {
          wallet.setPassphrase(passphrase);
        }
        await wallet.fetchBalance();
        setStagedWallet(wallet);
      }

      if (await addAndSaveWallet(wallet)) {
        navigation.getParent()?.goBack();
      }
    } catch (e: unknown) {
      presentAlert({ message: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeArea style={styles.root}>
      <BlueSpacing20 />
      <BlueFormLabel>Mnemonic</BlueFormLabel>
      <BlueSpacing20 />
      <BlueFormMultiInput
        testID="SpeedMnemonicInput"
        value={importText}
        onChangeText={setImportText}
        editable={!loading && !stagedWallet}
      />
      <TextInput
        testID="SpeedWalletTypeInput"
        value={walletType}
        style={styles.pathInput}
        onChangeText={setWalletType}
        editable={!loading && !stagedWallet}
      />
      <TextInput
        testID="SpeedPassphraseInput"
        value={passphrase}
        style={styles.pathInput}
        onChangeText={setPassphrase}
        editable={!loading && !stagedWallet}
      />
      <View style={styles.center}>
        {loading ? <ActivityIndicator /> : <Button testID="SpeedDoImport" title="Import" onPress={importMnemonic} />}
      </View>
    </SafeArea>
  );
};

export default ImportSpeed;
