import BIP32Factory, { BIP32Interface } from 'bip32';
import * as bip39 from 'bip39';
import * as bitcoin from 'bitcoinjs-lib';
import { Psbt, Transaction } from 'bitcoinjs-lib';
import { CoinSelectOutput, CoinSelectReturnInput, CoinSelectTarget } from 'coinselect';
import { sha256 } from '@noble/hashes/sha256';
import { ECPairFactory } from 'ecpair';
import * as mn from 'electrum-mnemonic';

import * as BlueElectrum from '../../blue_modules/BlueElectrum';
import ecc from '../../blue_modules/noble_ecc';
import { decodeUR } from '../../blue_modules/ur';
import { AbstractHDElectrumWallet } from './abstract-hd-electrum-wallet';
import { CreateTransactionResult, CreateTransactionTarget, CreateTransactionUtxo } from './types';
import { uint8ArrayToHex, hexToUint8Array, uint8ArrayToString, compareUint8Arrays } from '../../blue_modules/uint8array-extras';
import {
  bitcoinNetwork,
  coinType,
  getMultisigPathFormat,
  isCompatibleOrigin,
  network,
  normalizeDerivationPath,
} from '../../models/bitcoinNetwork';
import {
  convertExtendedKey,
  decodeExtendedKey,
  extendedPublicKeyPrefixes,
  isExtendedPrivateKey,
  isExtendedPublicKey,
} from './extended-key';
import {
  isBhwiSinglesigFormat,
  parseHardwareWalletAssociation,
  parseHardwareWalletRegistration,
  sameBhwiExtendedPublicKey,
} from '../../blue_modules/bhwi';
import type { HardwareWalletAssociation, HardwareWalletRegistration } from '../../blue_modules/bhwi';

const ECPair = ECPairFactory(ecc);
const bip32 = BIP32Factory(ecc);

type SeedOpts = {
  prefix: string;
  passphrase?: string;
};

type TBip32Derivation = {
  masterFingerprint: Uint8Array;
  path: string;
  pubkey: Uint8Array;
}[];

type TOutputData =
  | {
      bip32Derivation: TBip32Derivation;
      redeemScript: Uint8Array;
    }
  | {
      bip32Derivation: TBip32Derivation;
      witnessScript: Uint8Array;
    }
  | {
      bip32Derivation: TBip32Derivation;
      redeemScript: Uint8Array;
      witnessScript: Uint8Array;
    };

const electrumSegwit = (passphrase?: string): SeedOpts => ({
  prefix: mn.PREFIXES.segwit,
  ...(passphrase ? { passphrase } : {}),
});

const electrumStandart = (passphrase?: string): SeedOpts => ({
  prefix: mn.PREFIXES.standard,
  ...(passphrase ? { passphrase } : {}),
});

const ELECTRUM_SEED_PREFIX = 'electrumseed:';

export class MultisigHDWallet extends AbstractHDElectrumWallet {
  static readonly type = 'HDmultisig';
  static readonly typeReadable = 'Multisig Vault';
  // @ts-ignore: override
  public readonly type = MultisigHDWallet.type;
  // @ts-ignore: override
  public readonly typeReadable = MultisigHDWallet.typeReadable;

  static FORMAT_P2WSH = 'p2wsh';
  static FORMAT_P2SH_P2WSH = 'p2sh-p2wsh';
  static FORMAT_P2SH_P2WSH_ALT = 'p2wsh-p2sh';
  static FORMAT_P2SH = 'p2sh';

  static PATH_NATIVE_SEGWIT = `m/48'/${coinType}'/0'/2'`;
  static PATH_WRAPPED_SEGWIT = `m/48'/${coinType}'/0'/1'`;
  static PATH_LEGACY = "m/45'";

  private _m: number = 0; //  minimum required signatures so spend (m out of n)
  private _cosigners: string[] = []; // array of xpubs or mnemonic seeds
  private _cosignersFingerprints: string[] = []; // array of according fingerprints  (if any provided)
  private _cosignersCustomPaths: string[] = []; // array of according paths (if any provided)
  private _cosignersPassphrases: (string | undefined)[] = []; // array of according passphrases (if any provided)
  private _isNativeSegwit: boolean = false;
  private _isWrappedSegwit: boolean = false;
  private _isLegacy: boolean = false;
  private _nodes: Record<number, Record<number, BIP32Interface>> = {}; // nodeIndex -> cosignerIndex -> BIP32Interface
  private _cosignerXpubCache: Record<string, string> = {}; // cosigner+path+passphrase -> xpub, since deriving xpub from seed is expensive
  public _derivationPath: string = '';
  public gap_limit: number = 20;
  private _hardwareWalletAssociations: HardwareWalletAssociation[] = [];
  private _hardwareWalletRegistrations: HardwareWalletRegistration[] = [];

  static override fromJson(obj: string): MultisigHDWallet {
    const wallet = super.fromJson(obj) as unknown as MultisigHDWallet;
    const restoredAssociations = Array.isArray(wallet._hardwareWalletAssociations) ? wallet._hardwareWalletAssociations : [];
    wallet._hardwareWalletAssociations = restoredAssociations
      .map(parseHardwareWalletAssociation)
      .filter((association): association is HardwareWalletAssociation => !!association && wallet.hasHardwareCosigner(association));
    const restoredRegistrations = Array.isArray(wallet._hardwareWalletRegistrations) ? wallet._hardwareWalletRegistrations : [];
    wallet._hardwareWalletRegistrations = restoredRegistrations
      .map(parseHardwareWalletRegistration)
      .filter(
        (registration): registration is HardwareWalletRegistration => !!registration && wallet.matchesHardwareRegistration(registration),
      );
    return wallet;
  }

  private hasHardwareCosigner(association: HardwareWalletAssociation): boolean {
    if (isBhwiSinglesigFormat(association.format)) return false;
    if (association.format === 'multisig-native' && !this.isNativeSegwit()) return false;
    if (association.format === 'multisig-wrapped' && !this.isWrappedSegwit()) return false;
    return this._cosigners.some((_cosigner, index) => {
      const path = this._cosignersCustomPaths[index] || this.getDerivationPath();
      if (
        !path ||
        this._cosignersFingerprints[index]?.toLowerCase() !== association.fingerprint ||
        normalizeDerivationPath(path) !== association.path
      ) {
        return false;
      }
      try {
        return sameBhwiExtendedPublicKey(this._getXpubFromCosignerIndex(index), association.xpub);
      } catch {
        return false;
      }
    });
  }

  addHardwareWalletAssociation(value: HardwareWalletAssociation): void {
    const association = parseHardwareWalletAssociation(value);
    if (!association || !this.hasHardwareCosigner(association)) throw new Error('Invalid hardware wallet cosigner association');
    if (
      !this._hardwareWalletAssociations.some(
        existing =>
          existing.family === association.family &&
          existing.fingerprint === association.fingerprint &&
          existing.path === association.path &&
          existing.xpub === association.xpub &&
          existing.format === association.format,
      )
    ) {
      this._hardwareWalletAssociations.push(association);
    }
  }

  getHardwareWalletAssociations(): HardwareWalletAssociation[] {
    return this._hardwareWalletAssociations
      .map(parseHardwareWalletAssociation)
      .filter((association): association is HardwareWalletAssociation => !!association && this.hasHardwareCosigner(association))
      .map(association => ({ ...association }));
  }

