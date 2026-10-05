import { MultisigHDWallet } from './wallets/multisig-hd-wallet';
import { bitcoinNetwork, getMultisigPathFormat, isCompatibleOrigin } from '../models/bitcoinNetwork';
import { convertExtendedKey, decodeExtendedKey } from './wallets/extended-key';

export class MultisigCosigner {
  private _data: string;
  private _fp: string = '';
  private _xpub: string = '';
  private _path: string = '';
  private _valid: boolean = false;
  private _cosigners: MultisigCosigner[];

  constructor(data: string) {
    this._data = data;
    this._cosigners = [];

    // is it a plain selected-network multisig extended public key?
    try {
      const format = decodeExtendedKey(data, 'public').format;
      if (['legacy', 'multisigNested', 'multisigNative'].includes(format)) {
        this._fp = '00000000';
        this._xpub = data;
        this._path =
          format === 'multisigNative'
            ? MultisigHDWallet.PATH_NATIVE_SEGWIT
            : format === 'multisigNested'
              ? MultisigHDWallet.PATH_WRAPPED_SEGWIT
              : MultisigHDWallet.PATH_LEGACY;
        this._valid = true;
        this._cosigners = [this];
        return;
      }
    } catch {}

    // is it wallet descriptor?
    if (data.startsWith('[')) {
      const end = data.indexOf(']');
      const part = data.substr(1, end - 1).replace(/[h]/g, "'");
      this._fp = part.split('/')[0];
      const xpub = data.substr(end + 1);

      if (MultisigCosigner.isXpubValid(xpub) && isCompatibleOrigin('m/' + part.split('/').slice(1).join('/'))) {
        this._xpub = xpub;
        this._path = 'm';
        for (let c = 0; c < part.split('/').length; c++) {
          if (c === 0) continue;
          this._path += '/' + part.split('/')[c];
        }
        this._cosigners = [this];
        this._valid = true;
        return;
      }
    }

    // is it cobo json?
    try {
      const json = JSON.parse(data);
      if (
        json.xfp &&
        json.xpub &&
        json.path &&
        (!json.network || json.network === bitcoinNetwork) &&
        MultisigCosigner.isXpubValid(json.xpub) &&
        isCompatibleOrigin(json.path)
      ) {
        this._fp = json.xfp;
        this._xpub = json.xpub;
        this._path = json.path;
        this._cosigners = [this];
        this._valid = true;

        const pathFormat = getMultisigPathFormat(this._path);
        if (decodeExtendedKey(this._xpub, 'public').format === 'legacy' && pathFormat && pathFormat !== 'legacy') {
          this._xpub = convertExtendedKey(this._xpub, pathFormat === 'native' ? 'multisigNative' : 'multisigNested');
        }

        return;
      }
    } catch (_) {
      this._valid = false;
    }

    // is it cobo crypto-account URv2 ?
    try {
      const json = JSON.parse(data);
      if (
        json &&
        json.ExtPubKey &&
        json.MasterFingerprint &&
        json.AccountKeyPath &&
        MultisigCosigner.isXpubValid(json.ExtPubKey) &&
        isCompatibleOrigin(json.AccountKeyPath)
      ) {
        this._fp = json.MasterFingerprint;
        this._xpub = json.ExtPubKey;
        this._path = json.AccountKeyPath;
        this._cosigners = [this];
        this._valid = true;
        return;
      }
    } catch (_) {
      this._valid = false;
    }

    // is it coldcard / unchained json?
    try {
      const json = JSON.parse(data);

      // p2wsh_p2sh (Coldcard), p2sh_p2wsh (Unchained)
      // same script type with reversed naming
      const xpub = json.p2wsh_p2sh || json.p2sh_p2wsh;
      const path = (json.p2wsh_p2sh_deriv || json.p2sh_p2wsh_deriv)?.replace(/h/g, "'");
      const p2sh_deriv = json.p2sh_deriv?.replace(/h/g, "'");
      const p2wsh_deriv = json.p2wsh_deriv?.replace(/h/g, "'");

      if (json.p2sh && p2sh_deriv && json.xfp) {
        const cc = new MultisigCosigner(MultisigCosigner.exportToJson(json.xfp, json.p2sh, p2sh_deriv));
        this._valid = true;
        this._cosigners.push(cc);
      }

      if (xpub && path && json.xfp) {
        const cc = new MultisigCosigner(MultisigCosigner.exportToJson(json.xfp, xpub, path));
        this._valid = true;
        this._cosigners.push(cc);
      }

      if (json.p2wsh && p2wsh_deriv && json.xfp) {
        const cc = new MultisigCosigner(MultisigCosigner.exportToJson(json.xfp, json.p2wsh, p2wsh_deriv));
        this._valid = true;
        this._cosigners.push(cc);
      }
    } catch (_) {
      this._valid = false;
    }

    // is it coldcardQ json?
    try {
      const json = JSON.parse(data);
      if (
        json &&
        json.chain === (bitcoinNetwork === 'testnet' ? 'XTN' : 'BTC') &&
        json.xfp &&
        (json.bip48_1 || json.bip48_2 || json.bip45)
      ) {
        if (json.bip48_1) {
          const path = json.bip48_1.deriv.replace(/h/g, "'");
          const xpub = json.bip48_1._pub || json.bip48_1.xpub; // ColdcardQ provides SLIP-0132 encoded _pub (Ypub/Zpub). Prefer it when present, fallback to xpub for legacy.
          const xfp = json.xfp;

          const cc = new MultisigCosigner(MultisigCosigner.exportToJson(xfp, xpub, path));
          this._valid = true;
          this._cosigners.push(cc);
        }
        if (json.bip48_2) {
          const path = json.bip48_2.deriv.replace(/h/g, "'");
          const xpub = json.bip48_2._pub || json.bip48_2.xpub; // ColdcardQ provides SLIP-0132 encoded _pub (Ypub/Zpub). Prefer it when present, fallback to xpub for legacy.
          const xfp = json.xfp;

          const cc = new MultisigCosigner(MultisigCosigner.exportToJson(xfp, xpub, path));
          this._valid = true;
          this._cosigners.push(cc);
        }
        if (json.bip45) {
          const path = json.bip45.deriv.replace(/h/g, "'");
          const xpub = json.bip45._pub || json.bip45.xpub; // ColdcardQ provides SLIP-0132 encoded _pub (Ypub/Zpub). Prefer it when present, fallback to xpub for legacy.
          const xfp = json.xfp;

          const cc = new MultisigCosigner(MultisigCosigner.exportToJson(xfp, xpub, path));
          this._valid = true;
          this._cosigners.push(cc);
        }
      }
    } catch (_) {
      this._valid = false;
    }
  }

