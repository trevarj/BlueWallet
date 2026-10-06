import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigation, useFocusEffect, useRoute } from '@react-navigation/native';
import type { RouteProp } from '@react-navigation/native';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';
import Icon from '../../components/Icon';
import { encodeUR } from '../../blue_modules/ur';
import { MultisigCosigner } from '../../class/multisig-cosigner';
import { HDSegwitBech32Wallet } from '../../class/wallets/hd-segwit-bech32-wallet';
import { MultisigHDWallet } from '../../class/wallets/multisig-hd-wallet';
import { convertExtendedKey } from '../../class/wallets/extended-key';
import { parseHardwareWalletAssociation, sameBhwiExtendedPublicKey } from '../../blue_modules/bhwi';
import type { BhwiMultisigFormat, HardwareWalletAssociation } from '../../blue_modules/bhwi';
import type { AddWalletStackParamList } from '../../navigation/AddWalletStack';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import presentAlert from '../../components/Alert';
import Button from '../../components/Button';
import { useTheme } from '../../components/themes';
import confirm from '../../helpers/confirm';
import prompt from '../../helpers/prompt';
import loc from '../../loc';
import { useStorage } from '../../hooks/context/useStorage';
import { useSettings } from '../../hooks/context/useSettings';
import MultipleStepsListItem, {
  MultipleStepsListItemButtonType,
  MultipleStepsListItemDashType,
} from '../../components/MultipleStepsListItem';
import { useScreenProtect } from '../../hooks/useScreenProtect';
import { BlueSpacing20 } from '../../components/BlueSpacing';

type CosignerTuple = [string, string | false, string | false, string?, HardwareWalletAssociation?];
type StaticCache = Record<string, string>;

const AnimatedFlatList = Animated.createAnimatedComponent(FlatList);