  private matchesHardwareRegistration(registration: HardwareWalletRegistration): boolean {
    const parsed = parseHardwareWalletRegistration(registration);
    if (!parsed || !this.hasHardwareCosigner(parsed)) return false;
    try {
      return parsed.descriptor === this.getPublicDescriptor();
    } catch {
      return false;
    }
  }

  addHardwareWalletRegistration(value: HardwareWalletRegistration): void {
    const registration = parseHardwareWalletRegistration(value);
    if (!registration || !this.matchesHardwareRegistration(registration)) throw new Error('Invalid hardware wallet registration');
    this._hardwareWalletRegistrations = this._hardwareWalletRegistrations.filter(
      existing =>
        existing.family !== registration.family ||
        existing.fingerprint !== registration.fingerprint ||
        existing.path !== registration.path ||
        existing.xpub !== registration.xpub ||
        existing.format !== registration.format,
    );
    this._hardwareWalletRegistrations.push(registration);
  }

  getHardwareWalletRegistrations(): HardwareWalletRegistration[] {
    return this._hardwareWalletRegistrations
      .map(parseHardwareWalletRegistration)
      .filter(
        (registration): registration is HardwareWalletRegistration => !!registration && this.matchesHardwareRegistration(registration),
      )
      .map(registration => ({ ...registration }));
  }

  getHardwareWalletRegistration(association: HardwareWalletAssociation): HardwareWalletRegistration | undefined {
    return this.getHardwareWalletRegistrations().find(
      registration =>
        registration.family === association.family &&
        registration.fingerprint === association.fingerprint &&
        registration.path === association.path &&
        registration.xpub === association.xpub &&
        registration.format === association.format,
    );
  }

  private invalidateHardwareWalletRegistrations(): void {
    this._hardwareWalletRegistrations = [];
  }

  getPublicCosigners(): Array<{ xpub: string; fingerprint: string; path: string }> {
    return this._cosigners.map((_cosigner, index) => {
      const fingerprint = this._cosignersFingerprints[index]?.toLowerCase();
      const customPath = this._cosignersCustomPaths[index] || this.getDerivationPath();
      if (!customPath) throw new Error('Multisig cosigner origin is incomplete');
      const path = normalizeDerivationPath(customPath);
      if (!fingerprint || !/^[0-9a-f]{8}$/.test(fingerprint) || !path.startsWith('m/')) {
        throw new Error('Multisig cosigner origin is incomplete');
      }
      return { xpub: this._getXpubFromCosignerIndex(index), fingerprint, path };
    });
  }

  getPublicDescriptor(): string {
    if (this._m < 1 || this._m > this.getN()) throw new Error('Invalid multisig policy');
    const keys = this.getPublicCosigners()
      .map(({ xpub, fingerprint, path }) => `[${fingerprint}/${path.slice(2)}]${xpub}/<0;1>/*`)
      .sort();
    const policy = `sortedmulti(${this._m},${keys.join(',')})`;
    if (this.isNativeSegwit()) return `wsh(${policy})`;
    if (this.isWrappedSegwit()) return `sh(wsh(${policy}))`;
    if (this.isLegacy()) return `sh(${policy})`;
    throw new Error('Unsupported multisig format');
  }

  isLegacy() {
    return this._isLegacy;
  }

  isNativeSegwit() {
    return this._isNativeSegwit;
  }

  isWrappedSegwit() {
    return this._isWrappedSegwit;
  }

  setWrappedSegwit() {
    if (!this._isWrappedSegwit || this._isNativeSegwit || this._isLegacy) this.invalidateHardwareWalletRegistrations();
    this._isWrappedSegwit = true;
    this._isNativeSegwit = false;
    this._isLegacy = false;
  }

  setNativeSegwit() {
    if (!this._isNativeSegwit || this._isWrappedSegwit || this._isLegacy) this.invalidateHardwareWalletRegistrations();
    this._isNativeSegwit = true;
    this._isWrappedSegwit = false;
    this._isLegacy = false;
  }

  setLegacy() {
    if (!this._isLegacy || this._isNativeSegwit || this._isWrappedSegwit) this.invalidateHardwareWalletRegistrations();
    this._isLegacy = true;
    this._isNativeSegwit = false;
    this._isWrappedSegwit = false;
  }

  setM(m: number) {
    if (this._m !== m) this.invalidateHardwareWalletRegistrations();
    this._m = m;
  }

  /**
   * @returns {number} How many minumim signatures required to authorize a spend
   */
  getM(): number {
    return this._m;
  }

  /**
   * @returns {number} Total count of cosigners
   */
  getN(): number {
    return this._cosigners.length;
  }

  setDerivationPath(path: string) {
    if (!isCompatibleOrigin(path)) throw new Error(`Multisig origin must use coin type ${coinType}`);
    const normalizedPath = normalizeDerivationPath(path);
    if (this._derivationPath !== normalizedPath) this.invalidateHardwareWalletRegistrations();
    this._derivationPath = normalizedPath;
    this._isNativeSegwit = false;
    this._isWrappedSegwit = false;
    this._isLegacy = false;
    const format = getMultisigPathFormat(this._derivationPath);
    if (format === 'native') {
      this._isNativeSegwit = true;
    } else if (format === 'wrapped') {
      this._isWrappedSegwit = true;
    } else if (format === 'legacy') {
      this._isLegacy = true;
    } else if (this._derivationPath === "m/44'") {
      this._isLegacy = true;
    }
  }

  getCustomDerivationPathForCosigner(index: number): string | false {
    if (index === 0) throw new Error('cosigners indexation starts from 1');
    if (index > this.getN()) return false;
    return this._cosignersCustomPaths[index - 1] || this.getDerivationPath()!;
  }

  getCosigner(index: number) {
    if (index === 0) throw new Error('cosigners indexation starts from 1');
    return this._cosigners[index - 1];
  }

  getFingerprint(index: number) {
    if (index === 0) throw new Error('cosigners fingerprints indexation starts from 1');
    return this._cosignersFingerprints[index - 1];
  }

  getCosignerForFingerprint(fp: string) {
    const index = this._cosignersFingerprints.indexOf(fp);
    return this._cosigners[index];
  }

  getCosignerPassphrase(index: number) {
    if (index === 0) throw new Error('cosigners indexation starts from 1');
    return this._cosignersPassphrases[index - 1];
  }

  static isXpubValid(key: string): boolean {
    try {
      decodeExtendedKey(key, 'public');
      const xpub = convertExtendedKey(key, 'legacy');
      bip32.fromBase58(xpub, network);
      return true;
    } catch {}

    return false;
  }

  static isXprvValid(xprv: string): boolean {
    try {
      decodeExtendedKey(xprv, 'private');
      bip32.fromBase58(convertExtendedKey(xprv, 'legacy'), network);
      return true;
    } catch {
      return false;
    }
  }

  static isValidElectrumSeed(seed: string) {
    return mn.validateMnemonic(seed, mn.PREFIXES.segwit) || mn.validateMnemonic(seed, mn.PREFIXES.standard);
  }

