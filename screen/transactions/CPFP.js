import React, { Component, useRef } from 'react';
import { ActivityIndicator, Linking, Platform, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import PropTypes from 'prop-types';
import * as BlueElectrum from '../../blue_modules/BlueElectrum';
import triggerHapticFeedback, { HapticFeedbackTypes } from '../../blue_modules/hapticFeedback';
import BlueCard from '../../components/BlueCard';
import BlueText from '../../components/BlueText';
import { HDSegwitBech32Transaction } from '../../class/hd-segwit-bech32-transaction';
import { HDSegwitBech32Wallet } from '../../class/wallets/hd-segwit-bech32-wallet';
import presentAlert, { AlertType } from '../../components/Alert';
import Button from '../../components/Button';
import SafeArea from '../../components/SafeArea';
import SafeAreaScrollView from '../../components/SafeAreaScrollView';
import { BlueCurrentTheme } from '../../components/themes';
import loc from '../../loc';
import { StorageContext } from '../../components/Context/StorageProvider';
import ReplaceFeeSuggestions from '../../components/ReplaceFeeSuggestions';
import { majorTomToGroundControl } from '../../blue_modules/notifications';
import { BlueSpacing, BlueSpacing20 } from '../../components/BlueSpacing';
import { useKeyboard } from '../../hooks/useKeyboard';
import { isAssociatedWatchOnlySegwitBech32 } from '../../util/isWatchOnlySegwitBech32';
import { BHWI_SIGNING_SESSION_EXPIRED, bhwiAssociationIdentity, bhwiWatchOnlyWalletIdentity } from '../../blue_modules/bhwiPsbt';

const styles = StyleSheet.create({
  root: {
    flex: 1,
    paddingTop: 20,
  },
  scrollContent: {
    flexGrow: 1,
  },
  stage: {
    paddingTop: 16,
  },
  center: {
    alignItems: 'center',
    flex: 1,
  },
  hex: {
    color: BlueCurrentTheme.colors.buttonAlternativeTextColor,
    fontWeight: '500',
  },
  hexInput: {
    borderColor: '#ebebeb',
    backgroundColor: '#d2f8d6',
    borderRadius: 4,
    marginTop: 20,
    color: '#37c0a1',
    fontWeight: '500',
    fontSize: 14,
    paddingHorizontal: 16,
    paddingBottom: 16,
    paddingTop: 16,
  },
  action: {
    marginVertical: 24,
  },
  actionText: {
    color: '#9aa0aa',
    fontSize: 15,
    fontWeight: '500',
    alignSelf: 'center',
  },
});

const FeeSelectionLayout = ({ children }) => {
  const scrollRef = useRef(null);
  const { height: keyboardHeight, isVisible } = useKeyboard();
  const androidKeyboardInset = Platform.OS === 'android' && isVisible ? keyboardHeight + 24 : 0;

  const scrollFocusedFieldIntoView = () => {
    if (androidKeyboardInset > 0) {
      scrollRef.current?.scrollToEnd({ animated: true });
    }
  };

  return (
    <SafeAreaScrollView
      ref={scrollRef}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
      floatingButtonHeight={androidKeyboardInset}
      contentContainerStyle={styles.scrollContent}
      onContentSizeChange={scrollFocusedFieldIntoView}
    >
      {children}
    </SafeAreaScrollView>
  );
};

FeeSelectionLayout.propTypes = {
  children: PropTypes.node,
};

export default class CPFP extends Component {
  static contextType = StorageContext;
  constructor(props) {
    super(props);
    let txid;
    let wallet;
    if (props.route.params) txid = props.route.params.txid;
    if (props.route.params) wallet = props.route.params.wallet;
    this._isMounted = true;

    this.state = {
      isLoading: true,
      stage: 1,
      txid,
      wallet,
      isElectrumDisabled: true,
    };
  }

  broadcast = () => {
    this.setState({ isLoading: true }, async () => {
      try {
        if (!(await BlueElectrum.ensureConnected())) {
          throw new Error(loc.errors.network);
        }
        const result = await this.state.wallet.broadcastTx(this.state.txhex);
        if (result) {
          this.onSuccessBroadcast();
        } else {
          triggerHapticFeedback(HapticFeedbackTypes.NotificationError);
          this.setState({ isLoading: false });
          presentAlert({ message: loc.errors.broadcast });
        }
      } catch (error) {
        triggerHapticFeedback(HapticFeedbackTypes.NotificationError);
        this.setState({ isLoading: false });
        presentAlert({ message: error.message, type: AlertType.Toast });
      }
    });
  };

  onSuccessBroadcast() {
    this.context.txMetadata[this.state.newTxid] = { memo: 'Child pays for parent (CPFP)' };
    majorTomToGroundControl([], [], [this.state.newTxid]);
    this.context.sleep(4000).then(() => this.context.fetchAndSaveWalletTransactions(this.state.wallet.getID()));
    this.props.navigation.navigate('Success', {
      amount: undefined,
      walletID: this.state.wallet.getID(),
      walletType: this.state.wallet.type,
    });
  }

  componentWillUnmount() {
    this._isMounted = false;
  }

  async componentDidMount() {
    console.log('transactions/CPFP - componentDidMount');
    this.setState({
      isLoading: true,
      newFeeRate: '',
      nonReplaceable: false,
    });
    try {
      await this.checkPossibilityOfCPFP();
    } catch (_) {
      // if anything goes wrong we just show "this is not bumpable" message
      if (this._isMounted) this.setState({ nonReplaceable: true, isLoading: false });
    }
  }

  async checkPossibilityOfCPFP() {
    const wallet = this.state.wallet;
    let tx;
    if (isAssociatedWatchOnlySegwitBech32(wallet)) {
      tx = new HDSegwitBech32Transaction(null, this.state.txid, wallet._hdWalletInstance, wallet.getMasterFingerprint());
    } else if (wallet?.type === HDSegwitBech32Wallet.type) {
      tx = new HDSegwitBech32Transaction(null, this.state.txid, wallet);
    } else {
      return this.setState({ nonReplaceable: true, isLoading: false });
    }

    const association = isAssociatedWatchOnlySegwitBech32(wallet) ? wallet.getHardwareWalletAssociation() : undefined;
    const associationIdentity = association ? bhwiAssociationIdentity(association) : undefined;
    const walletIdentity = association ? bhwiWatchOnlyWalletIdentity(wallet, association) : undefined;
    const isCurrent = () => {
      if (!this._isMounted || this.props.navigation.isFocused?.() === false || this.state.wallet !== wallet) return false;
      if (!association) return true;
      const liveWallet = this.context.wallets.find(candidate => candidate.getID() === wallet.getID());
      const liveAssociation = isAssociatedWatchOnlySegwitBech32(liveWallet) ? liveWallet.getHardwareWalletAssociation() : undefined;
      return (
        !!liveAssociation &&
        bhwiAssociationIdentity(liveAssociation) === associationIdentity &&
        bhwiWatchOnlyWalletIdentity(liveWallet, liveAssociation) === walletIdentity
      );
    };

    const isToUs = await tx.isToUsTransaction();
    if (!isCurrent()) return;
    const confirmations = await tx.getRemoteConfirmationsNum();
    if (!isCurrent()) return;
    if (isToUs && confirmations === 0) {
      const info = await tx.getInfo();
      if (!isCurrent()) return;
      return this.setState({
        nonReplaceable: false,
        feeRate: info.feeRate + 1,
        isLoading: false,
        parentFee: info.fee,
        parentVsize: info.parentVsize,
        tx,
      });
      // 1 sat makes a lot of difference, since sometimes because of rounding created tx's fee might be insufficient
    }
    return this.setState({ nonReplaceable: true, isLoading: false });
  }

  async createTransaction() {
    const newFeeRate = Number(this.state.newFeeRate);
    if (newFeeRate > this.state.feeRate) {
      /** @type {HDSegwitBech32Transaction} */
      const tx = this.state.tx;
      const { parentFee, parentVsize } = this.state;
      const hardwareWallet = isAssociatedWatchOnlySegwitBech32(this.state.wallet) ? this.state.wallet : undefined;
      const hardwareAssociation = hardwareWallet?.getHardwareWalletAssociation();
      const hardwareWalletIdentity =
        hardwareWallet && hardwareAssociation ? bhwiWatchOnlyWalletIdentity(hardwareWallet, hardwareAssociation) : undefined;
      const hardwareAssociationIdentity = hardwareAssociation ? bhwiAssociationIdentity(hardwareAssociation) : undefined;
      this.setState({ isLoading: true });
      try {
        const { tx: newTx, psbt } = await tx.createCPFPbumpFee(newFeeRate);
        if (hardwareWallet) {
          const liveWallet = this.context.wallets.find(candidate => candidate.getID() === hardwareWallet.getID());
          const liveAssociation = isAssociatedWatchOnlySegwitBech32(liveWallet) ? liveWallet.getHardwareWalletAssociation() : undefined;
          if (
            !this._isMounted ||
            this.state.tx !== tx ||
            this.props.navigation.isFocused?.() === false ||
            !liveAssociation ||
            bhwiWatchOnlyWalletIdentity(liveWallet, liveAssociation) !== hardwareWalletIdentity ||
            bhwiAssociationIdentity(liveAssociation) !== hardwareAssociationIdentity
          ) {
            throw new Error(BHWI_SIGNING_SESSION_EXPIRED);
          }
          this.props.navigation
            .getParent()
            ?.getParent()
            ?.navigate('SendDetailsRoot', {
              screen: 'PsbtWithHardwareWallet',
              params: {
                memo: 'Child pays for parent (CPFP)',
                walletID: liveWallet.getID(),
                psbt,
                cpfp: {
                  parentFee,
                  parentVsize,
                  targetFeeRate: newFeeRate,
                },
              },
            });
          if (this._isMounted) this.setState({ isLoading: false });
          return;
        }
        if (!newTx) throw new Error('Signed CPFP transaction missing');
        if (this._isMounted) this.setState({ stage: 2, txhex: newTx.toHex(), newTxid: newTx.getId(), isLoading: false });
      } catch (_) {
        if (this._isMounted) {
          this.setState({ isLoading: false });
          presentAlert({ message: loc.errors.error + ': ' + _.message });
        }
      }
    }
  }

  renderStage1(text) {
    return (
      <View style={styles.stage}>
        <BlueCard>
          <BlueText>{text}</BlueText>
          <BlueSpacing20 />
          <ReplaceFeeSuggestions onFeeSelected={fee => this.setState({ newFeeRate: fee })} transactionMinimum={this.state.feeRate} />
          <BlueSpacing />
          <Button
            disabled={this.state.newFeeRate <= this.state.feeRate || !Number.isFinite(this.state.newFeeRate)}
            onPress={() => this.createTransaction()}
            title={loc.transactions.cpfp_create}
          />
        </BlueCard>
      </View>
    );
  }

  renderFeeSelection(text) {
    return <FeeSelectionLayout>{this.renderStage1(text)}</FeeSelectionLayout>;
  }

  renderStage2() {
    return (
      <View style={styles.root}>
        <BlueCard style={styles.center}>
          <BlueText style={styles.hex}>{loc.send.create_this_is_hex}</BlueText>
          <TextInput style={styles.hexInput} height={112} multiline editable value={this.state.txhex} />

          <TouchableOpacity accessibilityRole="button" style={styles.action} onPress={() => Clipboard.setString(this.state.txhex)}>
            <Text style={styles.actionText}>{loc.send.create_copy}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityRole="button"
            style={styles.action}
            onPress={() => Linking.openURL('https://coinb.in/?verify=' + this.state.txhex)}
          >
            <Text style={styles.actionText}>{loc.send.create_verify}</Text>
          </TouchableOpacity>
          <Button disabled={this.context.isElectrumDisabled} onPress={this.broadcast} title={loc.send.confirm_sendNow} />
        </BlueCard>
      </View>
    );
  }

  render() {
    if (this.state.isLoading) {
      return (
        <View style={styles.root}>
          <ActivityIndicator />
        </View>
      );
    }

    if (this.state.stage === 2) {
      return this.renderStage2();
    }

    if (this.state.nonReplaceable) {
      return (
        <SafeArea style={styles.root}>
          <BlueSpacing20 />
          <BlueSpacing20 />
          <BlueSpacing20 />
          <BlueSpacing20 />
          <BlueSpacing20 />

          <BlueText h4>{loc.transactions.cpfp_no_bump}</BlueText>
        </SafeArea>
      );
    }

    return this.renderFeeSelection(loc.transactions.cpfp_exp);
  }
}

CPFP.propTypes = {
  navigation: PropTypes.shape({
    getParent: PropTypes.func,
    isFocused: PropTypes.func,
    popToTop: PropTypes.func,
    navigate: PropTypes.func,
  }),
  route: PropTypes.shape({
    params: PropTypes.shape({
      txid: PropTypes.string,
      wallet: PropTypes.object,
    }),
  }),
};