  static isXpubValid(key: string) {
    return MultisigHDWallet.isXpubValid(key);
  }

  static exportToJson(xfp: string, xpub: string, path: string) {
    return JSON.stringify({
      xfp,
      xpub,
      network: bitcoinNetwork,
      path,
    });
  }

  isValid() {
    return this._valid;
  }

  getFp() {
    return this._fp;
  }

  getXpub() {
    return this._xpub;
  }

  getPath() {
    return this._path;
  }

  howManyCosignersWeHave() {
    return this._cosigners.length;
  }

  /**
   *
   * @returns {Array.<MultisigCosigner>}
   */
  getAllCosigners() {
    return this._cosigners;
  }

  isNativeSegwit() {
    return decodeExtendedKey(this.getXpub(), 'public').format === 'multisigNative';
  }

  isWrappedSegwit() {
    return decodeExtendedKey(this.getXpub(), 'public').format === 'multisigNested';
  }

  isLegacy() {
    return decodeExtendedKey(this.getXpub(), 'public').format === 'legacy';
  }

  getChainCodeHex() {
    return Buffer.from(decodeExtendedKey(this.getXpub(), 'public').payload.slice(13, 45)).toString('hex');
  }

  getKeyHex() {
    return Buffer.from(decodeExtendedKey(this.getXpub(), 'public').payload.slice(45)).toString('hex');
  }

  getParentFingerprintHex() {
    return Buffer.from(decodeExtendedKey(this.getXpub(), 'public').payload.slice(5, 9)).toString('hex');
  }

  getDepthNumber() {
    return decodeExtendedKey(this.getXpub(), 'public').payload[4];
  }
}