  /**
   *
   * @param key {string} Either xpub or mnemonic phrase
   * @param fingerprint {string} Fingerprint for cosigner that is added as xpub
   * @param path {string} Custom path (if any) for cosigner that is added as mnemonics
   * @param passphrase {string} BIP38 Passphrase (if any)
   */
  addCosigner(key: string, fingerprint?: string, path?: string, passphrase?: string) {
    if (MultisigHDWallet.isXpubString(key) && !fingerprint) {
      throw new Error('fingerprint is required when adding cosigner as xpub (watch-only)');
    }

    if (path && !MultisigHDWallet.isPathValid(path)) {
      throw new Error('path is not valid');
    }
    if (path && !isCompatibleOrigin(path)) throw new Error(`Cosigner origin must use coin type ${coinType}`);

    if (MultisigHDWallet.isXprvString(key)) {
      // nop, but probably should validate xprv
    } else if (MultisigHDWallet.isXpubString(key)) {
      // nop, just validate
      if (!MultisigHDWallet.isXpubValid(key)) throw new Error('Not a valid xpub: ' + key);
    } else if (key.startsWith(ELECTRUM_SEED_PREFIX) && fingerprint && path) {
      // its an electrum seed
      const mnemonic = key.replace(ELECTRUM_SEED_PREFIX, '');
      try {
        mn.mnemonicToSeedSync(mnemonic, electrumStandart(passphrase));
        this.setLegacy();
      } catch (_) {
        try {
          mn.mnemonicToSeedSync(mnemonic, electrumSegwit(passphrase));
          this.setNativeSegwit();
        } catch (__) {
          throw new Error('Not a valid electrum seed');
        }
      }
    } else {
      // mnemonics. lets derive fingerprint (if it wasnt provided)
      if (!bip39.validateMnemonic(key)) throw new Error('Not a valid mnemonic phrase');
      fingerprint = fingerprint || MultisigHDWallet.mnemonicToFingerprint(key, passphrase);
    }

    if (fingerprint && this._cosignersFingerprints.indexOf(fingerprint.toUpperCase()) !== -1 && fingerprint !== '00000000') {
      // 00000000 is a special case, means we have no idea what the FP is but its okay
      throw new Error('Duplicate fingerprint');
    }

    this.invalidateHardwareWalletRegistrations();
    const index = this._cosigners.length;
    this._cosigners[index] = key;
    if (fingerprint) this._cosignersFingerprints[index] = fingerprint.toUpperCase();
    if (path) this._cosignersCustomPaths[index] = path;
    if (passphrase) this._cosignersPassphrases[index] = passphrase;
  }

  /**
   * Stored cosigner can be EITHER xpub (or Zpub or smth), OR mnemonic phrase. This method converts it to xpub
   *
   * @param index {number}
   * @returns {string} xpub
   * @private
   */
  protected _getXpubFromCosignerIndex(index: number) {
    if (!this._cosigners || !this._cosigners[index]) {
      throw new Error('Invalid cosigner index or cosigners not initialized');
    }
    let cosigner: string = this._cosigners[index];
    const cacheKey =
      cosigner + '|' + (this._cosignersCustomPaths[index] || this._derivationPath) + '|' + (this._cosignersPassphrases[index] ?? '');
    if (this._cosignerXpubCache[cacheKey]) return this._cosignerXpubCache[cacheKey]; // cache hit
    if (MultisigHDWallet.isXprvString(cosigner)) {
      cosigner = bip32.fromBase58(convertExtendedKey(cosigner, 'legacy'), network).neutered().toBase58();
    }
    let xpub = cosigner;
    if (!MultisigHDWallet.isXpubString(cosigner)) {
      xpub = MultisigHDWallet.seedToXpub(
        cosigner,
        this._cosignersCustomPaths[index] || this._derivationPath,
        this._cosignersPassphrases[index],
      );
    }
    return (this._cosignerXpubCache[cacheKey] = convertExtendedKey(xpub, 'legacy'));
  }

  _getExternalAddressByIndex(index: number) {
    if (!this._m) throw new Error('m is not set');
    index = +index;
    if (this.external_addresses_cache[index]) return this.external_addresses_cache[index]; // cache hit

    const address = this._getAddressFromNode(0, index);
    this.external_addresses_cache[index] = address;
    return address;
  }

  _getAddressFromNode(nodeIndex: number, index: number) {
    this._nodes = this._nodes || {};
    const pubkeys = [];
    for (const [cosignerIndex] of this._cosigners.entries()) {
      this._nodes[nodeIndex] = this._nodes[nodeIndex] || {};
      let _node;

      if (!this._nodes[nodeIndex][cosignerIndex]) {
        const xpub = this._getXpubFromCosignerIndex(cosignerIndex);
        const hdNode = bip32.fromBase58(xpub, network);
        _node = hdNode.derive(nodeIndex);
        this._nodes[nodeIndex][cosignerIndex] = _node;
      } else {
        _node = this._nodes[nodeIndex][cosignerIndex];
      }

      pubkeys.push(_node.derive(index).publicKey);
    }

    if (this.isWrappedSegwit()) {
      const { address } = bitcoin.payments.p2sh({
        redeem: bitcoin.payments.p2wsh({
          redeem: bitcoin.payments.p2ms({
            m: this._m,
            pubkeys: MultisigHDWallet.sortBuffers(pubkeys),
            network,
          }),
          network,
        }),
        network,
      });
      if (!address) {
        throw new Error('Internal error: could not make p2sh address');
      }

      return address;
    } else if (this.isNativeSegwit()) {
      const { address } = bitcoin.payments.p2wsh({
        redeem: bitcoin.payments.p2ms({
          m: this._m,
          pubkeys: MultisigHDWallet.sortBuffers(pubkeys),
          network,
        }),
        network,
      });
      if (!address) {
        throw new Error('Internal error: could not make p2wsh address');
      }

      return address;
    } else if (this.isLegacy()) {
      const { address } = bitcoin.payments.p2sh({
        redeem: bitcoin.payments.p2ms({
          m: this._m,
          pubkeys: MultisigHDWallet.sortBuffers(pubkeys),
          network,
        }),
        network,
      });
      if (!address) {
        throw new Error('Internal error: could not make p2sh address');
      }

      return address;
    } else {
      throw new Error('Dont know how to make address');
    }
  }

  _getInternalAddressByIndex(index: number) {
    if (!this._m) throw new Error('m is not set');
    index = +index;
    if (this.internal_addresses_cache[index]) return this.internal_addresses_cache[index]; // cache hit

    const address = this._getAddressFromNode(1, index);
    this.internal_addresses_cache[index] = address;
    return address;
  }

  static seedToXpub(mnemonic: string, path: string, passphrase?: string): string {
    let seed;
    if (mnemonic.startsWith(ELECTRUM_SEED_PREFIX)) {
      seed = MultisigHDWallet.convertElectrumMnemonicToSeed(mnemonic, passphrase);
    } else {
      seed = bip39.mnemonicToSeedSync(mnemonic, passphrase);
    }

    const root = bip32.fromSeed(seed, network);
    const child = root.derivePath(path).neutered();
    return child.toBase58();
  }

  static isXpubString(xpub: string): boolean {
    return isExtendedPublicKey(xpub);
  }

  static isXprvString(xprv: string): boolean {
    return isExtendedPrivateKey(xprv);
  }

  /**
   * Converts fingerprint that is stored as a deciman number to hex string (all caps)
   *
   * @param xfp {number} For example 64392470
   * @returns {string} For example 168DD603
   */
  static ckccXfp2fingerprint(xfp: string | number): string {
    let masterFingerprintHex = Number(xfp).toString(16);
    while (masterFingerprintHex.length < 8) masterFingerprintHex = '0' + masterFingerprintHex; // conversion without explicit zero might result in lost byte

    // poor man's little-endian conversion:
    // ¯\_(ツ)_/¯
    return (
      masterFingerprintHex[6] +
      masterFingerprintHex[7] +
      masterFingerprintHex[4] +
      masterFingerprintHex[5] +
      masterFingerprintHex[2] +
      masterFingerprintHex[3] +
      masterFingerprintHex[0] +
      masterFingerprintHex[1]
    ).toUpperCase();
  }

