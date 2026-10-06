import { network, isCompatibleOrigin, coinType } from '../../models/bitcoinNetwork';
import { sha256 } from '@noble/hashes/sha256';
import wif from 'wif';

import { BitcoinUnit, Chain } from '../../models/bitcoinUnits';
import { CreateTransactionResult, CreateTransactionUtxo, Transaction, Utxo } from './types';
import { hexToUint8Array, uint8ArrayToHex } from '../../blue_modules/uint8array-extras';
import { convertExtendedKey, decodeExtendedKey, extendedPublicKeyPrefixes, type ExtendedKeyFormat } from './extended-key';

type WalletWithPassphrase = AbstractWallet & { getPassphrase: () => string };
type UtxoMetadata = {
  frozen?: boolean;
  memo?: string;
};

export class AbstractWallet {
  static readonly type = 'abstract';
  static readonly typeReadable = 'abstract';
  // @ts-ignore: override
  public readonly type = AbstractWallet.type;
  // @ts-ignore: override
  public readonly typeReadable = AbstractWallet.typeReadable;

  static fromJson(obj: string): AbstractWallet {
    const obj2 = JSON.parse(obj);
    const temp = new this();
    for (const key2 of Object.keys(obj2)) {
      // @ts-ignore This kind of magic is not allowed in typescript, we should try and be more specific
      temp[key2] = obj2[key2];
    }

    return temp;
  }

  segwitType?: 'p2wpkh' | 'p2sh(p2wpkh)' | 'p2tr' | 'p2pkh' /* not segwit but ok */;
  _derivationPath?: string;
  label: string;
  secret: string;
  balance: number;
  unconfirmed_balance: number;
  _address: string | false;
  _utxo: Utxo[];
  _lastTxFetch: number;
  _lastBalanceFetch: number;
  preferredBalanceUnit: BitcoinUnit;
  chain: Chain;
  hideBalance: boolean;
  userHasSavedExport: boolean;
  _hideTransactionsInWalletsList: boolean;
  _utxoMetadata: Record<string, UtxoMetadata>;
  use_with_hardware_wallet: boolean;
  masterFingerprint: number;

  constructor() {
    this.label = '';
    this.secret = ''; // private key or recovery phrase
    this.balance = 0;
    this.unconfirmed_balance = 0;
    this._address = false; // cache
    this._utxo = [];
    this._lastTxFetch = 0;
    this._lastBalanceFetch = 0;
    this.preferredBalanceUnit = BitcoinUnit.BTC;
    this.chain = Chain.ONCHAIN;
    this.hideBalance = false;
    this.userHasSavedExport = false;
    this._hideTransactionsInWalletsList = false;
    this._utxoMetadata = {};
    this.use_with_hardware_wallet = false;
    this.masterFingerprint = 0;
  }

  /**
   * @returns {number} Timestamp (millisecsec) of when last transactions were fetched from the network
   */
  getLastTxFetch(): number {
    return this._lastTxFetch;
  }

  getID(): string {
    const thisWithPassphrase = this as unknown as WalletWithPassphrase;
    const passphrase = thisWithPassphrase.getPassphrase ? thisWithPassphrase.getPassphrase() : '';
    const path = this._derivationPath ?? '';
    const string2hash = this.type + this.getSecret() + passphrase + path;
    return uint8ArrayToHex(sha256(string2hash));
  }

  getTransactions(): Transaction[] {
    throw new Error('not implemented');
  }

  getUserHasSavedExport(): boolean {
    return this.userHasSavedExport;
  }

  setUserHasSavedExport(value: boolean): void {
    this.userHasSavedExport = value;
  }

  getHideTransactionsInWalletsList(): boolean {
    return this._hideTransactionsInWalletsList;
  }

  setHideTransactionsInWalletsList(value: boolean): void {
    this._hideTransactionsInWalletsList = value;
  }

  /**
   *
   * @returns {string}
   */
  getLabel(): string {
    if (this.label.trim().length === 0) {
      return 'Wallet';
    }
    return this.label;
  }

  getXpub(): string | false {
    return this._address;
  }

  /**
   *
   * @returns {number} Available to spend amount, int, in sats
   */
  getBalance(): number {
    const unconfirmed = this.getUnconfirmedBalance();
    return this.balance + (unconfirmed < 0 ? unconfirmed : 0);
  }