const WalletsAddMultisigStep2 = () => {
  const { addAndSaveWallet, sleep, currentSharedCosigner, setSharedCosigner } = useStorage();
  const { enableScreenProtect, disableScreenProtect } = useScreenProtect();
  const { colors } = useTheme();

  const navigation = useNavigation<NativeStackNavigationProp<AddWalletStackParamList, 'WalletsAddMultisigStep2'>>();
  const route = useRoute<RouteProp<AddWalletStackParamList, 'WalletsAddMultisigStep2'>>();
  const params = route.params;
  const { m, n, format, walletLabel, hardwareAndMobile = false, sheetAction, sheetImportText, sheetAskPassphrase, sheetSeedToken } = params;
  const [cosigners, setCosigners] = useState<CosignerTuple[]>([]); // array of cosigners user provided. if format [cosigner, fp, path]
  const [isLoading, setIsLoading] = useState(false);
  const [vaultKeyData, setVaultKeyData] = useState({
    keyIndex: 1,
    xpub: '',
    seed: '',
    isLoading: false,
  }); // string rendered in modal
  const [importText, setImportText] = useState('');
  const [askPassphrase, setAskPassphrase] = useState(false);
  const { isPrivacyBlurEnabled, isElectrumDisabled } = useSettings();
  const data = useRef(new Array(n).fill(null));
  const stagedWallet = useRef<MultisigHDWallet | undefined>(undefined);
  const handledHardwareAccount = useRef<HardwareWalletAssociation | undefined>(undefined);
  const staticCache = useRef<StaticCache>({});
  const generatedPhoneSeed = useRef<string | undefined>(undefined);
  const keyGeneration = useRef(0);
  const keyGenerationInFlight = useRef(false);
  const generatedPhoneSeedToken = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  const focused = useRef(false);
  const createGeneration = useRef(0);
  const createInFlight = useRef(false);
  const [backupAcknowledged, setBackupAcknowledged] = useState(false);

  useEffect(
    () => () => {
      mounted.current = false;
      focused.current = false;
      createGeneration.current += 1;
      createInFlight.current = false;
      keyGeneration.current += 1;
      keyGenerationInFlight.current = false;
      generatedPhoneSeedToken.current = undefined;
      staticCache.current = {};
      generatedPhoneSeed.current = undefined;
      stagedWallet.current = undefined;
      handledHardwareAccount.current = undefined;
    },
    [],
  );

  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      if (isPrivacyBlurEnabled) {
        enableScreenProtect();
      }
      return () => {
        focused.current = false;
        createGeneration.current += 1;
        createInFlight.current = false;
        if (keyGenerationInFlight.current) {
          keyGeneration.current += 1;
          keyGenerationInFlight.current = false;
          generatedPhoneSeedToken.current = undefined;
          setVaultKeyData(previous => ({ ...previous, seed: '', xpub: '', isLoading: false }));
        }
        setIsLoading(false);
        navigation.setOptions({ headerBackVisible: true });
        disableScreenProtect();
      };
    }, [isPrivacyBlurEnabled, enableScreenProtect, disableScreenProtect, navigation]),
  );

  useEffect(() => {
    if (hardwareAndMobile) return;
    console.log(currentSharedCosigner);
    if (currentSharedCosigner && !stagedWallet.current) {
      (async function () {
        if (await confirm(loc.multisig.shared_key_detected, loc.multisig.shared_key_detected_question)) {
          setImportText(currentSharedCosigner);
          navigation.navigate('WalletsAddMultisigProvideMnemonicsSheet', {
            importText: currentSharedCosigner,
            askPassphrase,
          });
          setSharedCosigner('');
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSharedCosigner, hardwareAndMobile]);

  const handleOnHelpPress = useCallback(() => {
    navigation.navigate('WalletsAddMultisigHelp');
  }, [navigation]);

  const renderHeaderRight = useCallback(
    () => (
      <Pressable
        accessibilityRole="button"
        style={({ pressed }) => [
          styles.helpButton,
          { backgroundColor: colors.buttonDisabledBackgroundColor },
          pressed && styles.helpButtonPressed,
        ]}
        onPress={handleOnHelpPress}
      >
        <Icon size={20} name="help-outline" type="material" color={colors.foregroundColor} />
        <Text style={[styles.helpButtonText, { color: colors.foregroundColor }]}>{loc.multisig.ms_help}</Text>
      </Pressable>
    ),
    [colors.buttonDisabledBackgroundColor, colors.foregroundColor, handleOnHelpPress],
  );

  const stylesHook = StyleSheet.create({
    root: {
      backgroundColor: colors.elevated,
    },
  });

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: renderHeaderRight,
    });
  }, [navigation, renderHeaderRight]);

  const creationIsCurrent = useCallback(
    (generation: number) => mounted.current && focused.current && createInFlight.current && createGeneration.current === generation,
    [],
  );

  const onCreate = async () => {
    if (createInFlight.current || !focused.current) return;
    createInFlight.current = true;
    const generation = ++createGeneration.current;
    setIsLoading(true);
    navigation.setOptions({ headerBackVisible: false });
    try {
      await sleep(100);
      if (!creationIsCurrent(generation)) return;
      const created = await _onCreate(generation);
      if (!creationIsCurrent(generation)) return;
      if (!created) {
        createInFlight.current = false;
        setIsLoading(false);
        navigation.setOptions({ headerBackVisible: true });
      }
    } catch (e) {
      if (!creationIsCurrent(generation)) return;
      createInFlight.current = false;
      setIsLoading(false);
      navigation.setOptions({ headerBackVisible: true });
      const message = e instanceof Error ? e.message : String(e);
      presentAlert({ message });
      console.log('create MS wallet error', e);
    }
  };

  const _onCreate = async (generation: number): Promise<boolean> => {
    if (!creationIsCurrent(generation)) return false;
    if (hardwareAndMobile) {
      const seed = generatedPhoneSeed.current;
      const local = cosigners.filter(cosigner => !cosigner[4] && cosigner[0] === seed);
      const hardware = cosigners.filter(cosigner => !!cosigner[4]);
      const association = hardware.length === 1 ? parseHardwareWalletAssociation(hardware[0]?.[4]) : undefined;
      const path = MultisigHDWallet.PATH_NATIVE_SEGWIT;
      if (
        m !== 2 ||
        n !== 2 ||
        format !== MultisigHDWallet.FORMAT_P2WSH ||
        !backupAcknowledged ||
        !seed ||
        local.length !== 1 ||
        hardware.length !== 1 ||
        cosigners.length !== 2 ||
        !association ||
        association.format !== 'multisig-native' ||
        association.path !== path ||
        sameBhwiExtendedPublicKey(MultisigHDWallet.seedToXpub(seed, path), association.xpub)
      ) {
        throw new Error(!backupAcknowledged ? loc.multisig.backup_required : loc.multisig.hardware_and_mobile_invalid);
      }
    }
    let w = stagedWallet.current;
    if (!w) {
      w = new MultisigHDWallet();
      w.setM(m);
      switch (format) {
        case MultisigHDWallet.FORMAT_P2WSH:
          w.setNativeSegwit();
          w.setDerivationPath(MultisigHDWallet.PATH_NATIVE_SEGWIT);
          break;
        case MultisigHDWallet.FORMAT_P2SH_P2WSH:
        case MultisigHDWallet.FORMAT_P2SH_P2WSH_ALT:
          w.setWrappedSegwit();
          w.setDerivationPath(MultisigHDWallet.PATH_WRAPPED_SEGWIT);
          break;
        case MultisigHDWallet.FORMAT_P2SH:
          w.setLegacy();
          w.setDerivationPath(MultisigHDWallet.PATH_LEGACY);
          break;
        default:
          console.error('Unexpected format:', format);
          throw new Error('This should never happen');
      }
      for (const cc of cosigners) {
        const fp = (cc[1] || getFpCacheForMnemonics(cc[0], cc[3])) as string;
        const path = typeof cc[2] === 'string' && cc[2] ? cc[2] : getPath();
        w.addCosigner(cc[0], fp, path, cc[3]);
        if (cc[4]) w.addHardwareWalletAssociation(cc[4]);
      }
      w.setLabel(walletLabel);
      if (!isElectrumDisabled) {
        await w.fetchBalance();
        if (!creationIsCurrent(generation)) return false;
      }
      if (!creationIsCurrent(generation)) return false;
      stagedWallet.current = w;
    }

    if (!creationIsCurrent(generation)) return false;
    const saved = await addAndSaveWallet(w);
    if (!creationIsCurrent(generation) || !saved) return false;
    stagedWallet.current = undefined;
    generatedPhoneSeed.current = undefined;
    handledHardwareAccount.current = undefined;
    keyGeneration.current += 1;
    keyGenerationInFlight.current = false;
    generatedPhoneSeedToken.current = undefined;
    staticCache.current = {};
    setVaultKeyData({ keyIndex: 1, xpub: '', seed: '', isLoading: false });
    navigation.getParent()?.goBack();
    return true;
  };

  const getPath = useCallback(() => {
    let path = '';
    switch (format) {
      case MultisigHDWallet.FORMAT_P2WSH:
        path = MultisigHDWallet.PATH_NATIVE_SEGWIT;
        break;
      case MultisigHDWallet.FORMAT_P2SH_P2WSH:
      case MultisigHDWallet.FORMAT_P2SH_P2WSH_ALT:
        path = MultisigHDWallet.PATH_WRAPPED_SEGWIT;
        break;
      case MultisigHDWallet.FORMAT_P2SH:
        path = MultisigHDWallet.PATH_LEGACY;
        break;
      default:
        console.error('Unexpected format:', format);
        throw new Error('This should never happen');
    }
    return path;
  }, [format]);

  const setXpubCacheForMnemonics = useCallback(
    (seed: string, passphrase?: string) => {
      const path = getPath();
      staticCache.current[seed + path + passphrase] = convertExtendedKey(
        MultisigHDWallet.seedToXpub(seed, path, passphrase),
        format === MultisigHDWallet.FORMAT_P2WSH ? 'multisigNative' : format === MultisigHDWallet.FORMAT_P2SH ? 'legacy' : 'multisigNested',
      );
      return staticCache.current[seed + path + passphrase];
    },
    [format, getPath],
  );

  const setFpCacheForMnemonics = useCallback((seed: string, passphrase?: string) => {
    staticCache.current[seed + (passphrase ?? '')] = MultisigHDWallet.mnemonicToFingerprint(seed, passphrase);
    return staticCache.current[seed + (passphrase ?? '')];
  }, []);

  const getXpubCacheForMnemonics = useCallback(
    (seed: string, passphrase?: string) => {
      const path = getPath();
      return staticCache.current[seed + path + passphrase] || setXpubCacheForMnemonics(seed, passphrase);
    },
    [getPath, setXpubCacheForMnemonics],
  );

  const getFpCacheForMnemonics = useCallback(
    (seed: string, passphrase?: string) => {
      return staticCache.current[seed + (passphrase ?? '')] || setFpCacheForMnemonics(seed, passphrase);
    },
    [setFpCacheForMnemonics],
  );

  const generateNewKey = useCallback(() => {
    if (stagedWallet.current || keyGenerationInFlight.current || (hardwareAndMobile && cosigners.length !== 0)) return;
    keyGenerationInFlight.current = true;
    const generation = ++keyGeneration.current;
    const seedToken = `key-${generation}`;
    const w = new HDSegwitBech32Wallet();
    w.generate()
      .then(() => {
        if (!mounted.current || keyGeneration.current !== generation) return;
        keyGenerationInFlight.current = false;
        const seed = w.getSecret();
        if (hardwareAndMobile) {
          generatedPhoneSeed.current = seed;
          generatedPhoneSeedToken.current = seedToken;
          setBackupAcknowledged(false);
        }
        const cosignersCopy = [...cosigners, [seed, false, false] as CosignerTuple];
        setCosigners(cosignersCopy);
        setXpubCacheForMnemonics(seed);
        setFpCacheForMnemonics(seed);
        setVaultKeyData({
          keyIndex: cosignersCopy.length,
          seed,
          xpub: '',
          isLoading: false,
        });
        setIsLoading(false);
        navigation.navigate('WalletsAddMultisigVaultKeySheet', {
          keyIndex: cosignersCopy.length,
          seed,
          requireBackupAcknowledgement: hardwareAndMobile,
          seedToken,
        });
      })
      .catch(error => {
        if (!mounted.current || keyGeneration.current !== generation) return;
        keyGenerationInFlight.current = false;
        setIsLoading(false);
        setVaultKeyData(previous => ({ ...previous, isLoading: false }));
        presentAlert({ message: error instanceof Error ? error.message : String(error) });
      });
  }, [cosigners, hardwareAndMobile, navigation, setFpCacheForMnemonics, setXpubCacheForMnemonics]);

  const viewKey = useCallback(
    (cosigner: CosignerTuple) => {
      if (hardwareAndMobile && cosigner[0] === generatedPhoneSeed.current) {
        navigation.navigate('WalletsAddMultisigVaultKeySheet', {
          keyIndex: 1,
          seed: cosigner[0],
          requireBackupAcknowledgement: true,
          seedToken: generatedPhoneSeedToken.current,
        });
        return;
      }
      if (MultisigHDWallet.isXpubValid(cosigner[0])) {
        const cosignerJson = MultisigCosigner.exportToJson(cosigner[1] as string, cosigner[0], cosigner[2] as string);
        const cosignerUR = encodeUR(cosignerJson, 175, null)[0];
        const filename = 'bw-cosigner-' + cosigner[1] + '.bwcosigner';
        navigation.navigate('WalletsAddMultisigCosignerXpubSheet', {
          cosignerXpub: cosignerJson,
          cosignerXpubURv2: cosignerUR,
          cosignerXpubFilename: filename,
        });
      } else {
        const path = getPath();

        const xpub = getXpubCacheForMnemonics(cosigner[0], cosigner[3]);
        const fp = getFpCacheForMnemonics(cosigner[0], cosigner[3]);
        const cosignerJson = MultisigCosigner.exportToJson(fp, xpub, path);
        const cosignerUR = encodeUR(cosignerJson, 175, null)[0];
        const filename = 'bw-cosigner-' + fp + '.bwcosigner';
        navigation.navigate('WalletsAddMultisigCosignerXpubSheet', {
          cosignerXpub: cosignerJson,
          cosignerXpubURv2: cosignerUR,
          cosignerXpubFilename: filename,
        });
      }
    },
    [getPath, getFpCacheForMnemonics, getXpubCacheForMnemonics, hardwareAndMobile, navigation],
  );

  const iHaveMnemonics = useCallback(() => {
    if (stagedWallet.current) return;
    navigation.navigate('WalletsAddMultisigProvideMnemonicsSheet', {
      importText,
      askPassphrase,
    });
  }, [askPassphrase, importText, navigation]);

  const tryUsingXpub = useCallback(
    async (xpub: string, fp?: string, path?: string) => {
      if (hardwareAndMobile) return;
      if (stagedWallet.current) return;
      if (!MultisigHDWallet.isXpubForMultisig(xpub)) {
        setIsLoading(false);
        setImportText('');
        setAskPassphrase(false);
        presentAlert({ message: loc.multisig.not_a_multisignature_xpub });
        return;
      }
      if (fp) {
        //  do nothing, it's already set
      } else {
        try {
          fp = await prompt(loc.multisig.input_fp, loc.multisig.input_fp_explain, { type: 'plain-text' });
          fp = (fp + '').toUpperCase();
          if (!MultisigHDWallet.isFpValid(fp)) fp = '00000000';
        } catch (e) {
          return setIsLoading(false);
        }
      }
      if (path) {
        //  do nothing, it's already set
      } else {
        try {
          path = await prompt(
            loc.multisig.input_path,
            loc.formatString(loc.multisig.input_path_explain, {
              default: getPath(),
            }),
            {
              type: 'plain-text',
            },
          );
          if (!MultisigHDWallet.isPathValid(path)) path = getPath();
        } catch {
          return setIsLoading(false);
        }
      }

      setIsLoading(false);
      setImportText('');
      setAskPassphrase(false);

      const cosignersCopy = [...cosigners];
      cosignersCopy.push([xpub, fp ?? false, path ?? false]);
      setCosigners(cosignersCopy);
    },
    [cosigners, getPath, hardwareAndMobile],
  );

  const hardwareMultisigFormat: BhwiMultisigFormat | undefined =
    format === MultisigHDWallet.FORMAT_P2WSH
      ? 'multisig-native'
      : format === MultisigHDWallet.FORMAT_P2SH_P2WSH || format === MultisigHDWallet.FORMAT_P2SH_P2WSH_ALT
        ? 'multisig-wrapped'
        : undefined;

  const addHardwareCosigner = useCallback(
    (value: HardwareWalletAssociation) => {
      if (
        stagedWallet.current ||
        !hardwareMultisigFormat ||
        (hardwareAndMobile && (cosigners.length !== 1 || cosigners[0]?.[0] !== generatedPhoneSeed.current))
      )
        return;
      const association = parseHardwareWalletAssociation(value);
      if (
        !association ||
        association.format !== hardwareMultisigFormat ||
        (hardwareAndMobile && association.path !== MultisigHDWallet.PATH_NATIVE_SEGWIT)
      ) {
        presentAlert({ message: loc.multisig.invalid_cosigner });
        return;
      }
      if (
        cosigners.some(existing => {
          const existingXpub = MultisigHDWallet.isXpubValid(existing[0]) ? existing[0] : getXpubCacheForMnemonics(existing[0], existing[3]);
          return sameBhwiExtendedPublicKey(existingXpub, association.xpub);
        })
      ) {
        presentAlert({ message: loc.multisig.this_cosigner_is_already_imported });
        return;
      }
      const xpub = convertExtendedKey(association.xpub, hardwareMultisigFormat === 'multisig-native' ? 'multisigNative' : 'multisigNested');
      if (!MultisigHDWallet.isXpubForMultisig(xpub)) {
        presentAlert({ message: loc.multisig.invalid_cosigner });
        return;
      }
      const hardwareCosigner: CosignerTuple = [xpub, association.fingerprint, association.path, undefined, association];
      setCosigners([...cosigners, hardwareCosigner]);
    },
    [cosigners, getXpubCacheForMnemonics, hardwareAndMobile, hardwareMultisigFormat],
  );

  const importHardwareCosigner = useCallback(() => {
    if (
      stagedWallet.current ||
      !hardwareMultisigFormat ||
      (hardwareAndMobile && (cosigners.length !== 1 || cosigners[0]?.[0] !== generatedPhoneSeed.current))
    )
      return;
    navigation.navigate('HardwareWalletAccount', {
      mode: 'multisig-cosigner',
      format: hardwareMultisigFormat,
      returnTo: 'WalletsAddMultisigStep2',
    });
  }, [cosigners, hardwareAndMobile, hardwareMultisigFormat, navigation]);

  useEffect(() => {
    if (!params.hardwareAccount) {
      handledHardwareAccount.current = undefined;
      return;
    }
    const account = params.hardwareAccount;
    if (handledHardwareAccount.current === account) return;
    handledHardwareAccount.current = account;
    navigation.setParams({ hardwareAccount: undefined });
    addHardwareCosigner(account);
  }, [addHardwareCosigner, navigation, params.hardwareAccount]);

  const isValidMnemonicSeed = (mnemonicSeed: string) => {
    const hd = new HDSegwitBech32Wallet();
    hd.setSecret(mnemonicSeed);
    return hd.validateMnemonic();
  };

  const utilizeMnemonicPhrase = useCallback(
    async (overrideText?: string, overrideAskPassphrase?: boolean) => {
      if (hardwareAndMobile) return;
      if (stagedWallet.current) return;
      const textToUse = overrideText ?? importText;
      const askForPassphrase = overrideAskPassphrase ?? askPassphrase;
      setIsLoading(true);

      if (MultisigHDWallet.isXpubValid(textToUse)) {
        return tryUsingXpub(textToUse);
      }
      try {
        const jsonText = JSON.parse(textToUse);
        let fp;
        let path;
        if (jsonText.xpub) {
          if (jsonText.xfp) {
            fp = jsonText.xfp;
          }
          if (jsonText.path) {
            path = jsonText.path;
          }
          return tryUsingXpub(jsonText.xpub, fp, path);
        }
      } catch {}
      const hd = new HDSegwitBech32Wallet();
      hd.setSecret(textToUse);
      if (!hd.validateMnemonic()) {
        setIsLoading(false);
        return presentAlert({ message: loc.multisig.invalid_mnemonics });
      }

      let passphrase: string | undefined;
      if (askForPassphrase) {
        try {
          passphrase = await prompt(loc.wallets.import_passphrase_title, loc.wallets.import_passphrase_message);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          if (message === 'Cancel Pressed') {
            setIsLoading(false);
            return;
          }
          throw e;
        }
      }

      const cosignersCopy = [...cosigners];
      cosignersCopy.push([hd.getSecret(), false, false, passphrase]);
      setCosigners(cosignersCopy);

      setIsLoading(false);
      setImportText('');
      setAskPassphrase(false);
    },
    [askPassphrase, cosigners, hardwareAndMobile, importText, tryUsingXpub],
  );

  const onBarScanned = useCallback(
    async (ret: { data?: string } | string) => {
      if (hardwareAndMobile) return;
      if (stagedWallet.current) return;
      const payload = typeof ret === 'string' ? { data: ret } : ret;
      const dataString = payload.data ?? '';

      try {
        let retData = JSON.parse(dataString);
        if (Array.isArray(retData) && retData.length === 1) {
          // UR:CRYPTO-ACCOUNT now parses as an array of accounts, even if it is just one,
          // so in case of cosigner data its gona be an array of 1 cosigner account. lets pop it for
          // the code that expects it
          retData = retData.pop();
          payload.data = JSON.stringify(retData);
        }
      } catch (e) {
        console.debug('JSON parsing failed for returnedData:', e);
      }

      if ((payload.data ?? '').toUpperCase().startsWith('UR')) {
        presentAlert({
          message: 'BC-UR not decoded. This should never happen',
        });
      } else if (isValidMnemonicSeed(payload.data ?? '')) {
        utilizeMnemonicPhrase(payload.data ?? '', askPassphrase);
      } else {
        if (payload.data && MultisigHDWallet.isXpubValid(payload.data) && !MultisigHDWallet.isXpubForMultisig(payload.data)) {
          return presentAlert({
            message: loc.multisig.not_a_multisignature_xpub,
          });
        }
        if (payload.data && MultisigHDWallet.isXpubValid(payload.data)) {
          return tryUsingXpub(payload.data);
        }
        if (!payload.data) {
          return presentAlert({ message: loc.multisig.invalid_cosigner });
        }

        let cosigner = new MultisigCosigner(payload.data);
        if (!cosigner.isValid()) {
          return presentAlert({ message: loc.multisig.invalid_cosigner });
        }

        if (cosigner.howManyCosignersWeHave() > 1) {
          // lets look for the correct cosigner. thats probably gona be the one with specific corresponding path,
          // for example m/48'/0'/0'/2' if user chose to setup native segwit in BW
          for (const cc of cosigner.getAllCosigners()) {
            switch (format) {
              case MultisigHDWallet.FORMAT_P2WSH:
                if (cc.getPath().startsWith('m/48') && cc.getPath().endsWith("/2'")) {
                  // found it
                  cosigner = cc;
                }
                break;
              case MultisigHDWallet.FORMAT_P2SH_P2WSH:
              case MultisigHDWallet.FORMAT_P2SH_P2WSH_ALT:
                if (cc.getPath().startsWith('m/48') && cc.getPath().endsWith("/1'")) {
                  // found it
                  cosigner = cc;
                }
                break;
              case MultisigHDWallet.FORMAT_P2SH:
                if (cc.getPath().startsWith('m/45')) {
                  // found it
                  cosigner = cc;
                }
                break;
              default:
                console.error('Unexpected format:', format);
                throw new Error('This should never happen');
            }
          }
        }

        for (const existingCosigner of cosigners) {
          let existingXpub = existingCosigner[0];
          if (!MultisigHDWallet.isXpubValid(existingXpub)) {
            // derive the xpub from mnemonic-based cosigner
            existingXpub = getXpubCacheForMnemonics(existingCosigner[0], existingCosigner[3]);
          }
          if (existingXpub === cosigner.getXpub()) {
            return presentAlert({
              message: loc.multisig.this_cosigner_is_already_imported,
            });
          }
        }
        // now, validating that cosigner is in correct format:

        let correctFormat = false;
        switch (format) {
          case MultisigHDWallet.FORMAT_P2WSH:
            if (cosigner.getPath().startsWith('m/48') && cosigner.getPath().endsWith("/2'")) {
              correctFormat = true;
            }
            break;
          case MultisigHDWallet.FORMAT_P2SH_P2WSH:
          case MultisigHDWallet.FORMAT_P2SH_P2WSH_ALT:
            if (cosigner.getPath().startsWith('m/48') && cosigner.getPath().endsWith("/1'")) {
              correctFormat = true;
            }
            break;
          case MultisigHDWallet.FORMAT_P2SH:
            if (cosigner.getPath().startsWith('m/45')) {
              correctFormat = true;
            }
            break;
          default:
            console.error('Unexpected format:', format);
            throw new Error('This should never happen');
        }
        if (!correctFormat) {
          return presentAlert({
            message: loc.formatString(loc.multisig.invalid_cosigner_format, {
              format,
            }),
          });
        }
        const cosignersCopy = [...cosigners];
        cosignersCopy.push([cosigner.getXpub(), cosigner.getFp(), cosigner.getPath()]);
        setCosigners(cosignersCopy);
      }
    },
    [askPassphrase, cosigners, format, getXpubCacheForMnemonics, hardwareAndMobile, tryUsingXpub, utilizeMnemonicPhrase],
  );

  useEffect(() => {
    const scannedData = params.onBarScanned;
    if (scannedData) {
      onBarScanned(scannedData);
      navigation.setParams({ onBarScanned: undefined });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigation, params.onBarScanned]);

  useEffect(() => {
    if (!sheetAction || (sheetAction === 'backupAcknowledged' && sheetSeedToken !== generatedPhoneSeedToken.current)) return;

    if (sheetAction === 'backupAcknowledged' && hardwareAndMobile && generatedPhoneSeed.current) {
      setBackupAcknowledged(true);
    } else if (sheetAction === 'importMnemonic' && !hardwareAndMobile) {
      setImportText(sheetImportText ?? '');
      setAskPassphrase(!!sheetAskPassphrase);
      utilizeMnemonicPhrase(sheetImportText ?? '', sheetAskPassphrase ?? askPassphrase);
    }

    navigation.setParams({
      sheetAction: undefined,
      sheetImportText: undefined,
      sheetAskPassphrase: undefined,
      sheetSeedToken: undefined,
    });
  }, [
    askPassphrase,
    hardwareAndMobile,
    navigation,
    sheetAction,
    sheetAskPassphrase,
    sheetImportText,
    sheetSeedToken,
    utilizeMnemonicPhrase,
  ]);

  const dashType = useCallback(
    ({ index, lastIndex, isChecked, isFocus }: { index: number; lastIndex: number; isChecked: boolean; isFocus: boolean }) => {
      if (isChecked) {
        return index === lastIndex ? MultipleStepsListItemDashType.Top : MultipleStepsListItemDashType.TopAndBottom;
      }
      if (index === lastIndex) {
        return isFocus ? MultipleStepsListItemDashType.TopAndBottom : MultipleStepsListItemDashType.Top;
      }
      return MultipleStepsListItemDashType.TopAndBottom;
    },
    [],
  );

  const _renderKeyItem = (el: { index: number }) => {
    const renderProvideKeyButtons = el.index === cosigners.length;
    const isChecked = el.index < cosigners.length;
    return (
      <View>
        <MultipleStepsListItem
          circledText={String(el.index + 1)}
          leftText={loc.formatString(loc.multisig.vault_key, {
            number: el.index + 1,
          })}
          dashes={dashType({
            index: el.index,
            lastIndex: data.current.length - 1,
            isChecked,
            isFocus: renderProvideKeyButtons,
          })}
          checked={isChecked}
          rightButton={{
            disabled: vaultKeyData.isLoading,
            text: hardwareAndMobile && cosigners[el.index]?.[0] === generatedPhoneSeed.current ? loc.multisig.view : loc.multisig.share,
            onPress: () => {
              viewKey(cosigners[el.index]);
            },
          }}
        />
        {renderProvideKeyButtons && (
          <>
            {(!hardwareAndMobile || cosigners.length === 0) && (
              <MultipleStepsListItem
                showActivityIndicator={vaultKeyData.keyIndex === el.index && vaultKeyData.isLoading}
                button={{
                  testID: 'VaultKeyGenerate',
                  buttonType: MultipleStepsListItemButtonType.Full,
                  onPress: () => {
                    setVaultKeyData({
                      keyIndex: el.index,
                      xpub: '',
                      seed: '',
                      isLoading: true,
                    });
                    generateNewKey();
                  },
                  text: loc.multisig.create_new_key,
                  disabled: vaultKeyData.isLoading,
                }}
                dashes={MultipleStepsListItemDashType.TopAndBottom}
                checked={isChecked}
              />
            )}
            {hardwareMultisigFormat && (!hardwareAndMobile || cosigners.length === 1) && (
              <MultipleStepsListItem
                button={{
                  testID: 'VaultHardwareCosigner' + String(el.index + 1),
                  onPress: importHardwareCosigner,
                  buttonType: MultipleStepsListItemButtonType.Full,
                  text: loc.wallets.hardware_import,
                  disabled: vaultKeyData.isLoading,
                }}
                dashes={MultipleStepsListItemDashType.TopAndBottom}
                checked={isChecked}
              />
            )}
            {!hardwareAndMobile && (
              <MultipleStepsListItem
                button={{
                  testID: 'VaultCosignerImport' + String(el.index + 1),
                  onPress: iHaveMnemonics,
                  buttonType: MultipleStepsListItemButtonType.Full,
                  text: loc.wallets.import_do_import,
                  disabled: vaultKeyData.isLoading,
                }}
                dashes={
                  el.index === data.current.length - 1 ? MultipleStepsListItemDashType.Top : MultipleStepsListItemDashType.TopAndBottom
                }
                checked={isChecked}
              />
            )}
          </>
        )}
      </View>
    );
  };

  const footer = (
    <View style={styles.buttonBottom}>
      {isLoading ? (
        <ActivityIndicator />
      ) : (
        <Button
          testID="CreateButton"
          title={loc.multisig.create}
          onPress={onCreate}
          disabled={cosigners.length !== n || (hardwareAndMobile && !backupAcknowledged)}
        />
      )}
    </View>
  );

  return (
    <View style={[styles.root, stylesHook.root]}>
      <View style={styles.wrapBox}>
        <AnimatedFlatList
          data={data.current}
          renderItem={_renderKeyItem}
          keyExtractor={(_item, index) => `${index}`}
          extraData={cosigners}
        />
      </View>
      {footer}
      <BlueSpacing20 />
    </View>
  );
};

const styles = StyleSheet.create({
  root: {
    flex: 1,
    paddingHorizontal: 20,
  },
  wrapBox: {
    flex: 1,
    marginVertical: 24,
  },
  buttonBottom: {
    marginHorizontal: 20,
    flex: 0.12,
    marginBottom: 40,
    justifyContent: 'flex-end',
  },
  helpButton: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 50,
    flexDirection: 'row',
    alignItems: 'center',
  },
  helpButtonText: {
    fontSize: 16,
    fontWeight: 'bold',
    marginLeft: 8,
  },
  helpButtonPressed: {
    opacity: 0.75,
  },
});

export default WalletsAddMultisigStep2;