  getXpub() {
    return this.getSecret(true);
  }

  getSecret(coordinationSetup = false) {
    let ret = '# BlueWallet Multisig setup file\n';
    if (coordinationSetup) ret += '# this file contains only public keys and is safe to\n# distribute among cosigners\n';
    if (!coordinationSetup) ret += '# this file may contain private information\n';
    ret += '#\n';
    ret += 'Name: ' + this.getLabel() + '\n';
    ret += 'Policy: ' + this.getM() + ' of ' + this.getN() + '\n';

    let hasCustomPaths = 0;
    const customPaths: Record<string, number> = {};
    for (let index = 0; index < this.getN(); index++) {
      if (this._cosignersCustomPaths[index]) hasCustomPaths++;
      if (this._cosignersCustomPaths[index]) customPaths[this._cosignersCustomPaths[index]] = 1;
    }

    let printedGlobalDerivation = false;
    const derivationPath = this.getDerivationPath();
    if (derivationPath) customPaths[derivationPath] = 1;
    if (Object.keys(customPaths).length === 1) {
      // we have exactly one path, for everyone. lets just print it
      for (const path of Object.keys(customPaths)) {
        ret += 'Derivation: ' + path + '\n';
        printedGlobalDerivation = true;
      }
    }

    if (hasCustomPaths !== this.getN() && !printedGlobalDerivation) {
      printedGlobalDerivation = true;
      ret += 'Derivation: ' + this.getDerivationPath() + '\n';
    }

    if (this.isNativeSegwit()) {
      ret += 'Format: P2WSH\n';
    } else if (this.isWrappedSegwit()) {
      ret += 'Format: P2SH-P2WSH\n';
    } else if (this.isLegacy()) {
      ret += 'Format: P2SH\n';
    } else {
      ret += 'Format: unknown\n';
    }
    ret += '\n';

    for (let index = 0; index < this.getN(); index++) {
      if (
        this._cosignersCustomPaths[index] &&
        ((printedGlobalDerivation && this._cosignersCustomPaths[index] !== this.getDerivationPath()) || !printedGlobalDerivation)
      ) {
        ret += '# derivation: ' + this._cosignersCustomPaths[index] + '\n';
        // if we printed global derivation and this cosigned _has_ derivation and its different from global - we print it ;
        // or we print it if cosigner _has_ some derivation set and we did not print global
      }
      if (MultisigHDWallet.isXpubString(this._cosigners[index])) {
        ret += this._cosignersFingerprints[index] + ': ' + this._cosigners[index] + '\n';
      } else {
        if (coordinationSetup) {
          const xpub = convertExtendedKey(
            MultisigHDWallet.seedToXpub(
              this._cosigners[index],
              this._cosignersCustomPaths[index] || this._derivationPath,
              this._cosignersPassphrases[index],
            ),
            this.isNativeSegwit() ? 'multisigNative' : this.isWrappedSegwit() ? 'multisigNested' : 'legacy',
          );
          let fingerprint: string;
          let mnemonic = this._cosigners[index];
          const passphrase = this._cosignersPassphrases[index];
          if (mnemonic.startsWith(ELECTRUM_SEED_PREFIX)) {
            mnemonic = mnemonic.replace(ELECTRUM_SEED_PREFIX, '');
            const seed = MultisigHDWallet.convertElectrumMnemonicToSeed(mnemonic, passphrase);
            fingerprint = MultisigHDWallet.seedToFingerprint(seed);
          } else {
            fingerprint = MultisigHDWallet.mnemonicToFingerprint(mnemonic, this._cosignersPassphrases[index]);
          }

          ret += fingerprint + ': ' + xpub + '\n';
        } else {
          ret += 'seed: ' + this._cosigners[index];
          if (this._cosignersPassphrases[index]) ret += ' - ' + this._cosignersPassphrases[index];
          ret += '\n# warning! sensitive information, do not disclose ^^^ \n';
        }
      }

      ret += '\n';
    }

    return ret;
  }