  getPreferredBalanceUnit(): BitcoinUnit {
    if (Object.values(BitcoinUnit).includes(this.preferredBalanceUnit)) {
      return this.preferredBalanceUnit;
    }
    return BitcoinUnit.BTC;
  }

  setPreferredBalanceUnit(unit: BitcoinUnit): void {
    if (Object.values(BitcoinUnit).includes(unit)) {
      this.preferredBalanceUnit = unit;
      return;
    }
    this.preferredBalanceUnit = BitcoinUnit.BTC;
  }

  async allowOnchainAddress(): Promise<boolean> {
    throw new Error('allowOnchainAddress: Not implemented');
  }

  allowBIP47(): boolean {
    return false;
  }

  switchBIP47(value: boolean): void {
    throw new Error('switchBIP47: not implemented');
  }

  allowReceive(): boolean {
    return true;
  }

  allowSend(): boolean {
    return true;
  }

  allowSilentPaymentSend(): boolean {
    return false;
  }

  allowRBF(): boolean {
    return false;
  }

  allowPayJoin(): boolean {
    return false;
  }

  allowCosignPsbt(): boolean {
    return false;
  }

  allowSignVerifyMessage(): boolean {
    return false;
  }

  allowMasterFingerprint(): boolean {
    return false;
  }

  allowXpub(): boolean {
    return false;
  }

  weOwnAddress(address: string): boolean {
    throw Error('not implemented');
  }

  weOwnTransaction(txid: string): boolean {
    throw Error('not implemented');
  }

  /**
   * Returns delta of unconfirmed balance. For example, if theres no
   * unconfirmed balance its 0
   *
   * @return {number} Satoshis
   */
  getUnconfirmedBalance(): number {
    return this.unconfirmed_balance;
  }

  setLabel(newLabel: string): this {
    this.label = newLabel;
    return this;
  }

  getSecret(): string {
    return this.secret;
  }

