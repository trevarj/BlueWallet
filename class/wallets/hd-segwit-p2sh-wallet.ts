import BIP32Factory, { BIP32Interface } from 'bip32';
import * as bitcoin from 'bitcoinjs-lib';
import { Psbt } from 'bitcoinjs-lib';
import { CoinSelectReturnInput } from 'coinselect';

import ecc from '../../blue_modules/noble_ecc';
import { AbstractHDElectrumWallet } from './abstract-hd-electrum-wallet';
import { coinType, mainnetServicesEnabled, network } from '../../models/bitcoinNetwork';
import { convertExtendedKey } from './extended-key';

const bip32 = BIP32Factory(ecc);

/**
 * HD Wallet (BIP39).
 * In particular, BIP49 (P2SH Segwit)
 * @see https://github.com/bitcoin/bips/blob/master/bip-0049.mediawiki
 */
export class HDSegwitP2SHWallet extends AbstractHDElectrumWallet {
  static readonly type = 'HDsegwitP2SH';
  static readonly typeReadable = 'HD SegWit (BIP49 P2SH)';
  // @ts-ignore: override
  public readonly type = HDSegwitP2SHWallet.type;
  // @ts-ignore: override
  public readonly typeReadable = HDSegwitP2SHWallet.typeReadable;
  public readonly segwitType = 'p2sh(p2wpkh)';
  static readonly derivationPath = `m/49'/${coinType}'/0'`;

  allowSend() {
    return true;
  }

  allowCosignPsbt() {
    return true;
  }

  allowSignVerifyMessage() {
    return true;
  }

  allowMasterFingerprint() {
    return true;
  }

  allowXpub() {
    return true;
  }

  _hdNodeToAddress(hdNode: BIP32Interface): string {
    return this._nodeToP2shSegwitAddress(hdNode);
  }

  /**
   * Returns the selected network's nested-SegWit SLIP-132 public key.
   */
  getXpub() {
    if (this._xpub) {
      return this._xpub; // cache hit
    }
    // first, getting xpub
    const seed = this._getSeed();
    const root = bip32.fromSeed(seed, network);

    const path = this.getDerivationPath();
    if (!path) {
      throw new Error('Internal error: no path');
    }
    const child = root.derivePath(path).neutered();
    const xpub = child.toBase58();

    // bitcoinjs does not support nested-SegWit SLIP-132 versions, so convert the standard public key.
    this._xpub = convertExtendedKey(xpub, 'nested');

    return this._xpub;
  }

  _addPsbtInput(psbt: Psbt, input: CoinSelectReturnInput, sequence: number, masterFingerprintBuffer: Uint8Array) {
    if (!input.address) {
      throw new Error('Internal error: no address on Utxo during _addPsbtInput()');
    }
    const pubkey = this._getPubkeyByAddress(input.address);
    const path = this._getDerivationPathByAddress(input.address);
    if (!pubkey || !path) {
      throw new Error('Internal error: pubkey or path are invalid');
    }
    const p2wpkh = bitcoin.payments.p2wpkh({ pubkey, network });
    const p2sh = bitcoin.payments.p2sh({ redeem: p2wpkh, network });
    if (!p2sh.output) {
      throw new Error('Internal error: no p2sh.output during _addPsbtInput()');
    }

    psbt.addInput({
      hash: input.txid,
      index: input.vout,
      sequence,
      bip32Derivation: [
        {
          masterFingerprint: masterFingerprintBuffer,
          path,
          pubkey,
        },
      ],
      witnessUtxo: {
        script: p2sh.output,
        value: BigInt(input.value),
      },
      redeemScript: p2wpkh.output,
    });

    return psbt;
  }

  isSegwit() {
    return true;
  }

  allowSilentPaymentSend(): boolean {
    return mainnetServicesEnabled;
  }
}