  setSecret(secret: string) {
    if (secret.toUpperCase().startsWith('UR:BYTES')) {
      const decoded = decodeUR([secret]) as string;
      const b = hexToUint8Array(decoded);
      secret = uint8ArrayToString(b);
    }

    // is it Coldcard json file?
    let json;
    try {
      json = JSON.parse(secret);
    } catch (_) {}
    if (json && json.xfp && json.p2wsh_deriv && json.p2wsh) {
      this.addCosigner(json.p2wsh, json.xfp, json.p2wsh_deriv.replace(/[hH]/g, "'"));
      return this;
    }

    // is it electrum json?
    if (json && json.wallet_type && json.wallet_type !== 'standard') {
      const mofn = json.wallet_type.split('of');
      this.setM(parseInt(mofn[0].trim(), 10));
      const n = parseInt(mofn[1].trim(), 10);
      for (let c = 1; c <= n; c++) {
        const cosignerData = json['x' + c + '/'] || json['x' + c];
        if (cosignerData) {
          const derivationPath = cosignerData.derivation ? cosignerData.derivation.replace(/h/g, "'") : undefined;
          const fingerprint =
            (cosignerData.ckcc_xfp
              ? MultisigHDWallet.ckccXfp2fingerprint(cosignerData.ckcc_xfp)
              : cosignerData.root_fingerprint?.toUpperCase()) || '00000000';
          if (cosignerData.seed) {
            this.addCosigner(ELECTRUM_SEED_PREFIX + cosignerData.seed, fingerprint, derivationPath, cosignerData.passphrase);
          } else if (cosignerData.xprv && MultisigHDWallet.isXprvValid(cosignerData.xprv)) {
            this.addCosigner(cosignerData.xprv, fingerprint, derivationPath);
          } else {
            this.addCosigner(cosignerData.xpub, fingerprint, derivationPath);
          }
        }

        if (cosignerData?.xpub) {
          const pathFormat = cosignerData.derivation ? getMultisigPathFormat(cosignerData.derivation.replace(/[hH]/g, "'")) : undefined;
          const keyFormat = decodeExtendedKey(cosignerData.xpub, 'public').format;
          const format = pathFormat ?? (keyFormat === 'multisigNative' ? 'native' : keyFormat === 'multisigNested' ? 'wrapped' : 'legacy');
          if (format === 'native') this.setNativeSegwit();
          if (format === 'wrapped') this.setWrappedSegwit();
          if (format === 'legacy') this.setLegacy();
        }
      }
    }

    // coldcard & cobo txt format:
    let customPathForCurrentCosigner: string | undefined;
    for (const line of secret.split('\n')) {
      const [key, ...valueParts] = line.split(':');
      const value = valueParts.join(':');
      switch (key) {
        case 'Name':
          this.setLabel(value.trim());
          break;

        case 'Policy':
          this.setM(parseInt(value.trim().split('of')[0].trim(), 10));
          break;

        case 'Derivation':
          this.setDerivationPath(value.trim());
          break;

        case 'Format':
          switch (value.trim()) {
            case MultisigHDWallet.FORMAT_P2WSH.toUpperCase():
              this.setNativeSegwit();
              break;
            case MultisigHDWallet.FORMAT_P2SH_P2WSH.toUpperCase():
            case MultisigHDWallet.FORMAT_P2SH_P2WSH_ALT.toUpperCase():
              this.setWrappedSegwit();
              break;
            case MultisigHDWallet.FORMAT_P2SH.toUpperCase():
              this.setLegacy();
              break;
          }
          break;

        default:
          if (key && value && MultisigHDWallet.isXpubString(value.trim())) {
            const path = customPathForCurrentCosigner ?? this._derivationPath;
            this.addCosigner(value.trim(), key, path);
            customPathForCurrentCosigner = undefined;
          } else if (key.replace('#', '').trim() === 'derivation') {
            customPathForCurrentCosigner = value.trim();
          } else if (key === 'seed') {
            const [rawSeed, passphrase] = value.split(' - ');
            const seed = rawSeed.trim();
            let fingerprint: string | undefined;
            if (seed.startsWith(ELECTRUM_SEED_PREFIX)) {
              const electrumSeed = MultisigHDWallet.convertElectrumMnemonicToSeed(seed, passphrase);
              fingerprint = MultisigHDWallet.seedToFingerprint(electrumSeed);
            }
            const path = customPathForCurrentCosigner ?? this._derivationPath;
            this.addCosigner(seed.trim(), fingerprint, path, passphrase);
            customPathForCurrentCosigner = undefined;
          }
          break;
      }
    }

    // is it wallet descriptor?
    // @see https://github.com/bitcoin/bitcoin/blob/master/doc/descriptors.md
    // @see https://github.com/Fonta1n3/FullyNoded/blob/master/Docs/Wallets/Wallet-Export-Spec.md
    if (!json && secret.indexOf('sortedmulti(')) {
      // provided secret was NOT json but plain wallet descriptor text. lets mock json
      json = { descriptor: secret, label: 'Multisig vault' };
    }
    if (secret.indexOf('sortedmulti(') !== -1 && json.descriptor) {
      if (json.label) this.setLabel(json.label);
      if (json.descriptor.includes('sh(wsh(')) {
        this.setWrappedSegwit();
      } else if (json.descriptor.includes('wsh(')) {
        this.setNativeSegwit();
      } else if (json.descriptor.includes('sh(')) {
        this.setLegacy();
      }

      const s2 = json.descriptor.substr(json.descriptor.indexOf('sortedmulti(') + 12);
      const s3 = s2.split(',');
      const M = parseInt(s3[0], 10);
      if (M) this.setM(M);

      for (let c = 1; c < s3.length; c++) {
        const re = /\[([^\]]+)\](.*)/;
        const m = s3[c].match(re);
        if (m && m.length === 3) {
          const hexFingerprint = m[1].split('/')[0];

          let path = 'm/' + m[1].split('/').slice(1).join('/').replace(/[h]/g, "'");
          if (path === 'm/') {
            // not considered valid by Bip32 lib
            path = 'm/0';
          }
          let xpub = m[2];
          if (xpub.indexOf('/') !== -1) {
            xpub = xpub.substr(0, xpub.indexOf('/'));
          }
          if (xpub.indexOf(')') !== -1) {
            xpub = xpub.substr(0, xpub.indexOf(')'));
          }

          this.addCosigner(xpub, hexFingerprint.toUpperCase(), path);
        }
      }

      if (this.getN() === 0) {
        // handling a case when smth went wrong and we didnt parse any cosigners, probably because
        // string is a bit non-standard, deesnt have chars like '['
        for (let c = 1; c < s3.length; c++) {
          const hexFingerprint = s3[c].split('/')[0];
          const indexes = extendedPublicKeyPrefixes.map(prefix => s3[c].indexOf(prefix)).filter(index => index >= 0);
          const indexOfXpub = indexes.length > 0 ? Math.min(...indexes) : -1;
          if (indexOfXpub === -1) {
            throw new Error('Could not parse cosigner in a descriptor');
          }

          const xpub = s3[c].substring(indexOfXpub).replaceAll(')', '');
          const path = 'm' + s3[c].substring(hexFingerprint.length, indexOfXpub);

          this.addCosigner(xpub, hexFingerprint.toUpperCase(), path);
        }
      }
    }

    // is it caravan?
    if (json && json.network === (bitcoinNetwork === 'testnet4' ? 'testnet' : 'mainnet') && json.quorum) {
      this.setM(+json.quorum.requiredSigners);
      if (json.name) this.setLabel(json.name);

      switch (json.addressType.toLowerCase()) {
        case MultisigHDWallet.FORMAT_P2SH:
          this.setLegacy();
          break;
        case MultisigHDWallet.FORMAT_P2SH_P2WSH:
        case MultisigHDWallet.FORMAT_P2SH_P2WSH_ALT:
          this.setWrappedSegwit();
          break;
        case MultisigHDWallet.FORMAT_P2WSH:
        default:
          this.setNativeSegwit();
          break;
      }

      for (const pk of json.extendedPublicKeys) {
        const path = MultisigHDWallet.isPathValid(json.bip32Path) ? json.bip32Path : "m/1'";
        this.addCosigner(pk.xpub, pk.xfp ?? '00000000', path);
      }
    }

    if (!this.getLabel()) this.setLabel('Multisig vault');

