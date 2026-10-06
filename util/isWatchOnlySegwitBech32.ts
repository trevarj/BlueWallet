import { HDSegwitBech32Wallet } from '../class/wallets/hd-segwit-bech32-wallet';
import { TWallet } from '../class/wallets/types';
import { WatchOnlyWallet } from '../class/wallets/watch-only-wallet';

export type WatchOnlySegwitBech32Wallet = WatchOnlyWallet & {
  _hdWalletInstance: HDSegwitBech32Wallet;
};

export function isWatchOnlySegwitBech32(wallet: TWallet | null | undefined): wallet is WatchOnlySegwitBech32Wallet {
  return !!wallet && wallet.type === WatchOnlyWallet.type && wallet._hdWalletInstance?.type === HDSegwitBech32Wallet.type;
}

export function isAssociatedWatchOnlySegwitBech32(wallet: TWallet | null | undefined): wallet is WatchOnlySegwitBech32Wallet {
  return isWatchOnlySegwitBech32(wallet) && wallet.getHardwareWalletAssociation()?.format === 'native-segwit';
}