  setSecret(newSecret: string): this {
    // is it minikey https://en.bitcoin.it/wiki/Mini_private_key_format
    // Starts with S, is 22 length or larger, is base58
    if (newSecret.startsWith('S') && newSecret.length >= 22 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(newSecret)) {
      // minikey + ? hashed with SHA256 starts with 0x00 byte
      if (uint8ArrayToHex(sha256(`${newSecret}?`)).startsWith('00')) {
        // it is a valid minikey
        newSecret = wif.encode(network.wif, Buffer.from(sha256(newSecret)), false);
      }
    }

    this.secret = newSecret.trim().replace('bitcoin:', '').replace('BITCOIN:', '');

    if (this.secret.toUpperCase().startsWith(network.bech32.toUpperCase() + '1')) this.secret = this.secret.toLowerCase();

    // is it output descriptor?
    if (
      this.secret.startsWith('wpkh(') ||
      this.secret.startsWith('pkh(') ||
      this.secret.startsWith('sh(') ||
      this.secret.startsWith('tr(')
    ) {
      const matchingPrefix = extendedPublicKeyPrefixes.find(prefix => this.secret.includes(prefix));
      if (!matchingPrefix) throw new Error('Descriptor extended key is not valid for this network');
      const xpubIndex = this.secret.indexOf(matchingPrefix);
      let fpAndPath;
      if (this.secret.includes('[')) {
        fpAndPath = this.secret.substring(this.secret.indexOf('['), xpubIndex).replace(/[[\]]/g, '');
      } else {
        // old (or broken) format..? no square brackets, only "()"
        fpAndPath = this.secret.substring(this.secret.indexOf('('), xpubIndex).replace(/[()]/g, '');
      }
      const xpub = this.secret.substring(xpubIndex).replace(/[()]/g, '').split('/')[0];

      const pathIndex = fpAndPath.indexOf('/');
      const path = 'm' + fpAndPath.substring(pathIndex).replace(/[hH‘’]/g, "'");
      const fp = fpAndPath.substring(0, pathIndex);

      if (!isCompatibleOrigin(path)) throw new Error(`Descriptor origin must use coin type ${coinType}`);
      this._derivationPath = path;
      const mfp = uint8ArrayToHex(hexToUint8Array(fp).reverse());
      this.masterFingerprint = parseInt(mfp, 16);

      // Store the script type for later use
      if (this.secret.startsWith('tr(')) {
        this.segwitType = 'p2tr';
        decodeExtendedKey(xpub, 'public');
        this.secret = xpub;
      } else if (this.secret.startsWith('wpkh(')) {
        this.segwitType = 'p2wpkh';
        this.secret = convertExtendedKey(xpub, 'native');
      } else if (this.secret.startsWith('sh(wpkh(')) {
        this.segwitType = 'p2sh(p2wpkh)';
        this.secret = convertExtendedKey(xpub, 'nested');
      } else if (this.secret.startsWith('pkh(')) {
        this.segwitType = 'p2pkh';
        this.secret = convertExtendedKey(xpub, 'legacy');
      }

      return this;
    }

    // [fingerprint/derivation]extended-public-key
    const originMatch = this.secret.match(/^\[([0-9a-fA-F]{8}\/[^\]]+)\]([1-9A-HJ-NP-Za-km-z]+)(?:\/.*)?$/);
    const hasBracketedExtendedKey = /^\[[^\]]+\][1-9A-HJ-NP-Za-km-z]+/.test(this.secret);
    if (hasBracketedExtendedKey && !originMatch) {
      throw new Error('Invalid extended key origin');
    }
    if (originMatch) {
      const [hexFingerprint, ...derivationPathArray] = originMatch[1].split('/');
      const derivationPath = `m/${derivationPathArray.join('/').replace(/[hH‘’]/g, "'")}`;
      if (!isCompatibleOrigin(derivationPath)) throw new Error(`Extended key origin must use coin type ${coinType}`);

      const extendedKey = originMatch[2];
      const decodedKey = decodeExtendedKey(extendedKey, 'public');
      const conventionalPath = derivationPath.match(new RegExp(`^m/(49|84)'/${coinType}'/\\d+'$`));
      const format: ExtendedKeyFormat | undefined =
        conventionalPath?.[1] === '49' ? 'nested' : conventionalPath?.[1] === '84' ? 'native' : undefined;

      this.secret = format && decodedKey.format === 'legacy' ? convertExtendedKey(extendedKey, format) : extendedKey;
      this._derivationPath = derivationPath;
      this.masterFingerprint = parseInt(uint8ArrayToHex(hexToUint8Array(hexFingerprint).reverse()), 16);
    }

    let parsedSecret;
    try {
      parsedSecret = JSON.parse(this.secret);
    } catch {
      try {
        parsedSecret = JSON.parse(newSecret);
      } catch {}
    }

    if (parsedSecret?.keystore?.xpub) {
      const keystore = parsedSecret.keystore;
      const key = String(keystore.xpub);
      decodeExtendedKey(key, 'public');
      const derivationPath = keystore.derivation ? String(keystore.derivation).replace(/[hH‘’]/g, "'") : undefined;
      if (derivationPath && !isCompatibleOrigin(derivationPath)) {
        throw new Error(`Extended key origin must use coin type ${coinType}`);
      }

      let masterFingerprint = 0;
      if (keystore.ckcc_xfp) {
        masterFingerprint = Number(keystore.ckcc_xfp);
      } else if (keystore.root_fingerprint) {
        masterFingerprint = Number(keystore.root_fingerprint);
        if (!masterFingerprint) masterFingerprint = this.getMasterFingerprintFromHex(keystore.root_fingerprint);
      }

      this.secret = key;
      this._derivationPath = derivationPath;
      this.masterFingerprint = masterFingerprint;
      if (keystore.label) this.setLabel(keystore.label);
      if (keystore.type === 'hardware') this.use_with_hardware_wallet = true;
    }

    if (parsedSecret?.ExtPubKey && parsedSecret.MasterFingerprint && parsedSecret.AccountKeyPath) {
      const key = String(parsedSecret.ExtPubKey);
      const derivationPath = String(parsedSecret.AccountKeyPath);
      const normalizedPath = (derivationPath.startsWith('m/') ? derivationPath : `m/${derivationPath}`).replace(/[hH‘’]/g, "'");
      decodeExtendedKey(key, 'public');
      if (!isCompatibleOrigin(normalizedPath)) throw new Error(`Extended key origin must use coin type ${coinType}`);
      const masterFingerprint = parseInt(uint8ArrayToHex(hexToUint8Array(String(parsedSecret.MasterFingerprint)).reverse()), 16);

      this.secret = key;
      this._derivationPath = normalizedPath;
      this.masterFingerprint = masterFingerprint;
      if (parsedSecret.CoboVaultFirmwareVersion) this.use_with_hardware_wallet = true;
      return this;
    }

    if (!this._derivationPath) {
      try {
        const format = decodeExtendedKey(this.secret, 'public').format;
        if (format === 'legacy') {
          this._derivationPath = `m/44'/${coinType}'/0'`;
        } else if (format === 'nested') {
          this._derivationPath = `m/49'/${coinType}'/0'`;
        } else if (format === 'native') {
          this._derivationPath = `m/84'/${coinType}'/0'`;
        }
      } catch {}
    }

    // is it new-wasabi.json exported from coldcard?
    if (parsedSecret?.MasterFingerprint && parsedSecret.ExtPubKey) {
      const key = convertExtendedKey(String(parsedSecret.ExtPubKey), 'native');
      const masterFingerprint = parseInt(uint8ArrayToHex(hexToUint8Array(String(parsedSecret.MasterFingerprint)).reverse()), 16);
      this.secret = key;
      this.masterFingerprint = masterFingerprint;
      return this;
    }

    return this;
  }

  getLatestTransactionTime(): string | 0 {
    return 0;
  }

  /**
   * @deprecated
   * TODO: be more precise on the type
   */

  createTx(): any {
    throw Error('not implemented');
  }

  /**
   *
   * @param utxos {Array.<{vout: Number, value: Number, txid: String, address: String}>} List of spendable utxos
   * @param targets {Array.<{value: Number, address: String}>} Where coins are going. If theres only 1 target and that target has no value - this will send MAX to that address (respecting fee rate)
   * @param feeRate {Number} satoshi per byte
   * @param changeAddress {String} Excessive coins will go back to that address
   * @param sequence {Number} Used in RBF
   * @param skipSigning {boolean} Whether we should skip signing, use returned `psbt` in that case
   * @param masterFingerprint {number} Decimal number of wallet's master fingerprint
   * @returns {{outputs: Array, tx: Transaction, inputs: Array, fee: Number, psbt: Psbt}}
   */
  createTransaction(
    utxos: CreateTransactionUtxo[],
    targets: {
      address: string;
      value?: number;
    }[],
    feeRate: number,
    changeAddress: string,
    sequence: number,
    skipSigning = false,
    masterFingerprint: number,
  ): CreateTransactionResult {
    throw Error('not implemented');
  }

  getAddress(): string | false | undefined {
    throw Error('not implemented');
  }

  getAddressAsync(): Promise<string | false | undefined> {
    return Promise.resolve(this.getAddress());
  }

  async getChangeAddressAsync(): Promise<string | false | undefined> {
    return Promise.resolve(this.getAddress());
  }

  useWithHardwareWalletEnabled(): boolean {
    return false;
  }

  isBIP47Enabled(): boolean {
    return false;
  }

  async wasEverUsed(): Promise<boolean> {
    throw new Error('Not implemented');
  }

  /**
   * Returns _all_ external addresses in hierarchy (for HD wallets) or just address for single-address wallets
   * _Not_ internal ones, as this method is supposed to be used for subscription of external notifications.
   *
   * @returns string[] Addresses
   */
  getAllExternalAddresses(): string[] {
    return [];
  }

  prepareForSerialization(): void {}

  /*
   * Get metadata (frozen, memo) for a specific UTXO
   *
   * @param {String} txid - transaction id
   * @param {number} vout - an index number of the output in transaction
   */
  getUTXOMetadata(txid: string, vout: number): UtxoMetadata {
    return this._utxoMetadata[`${txid}:${vout}`] || {};
  }

  /*
   * Set metadata (frozen, memo) for a specific UTXO
   *
   * @param {String} txid - transaction id
   * @param {number} vout - an index number of the output in transaction
   * @param {{memo: String, frozen: Boolean}} opts - options to attach to UTXO
   */
  setUTXOMetadata(txid: string, vout: number, opts: UtxoMetadata): void {
    const meta = this._utxoMetadata[`${txid}:${vout}`] || {};
    if ('memo' in opts) meta.memo = opts.memo;
    if ('frozen' in opts) meta.frozen = opts.frozen;
    this._utxoMetadata[`${txid}:${vout}`] = meta;
  }

  isSegwit() {
    return false;
  }

  getMasterFingerprintFromHex(hexValue: string): number {
    hexValue = hexValue.padStart(8, '0');
    const b = hexToUint8Array(hexValue);
    if (b.length !== 4) throw new Error('invalid fingerprint hex');

    hexValue = hexValue[6] + hexValue[7] + hexValue[4] + hexValue[5] + hexValue[2] + hexValue[3] + hexValue[0] + hexValue[1];

    return parseInt(hexValue, 16);
  }
}