    return this;
  }

  _getDerivationPathByAddressWithCustomPath(address: string, customPathPrefix: string | undefined) {
    const path = customPathPrefix || this._derivationPath;
    for (let c = 0; c < this.next_free_address_index + this.gap_limit; c++) {
      if (this._getExternalAddressByIndex(c) === address) return path + '/0/' + c;
    }
    for (let c = 0; c < this.next_free_change_address_index + this.gap_limit; c++) {
      if (this._getInternalAddressByIndex(c) === address) return path + '/1/' + c;
    }

    return false;
  }

  _getWifForAddress(address: string): string {
    // @ts-ignore not applicable in multisig
    return false;
  }

  _getPubkeyByAddress(address: string): false | Buffer {
    throw new Error('Not applicable in multisig');
  }

  _getDerivationPathByAddress(address: string): string {
    throw new Error('Not applicable in multisig');
  }

  /**
   * Builds bip32Derivation entries (and the corresponding pubkeys) for every cosigner for a given address
   * of this wallet. Used both for inputs and for change outputs.
   */
  _getBip32DerivationsByAddress(address: string) {
    const bip32Derivation: TBip32Derivation = []; // array per each pubkey thats gona be used
    const pubkeys = [];
    for (const [cosignerIndex] of this._cosigners.entries()) {
      const path = this._getDerivationPathByAddressWithCustomPath(
        address,
        this._cosignersCustomPaths[cosignerIndex] || this._derivationPath,
      );
      // ^^ path resembles _custom path_, if provided by user during setup, otherwise default path for wallet type gona be used
      const masterFingerprint = hexToUint8Array(this._cosignersFingerprints[cosignerIndex]);

      if (!path) {
        throw new Error('Could not find derivation path for address ' + address);
      }

      const xpub = this._getXpubFromCosignerIndex(cosignerIndex);
      const hdNode0 = bip32.fromBase58(xpub, network);
      const splt = path.split('/');
      const internal = +splt[splt.length - 2];
      const index = +splt[splt.length - 1];
      const _node0 = hdNode0.derive(internal);
      const pubkey = _node0.derive(index).publicKey;
      pubkeys.push(pubkey);

      bip32Derivation.push({
        masterFingerprint,
        path,
        pubkey,
      });
    }

    return { bip32Derivation, pubkeys };
  }

  _addPsbtInput(psbt: Psbt, input: CoinSelectReturnInput, sequence: number, masterFingerprintBuffer?: Uint8Array) {
    if (!input.address) {
      throw new Error('Could not find address in input');
    }
    const { bip32Derivation, pubkeys } = this._getBip32DerivationsByAddress(input.address);

    if (!input.txhex) {
      throw new Error('Electrum server didnt provide txhex to properly create PSBT transaction');
    }

    if (this.isNativeSegwit()) {
      const p2wsh = bitcoin.payments.p2wsh({
        redeem: bitcoin.payments.p2ms({
          m: this._m,
          pubkeys: MultisigHDWallet.sortBuffers(pubkeys),
          network,
        }),
        network,
      });
      if (!p2wsh.redeem || !p2wsh.output) {
        throw new Error('Could not create p2wsh output');
      }
      const witnessScript = p2wsh.redeem.output;

      psbt.addInput({
        hash: input.txid,
        index: input.vout,
        sequence,
        bip32Derivation,
        witnessUtxo: {
          script: p2wsh.output,
          value: BigInt(input.value),
        },
        witnessScript,
        // hw wallets now require passing the whole previous tx as Buffer, as if it was non-segwit input, to mitigate
        // some hw wallets attack vector
        nonWitnessUtxo: hexToUint8Array(input.txhex),
      });
    } else if (this.isWrappedSegwit()) {
      const p2shP2wsh = bitcoin.payments.p2sh({
        redeem: bitcoin.payments.p2wsh({
          redeem: bitcoin.payments.p2ms({
            m: this._m,
            pubkeys: MultisigHDWallet.sortBuffers(pubkeys),
            network,
          }),
          network,
        }),
        network,
      });
      if (!p2shP2wsh?.redeem?.redeem?.output || !p2shP2wsh?.redeem?.output || !p2shP2wsh.output) {
        throw new Error('Could not create p2sh-p2wsh output');
      }

      const witnessScript = p2shP2wsh.redeem.redeem.output;
      const redeemScript = p2shP2wsh.redeem.output;

      psbt.addInput({
        hash: input.txid,
        index: input.vout,
        sequence,
        bip32Derivation,
        witnessUtxo: {
          script: p2shP2wsh.output,
          value: BigInt(input.value),
        },
        witnessScript,
        redeemScript,
        // hw wallets now require passing the whole previous tx as Buffer, as if it was non-segwit input, to mitigate
        // some hw wallets attack vector
        nonWitnessUtxo: hexToUint8Array(input.txhex),
      });
    } else if (this.isLegacy()) {
      const p2sh = bitcoin.payments.p2sh({
        redeem: bitcoin.payments.p2ms({
          m: this._m,
          pubkeys: MultisigHDWallet.sortBuffers(pubkeys),
          network,
        }),
        network,
      });
      if (!p2sh?.redeem?.output) {
        throw new Error('Could not create p2sh output');
      }
      const redeemScript = p2sh.redeem.output;
      psbt.addInput({
        hash: input.txid,
        index: input.vout,
        sequence,
        bip32Derivation,
        redeemScript,
        nonWitnessUtxo: hexToUint8Array(input.txhex),
      });
    } else {
      throw new Error('Dont know how to add input');
    }

    return psbt;
  }

  _getOutputDataForChange(address: string): TOutputData {
    const { bip32Derivation, pubkeys } = this._getBip32DerivationsByAddress(address);

    if (this.isLegacy()) {
      const p2sh = bitcoin.payments.p2ms({
        m: this._m,
        pubkeys: MultisigHDWallet.sortBuffers(pubkeys),
        network,
      });
      if (!p2sh.output) {
        throw new Error('Could not create redeemScript');
      }
      return {
        bip32Derivation,
        redeemScript: p2sh.output,
      };
    }

    if (this.isWrappedSegwit()) {
      const p2shP2wsh = bitcoin.payments.p2sh({
        redeem: bitcoin.payments.p2wsh({
          redeem: bitcoin.payments.p2ms({
            m: this._m,
            pubkeys: MultisigHDWallet.sortBuffers(pubkeys),
            network,
          }),
          network,
        }),
        network,
      });
      const witnessScript = p2shP2wsh?.redeem?.redeem?.output;
      const redeemScript = p2shP2wsh?.redeem?.output;
      if (!witnessScript || !redeemScript) {
        throw new Error('Could not create redeemScript or witnessScript');
      }
      return {
        bip32Derivation,
        witnessScript,
        redeemScript,
      };
    }

    if (this.isNativeSegwit()) {
      // not needed by coldcard, apparently..?
      const p2wsh = bitcoin.payments.p2wsh({
        redeem: bitcoin.payments.p2ms({
          m: this._m,
          pubkeys: MultisigHDWallet.sortBuffers(pubkeys),
          network,
        }),
        network,
      });
      const witnessScript = p2wsh?.redeem?.output;
      if (!witnessScript) {
        throw new Error('Could not create witnessScript');
      }
      return {
        bip32Derivation,
        witnessScript,
      };
    }

    throw new Error('dont know how to add change output');
  }

  howManySignaturesCanWeMake() {
    let howManyPrivKeysWeGot = 0;
    for (const cosigner of this._cosigners) {
      if (!MultisigHDWallet.isXpubString(cosigner) && !MultisigHDWallet.isXprvString(cosigner)) howManyPrivKeysWeGot++;
    }

    return howManyPrivKeysWeGot;
  }

  coinselect(
    utxos: CreateTransactionUtxo[],
    targets: CreateTransactionTarget[],
    feeRate: number,
  ): {
    inputs: CoinSelectReturnInput[];
    outputs: CoinSelectOutput[];
    fee: number;
  } {
    const _utxos = JSON.parse(JSON.stringify(utxos)) as CreateTransactionUtxo[];

    // overriding script length for proper vbytes calculation
    for (const u of _utxos) {
      if (u.script?.length) {
        continue;
      }

      if (this.isNativeSegwit()) {
        u.script = {
          length: Math.ceil((8 + this.getM() * 74 + this.getN() * 34) / 4),
        };
      } else if (this.isWrappedSegwit()) {
        u.script = {
          length: 35 + Math.ceil((8 + this.getM() * 74 + this.getN() * 34) / 4),
        };
      } else {
        u.script = {
          length: 2 + this.getM() * 74 + this.getN() * 34,
        };
      }
    }

    return super.coinselect(_utxos, targets, feeRate);
  }

  /**
   * @inheritDoc
   */
  createTransaction(
    utxos: CreateTransactionUtxo[],
    targets: CoinSelectTarget[],
    feeRate: number,
    changeAddress: string,
    sequence: number,
    skipSigning = false,
    masterFingerprint: number,
  ): CreateTransactionResult {
    if (targets.length === 0) throw new Error('No destination provided');
    if (this.howManySignaturesCanWeMake() === 0) skipSigning = true;

    const { inputs, outputs, fee } = this.coinselect(utxos, targets, feeRate);
    sequence = sequence || AbstractHDElectrumWallet.defaultRBFSequence;

    let psbt = new bitcoin.Psbt({ network });

    let c = 0;
    inputs.forEach(input => {
      c++;
      psbt = this._addPsbtInput(psbt, input, sequence);
    });

    outputs.forEach(output => {
      // if output has no address - this is change output
      let change = false;
      let address: string | undefined = output.address;
      if (!address) {
        change = true;
        output.address = changeAddress;
        address = changeAddress;
      }

      let outputData: Parameters<typeof psbt.addOutput>[0] = {
        address,
        value: BigInt(output.value),
      };

      if (change) {
        outputData = {
          ...outputData,
          ...this._getOutputDataForChange(address),
        };
      }

      psbt.addOutput(outputData);
    });

    if (!skipSigning) {
      // deriving a seed is an expensive pbkdf2 operation, so we prepare each signing cosigner's hd root
      // only once and reuse it for every input
      const hdRoots: BIP32Interface[] = [];
      for (const [cosignerIndex, cosigner] of this._cosigners.entries()) {
        if (MultisigHDWallet.isXpubString(cosigner)) continue;
        // ok this is a mnemonic, lets try to sign
        if (hdRoots.length >= this.getM()) {
          // dont sign more than we need, otherwise there will be "Too many signatures" error
          continue;
        }
        const passphrase = this._cosignersPassphrases[cosignerIndex];
        const seed = cosigner.startsWith(ELECTRUM_SEED_PREFIX)
          ? MultisigHDWallet.convertElectrumMnemonicToSeed(cosigner, passphrase)
          : bip39.mnemonicToSeedSync(cosigner, passphrase);
        hdRoots.push(bip32.fromSeed(seed, network));
      }

      for (let cc = 0; cc < c; cc++) {
        for (const hdRoot of hdRoots) {
          psbt.signInputHD(cc, hdRoot);
        }
      }
    }

    let tx;
    if (!skipSigning && this.howManySignaturesCanWeMake() >= this.getM()) {
      tx = psbt.finalizeAllInputs().extractTransaction();
    }
    return { tx, inputs, outputs, fee, psbt };
  }

  static convertElectrumMnemonicToSeed(cosigner: string, passphrase?: string) {
    let seed;
    try {
      seed = mn.mnemonicToSeedSync(cosigner.replace(ELECTRUM_SEED_PREFIX, ''), electrumSegwit(passphrase));
    } catch (_) {
      try {
        seed = mn.mnemonicToSeedSync(cosigner.replace(ELECTRUM_SEED_PREFIX, ''), electrumStandart(passphrase));
      } catch (__) {
        throw new Error('Not a valid electrum mnemonic');
      }
    }
    return seed;
  }

  /**
   * @see https://github.com/bitcoin/bips/blob/master/bip-0067.mediawiki
   */
  static sortBuffers(bufArr: Uint8Array[]): Uint8Array[] {
    return bufArr.sort(compareUint8Arrays);
  }

  prepareForSerialization() {
    this._hardwareWalletAssociations = this.getHardwareWalletAssociations();
    this._hardwareWalletRegistrations = this.getHardwareWalletRegistrations();
    // deleting structures that cant be serialized
    // @ts-ignore I dont want to make it optional
    delete this._nodes;
    this._cosignerXpubCache = {}; // no need to persist the cache
  }

  static isPathValid(path: string): boolean {
    const root = bip32.fromSeed(new Uint8Array(32), network);
    try {
      root.derivePath(path);
      return true;
    } catch (_) {}
    return false;
  }

  allowSend() {
    return true;
  }

  allowSignVerifyMessage() {
    return false;
  }

  async fetchUtxo() {
    await super.fetchUtxo();
    // now we need to fetch txhash for each input as required by PSBT
    const utxos = this.getUtxo(true);
    const txhexes = await BlueElectrum.multiGetTransactionByTxid(
      utxos.map(x => x.txid),
      false,
    );

    for (const u of utxos) {
      if (txhexes[u.txid]) u.txhex = txhexes[u.txid];
    }

    this._utxo = utxos;
  }

  getID() {
    const string2hash = [...this._cosigners].sort().join(',') + ';' + [...this._cosignersFingerprints].sort().join(',');
    return uint8ArrayToHex(sha256(string2hash));
  }

  calculateFeeFromPsbt(psbt: Psbt) {
    let goesIn = 0;
    const cacheUtxoAmounts: { [key: string]: number } = {};
    for (const inp of psbt.data.inputs) {
      if (inp.witnessUtxo && inp.witnessUtxo.value) {
        // segwit input
        goesIn += Number(inp.witnessUtxo.value);
      } else if (inp.nonWitnessUtxo) {
        // non-segwit input
        // lets parse this transaction and cache how much each input was worth
        const inputTx = bitcoin.Transaction.fromBuffer(inp.nonWitnessUtxo);
        let index = 0;
        for (const out of inputTx.outs) {
          cacheUtxoAmounts[inputTx.getId() + ':' + index] = Number(out.value);
          index++;
        }
      }
    }

    if (goesIn === 0) {
      // means we failed to get amounts that go in previously, so lets use utxo amounts cache we've build
      // from non-segwit inputs
      for (const inp of psbt.txInputs) {
        const cacheKey = uint8ArrayToHex(new Uint8Array(inp.hash).reverse()) + ':' + inp.index;
        if (cacheUtxoAmounts[cacheKey]) goesIn += cacheUtxoAmounts[cacheKey];
      }
    }

    let goesOut = 0;
    for (const output of psbt.txOutputs) {
      goesOut += Number(output.value);
    }

    return goesIn - goesOut;
  }

  calculateHowManySignaturesWeHaveFromPsbt(psbt: Psbt) {
    if (psbt.inputCount === 0) return 0;
    return Math.min(
      ...psbt.data.inputs.map(input => (input.finalScriptSig || input.finalScriptWitness ? this.getM() : (input.partialSig?.length ?? 0))),
    );
  }

  /**
   * Tries to signs passed psbt object (by reference). If there are enough signatures - tries to finalize psbt
   * and returns Transaction (ready to extract hex)
   */
  cosignPsbt(psbt: Psbt): { tx: Transaction | false } {
    // deriving a seed is an expensive pbkdf2 operation, so we prepare each signing cosigner's hd root
    // only once and reuse it for every input
    const hdRoots: { cosignerIndex: number; hdRoot: BIP32Interface }[] = [];
    for (const [cosignerIndex, cosigner] of this._cosigners.entries()) {
      if (MultisigHDWallet.isXpubString(cosigner)) continue;

      let hdRoot;
      if (MultisigHDWallet.isXprvString(cosigner)) {
        const xprv = convertExtendedKey(cosigner, 'legacy');
        hdRoot = bip32.fromBase58(xprv, network);
      } else {
        const passphrase = this._cosignersPassphrases[cosignerIndex];
        const seed = cosigner.startsWith(ELECTRUM_SEED_PREFIX)
          ? MultisigHDWallet.convertElectrumMnemonicToSeed(cosigner, passphrase)
          : bip39.mnemonicToSeedSync(cosigner, passphrase);
        hdRoot = bip32.fromSeed(seed, network);
      }
      hdRoots.push({ cosignerIndex, hdRoot });
    }

    for (let cc = 0; cc < psbt.inputCount; cc++) {
      for (const { cosignerIndex, hdRoot } of hdRoots) {
        try {
          psbt.signInputHD(cc, hdRoot);
        } catch (_) {} // protects agains duplicate cosignings

        if (!psbt.inputHasHDKey(cc, hdRoot)) {
          // failed signing as HD. probably bitcoinjs-lib could not match provided hdRoot's
          // fingerprint (or path?) to the ones in psbt, which is the case of stupid Electrum desktop which can
          // put bullshit paths and fingerprints in created psbt.
          // lets try to find correct priv key and sign manually.
          for (const derivation of psbt.data.inputs[cc].bip32Derivation || []) {
            // okay, here we assume that fingerprint is irrelevant, but ending of the path is somewhat correct and
            // correctly points to `/internal/index`, so we extract pubkey from our stored mnemonics+path and
            // match it to the one provided in PSBT's input, and if we have a match - we are in luck! we can sign
            // with this private key.
            const splt = derivation.path.split('/');
            const internal = +splt[splt.length - 2];
            const index = +splt[splt.length - 1];

            const path =
              hdRoot.depth === 0
                ? this.getCustomDerivationPathForCosigner(cosignerIndex + 1) + `/${internal ? 1 : 0}/${index}`
                : `${internal ? 1 : 0}/${index}`;
            // ^^^ we assume that counterparty has Zpub for specified derivation path
            // if hdRoot.depth !== 0 than this hdnode was recovered from xprv and it already has been set to root path
            const child = hdRoot.derivePath(path);
            if (child.privateKey && psbt.inputHasPubkey(cc, child.publicKey)) {
              const keyPair = ECPair.fromPrivateKey(child.privateKey, {
                network,
              });
              try {
                psbt.signInput(cc, keyPair);
              } catch (_) {}
            }
          }
        }
      }
    }

    if (this.calculateHowManySignaturesWeHaveFromPsbt(psbt) >= this.getM()) {
      for (let index = 0; index < psbt.inputCount; index++) {
        const input = psbt.data.inputs[index];
        if (input && !input.finalScriptSig && !input.finalScriptWitness) psbt.finalizeInput(index);
      }
      return { tx: psbt.extractTransaction() };
    }

    return { tx: false };
  }

  /**
   * Looks up xpub cosigner by index, and repalces it with seed + passphrase
   */
  replaceCosignerXpubWithSeed(externalIndex: number, mnemonic: string, passphrase?: string) {
    const index = externalIndex - 1;
    const fingerprint = this._cosignersFingerprints[index];
    if (!MultisigHDWallet.isXpubValid(this._cosigners[index])) throw new Error('This cosigner doesnt contain valid xpub');
    if (!bip39.validateMnemonic(mnemonic) && !MultisigHDWallet.isValidElectrumSeed(mnemonic))
      throw new Error('Not a valid mnemonic phrase');
    let calculatedFingerprint: string | undefined;
    if (MultisigHDWallet.isValidElectrumSeed(mnemonic)) {
      mnemonic = ELECTRUM_SEED_PREFIX + mnemonic;
      const electrumSeed = MultisigHDWallet.convertElectrumMnemonicToSeed(mnemonic, passphrase);
      calculatedFingerprint = MultisigHDWallet.seedToFingerprint(electrumSeed);
    } else {
      calculatedFingerprint = MultisigHDWallet.mnemonicToFingerprint(mnemonic, passphrase);
    }
    if (fingerprint !== calculatedFingerprint) {
      throw new Error('Fingerprint of new seed doesnt match');
    }
    const previousXpub = this._getXpubFromCosignerIndex(index);
    const path = this._cosignersCustomPaths[index] || this._derivationPath;
    const storedFingerprint = fingerprint?.toLowerCase();
    const replacementXpub = MultisigHDWallet.seedToXpub(mnemonic, path, passphrase);
    if (!sameBhwiExtendedPublicKey(previousXpub, replacementXpub)) {
      this.invalidateHardwareWalletRegistrations();
      this._hardwareWalletAssociations = this._hardwareWalletAssociations.filter(
        association =>
          association.fingerprint !== storedFingerprint ||
          association.path !== normalizeDerivationPath(path) ||
          !sameBhwiExtendedPublicKey(association.xpub, previousXpub),
      );
    }
    this._cosigners[index] = mnemonic.trim();
    this._cosignersPassphrases[index] = passphrase || undefined;
  }

  /**
   * Looks up cosigner with seed by index, and repalces it with xpub
   */
  replaceCosignerSeedWithXpub(externalIndex: number) {
    const index = externalIndex - 1;
    const mnemonics = this._cosigners[index];
    if (!bip39.validateMnemonic(mnemonics) && !MultisigHDWallet.isValidElectrumSeed(mnemonics.replace(ELECTRUM_SEED_PREFIX, '')))
      throw new Error('This cosigner doesnt contain valid xpub mnemonic phrase');
    const passphrase = this._cosignersPassphrases[index];
    const path = this._cosignersCustomPaths[index] || this._derivationPath;
    const xpub = convertExtendedKey(
      MultisigHDWallet.seedToXpub(mnemonics, path, passphrase),
      this.isNativeSegwit() ? 'multisigNative' : this.isWrappedSegwit() ? 'multisigNested' : 'legacy',
    );
    this._cosigners[index] = xpub;
    this._cosignersPassphrases[index] = undefined;
  }

  deleteCosigner(fp: string) {
    const foundIndex = this._cosignersFingerprints.indexOf(fp);
    if (foundIndex === -1) throw new Error('Cant find cosigner by fingerprint');
    const deletedFingerprint = this._cosignersFingerprints[foundIndex].toLowerCase();
    const deletedPath = this._cosignersCustomPaths[foundIndex] || this.getDerivationPath();
    const deletedKey = this._getXpubFromCosignerIndex(foundIndex);

    this.invalidateHardwareWalletRegistrations();
    this._cosignersFingerprints = this._cosignersFingerprints.filter((_el, index) => index !== foundIndex);
    this._cosigners = this._cosigners.filter((_el, index) => index !== foundIndex);
    this._cosignersCustomPaths = this._cosignersCustomPaths.filter((_el, index) => index !== foundIndex);
    this._cosignersPassphrases = this._cosignersPassphrases.filter((_el, index) => index !== foundIndex);
    this._hardwareWalletAssociations = this._hardwareWalletAssociations.filter(
      association =>
        association.fingerprint !== deletedFingerprint ||
        association.path !== deletedPath ||
        !sameBhwiExtendedPublicKey(association.xpub, deletedKey),
    );
  }

  getFormat() {
    if (this.isNativeSegwit()) return MultisigHDWallet.FORMAT_P2WSH;
    if (this.isWrappedSegwit()) return MultisigHDWallet.FORMAT_P2SH_P2WSH;
    if (this.isLegacy()) return MultisigHDWallet.FORMAT_P2SH;

    throw new Error('This should never happen');
  }

  /**
   * @param fp {string} Exactly 8 chars of hex
   * @return {boolean}
   */
  static isFpValid(fp: string) {
    if (fp.length !== 8) return false;
    return /^[0-9A-F]{8}$/i.test(fp);
  }

  /**
   * Returns TRUE only for _multisignature_ xpubs as per SLIP-0132
   * (capital Z, capital Y, or just xpub)
   * @see https://github.com/satoshilabs/slips/blob/master/slip-0132.md
   *
   * @param xpub
   * @return {boolean}
   */
  static isXpubForMultisig(xpub: string): boolean {
    try {
      return ['legacy', 'multisigNested', 'multisigNative'].includes(decodeExtendedKey(xpub, 'public').format);
    } catch {
      return false;
    }
  }

  isSegwit() {
    return this.isNativeSegwit() || this.isWrappedSegwit();
  }
}
