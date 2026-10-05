// Must be imported first to register CBOR semantic decoders (tag 303/304/etc.)
// Without this, nested tagged items inside crypto-multi-accounts/crypto-hdkey
// are decoded as plain Objects instead of DataItem instances, causing getData() errors.
import '@keystonehq/bc-ur-registry/dist/patchCBOR';
import {
  Bytes,
  CryptoAccount,
  CryptoCoinInfo,
  CryptoCoinInfoNetwork,
  CryptoCoinInfoType,
  CryptoHDKey,
  CryptoKeypath,
  CryptoOutput,
  CryptoPSBT,
  PathComponent,
  ScriptExpressions,
  CryptoMultiAccounts,
} from '@keystonehq/bc-ur-registry/dist';
import BIP32Factory from 'bip32';
import { URDecoder } from '@ngraveio/bc-ur';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Psbt } from 'bitcoinjs-lib';

import { MultisigCosigner } from '../../class/multisig-cosigner';
import { MultisigHDWallet } from '../../class/wallets/multisig-hd-wallet';
import ecc from '../noble_ecc';
import { bitcoinNetwork, coinType, getMultisigPathFormat, isCompatibleOrigin, network } from '../../models/bitcoinNetwork';
import { convertExtendedKey, encodeExtendedKey } from '../../class/wallets/extended-key';
import { joinQRs } from '../bbqr/join';
import { hexToUint8Array, stringToUint8Array, uint8ArrayToHex, uint8ArrayToBase64, uint8ArrayToString } from '../uint8array-extras';
import { splitQRs } from '../bbqr/split';
import { decodeUR as origDecodeUr, encodeUR as origEncodeUR, extractSingleWorkload as origExtractSingleWorkload } from '../bc-ur/dist';

const bip32 = BIP32Factory(ecc);
const urNetwork = bitcoinNetwork === 'testnet' ? CryptoCoinInfoNetwork.testnet : CryptoCoinInfoNetwork.mainnet;
const urCoinInfo = new CryptoCoinInfo(CryptoCoinInfoType.bitcoin, urNetwork);

const USE_UR_V1 = 'USE_UR_V1';
const USE_BBQR_WALLET_IDS = 'USE_BBQR_WALLET_IDS';

let useURv1 = false;
let useBBQRWalletIDs = [];

(async () => {
  try {
    useURv1 = !!(await AsyncStorage.getItem(USE_UR_V1));
  } catch (_) {}
})();

(async () => {
  try {
    // initial load of wallets that must use BBQR for animated QR codes
    const json = await AsyncStorage.getItem(USE_BBQR_WALLET_IDS);
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) {
      useBBQRWalletIDs = parsed;
    }
  } catch (_) {}
})();

async function isURv1Enabled() {
  try {
    return !!(await AsyncStorage.getItem(USE_UR_V1));
  } catch (_) {}

  return false;
}

async function setUseURv1() {
  useURv1 = true;
  return AsyncStorage.setItem(USE_UR_V1, '1');
}

async function setWalletIdMustUseBBQR(walletID) {
  console.log('setting walletID to useBBQR:', walletID);
  useBBQRWalletIDs.push(walletID);
  await AsyncStorage.setItem(USE_BBQR_WALLET_IDS, JSON.stringify(useBBQRWalletIDs));
}

async function clearUseURv1() {
  useURv1 = false;
  return AsyncStorage.removeItem(USE_UR_V1);
}

/**
 *
 * @param value {string} payload to render in QR
 * @param capacity {number?} Bytes per QR fragment
 * @param walletID {string?} Optional, if we previously saved preferences for that wallet (which protocol to use)
 * @param forceProtocol {'auto' | 'BBQR' | 'URv2' = 'auto'}
 * @returns {string[]}
 */
function encodeUR(value, capacity = 175, walletID, forceProtocol = 'auto') {
  if (forceProtocol === 'URv2') {
    return useURv1 ? encodeURv1(value, capacity) : encodeURv2(value, capacity);
  }

  if (forceProtocol === 'BBQR' || (walletID && useBBQRWalletIDs.includes(walletID))) {
    // payload should be hex
    if (!isHexString(value)) {
      value = uint8ArrayToHex(stringToUint8Array(value));
    }

    const minSplit = Math.max(1, Math.ceil(value.length / 2 / capacity));

    if (uint8ArrayToString(hexToUint8Array(value)).startsWith('psbt')) {
      // its a PSBT!
      const ret = splitQRs(hexToUint8Array(value), 'P', { minSplit });
      return ret.parts;
    }

    // its a random utf8 text!
    const ret = splitQRs(hexToUint8Array(value), 'U', { minSplit });
    return ret.parts;
  } // end BBQR

  // auto (aka default):
  return useURv1 ? encodeURv1(value, capacity) : encodeURv2(value, capacity);
}

function encodeURv1(arg1, arg2) {
  // first, lets check that its not a cosigner's json, which we do NOT encode at all:
  try {
    const json = JSON.parse(arg1);
    if (json && json.xpub && json.path && json.xfp) return [arg1];
  } catch (_) {}

  return origEncodeUR(arg1, arg2);
}

function isHexString(s) {
  return /^[0-9a-fA-F]*$/.test(s) && s.length % 2 === 0;
}

function assertHDKeyNetwork(hdKey) {
  const useInfo = hdKey.getUseInfo();
  const type = useInfo?.getType() ?? CryptoCoinInfoType.bitcoin;
  const keyNetwork = useInfo?.getNetwork() ?? CryptoCoinInfoNetwork.mainnet;
  const origin = hdKey.getOrigin();
  const originPath = origin ? 'm/' + origin.getPath() : '';
  // Older Keystone account payloads encoded Bitcoin as type 1; accept that only with a conventional selected-chain origin.
  const legacyBitcoinType =
    type === 1 && isCompatibleOrigin(originPath) && new RegExp(`^m/(44|48|49|84|86)'/${coinType}'(?:/|$)`).test(originPath);
  if ((type !== CryptoCoinInfoType.bitcoin && !legacyBitcoinType) || keyNetwork !== urNetwork) {
    throw new Error(`UR HD key is not valid for ${bitcoinNetwork}`);
  }

  if (origin && !isCompatibleOrigin(originPath)) {
    throw new Error('UR HD key origin is not valid for this network');
  }
}

/**
 *
 * @param str {string} For PSBT, or coordination setup (translates to `bytes`) it expects hex string. For ms cosigner it expects plain json string
 * @param len {number} length of each fragment
 * @return {string[]} txt fragments ready to be displayed in dynamic QR
 */
function encodeURv2(str, len) {
  // now, lets do some intelligent guessing what we've got here, psbt hex, or json with a multisig cosigner..?

  try {
    const cosigner = new MultisigCosigner(str);

    if (cosigner.isValid()) {
      let scriptExpressions = false;

      if (cosigner.isNativeSegwit()) {
        scriptExpressions = [ScriptExpressions.WITNESS_SCRIPT_HASH];
      } else if (cosigner.isWrappedSegwit()) {
        scriptExpressions = [ScriptExpressions.SCRIPT_HASH, ScriptExpressions.WITNESS_SCRIPT_HASH];
      } else if (cosigner.isLegacy()) {
        scriptExpressions = [ScriptExpressions.SCRIPT_HASH];
      } else {
        return ['unsupported multisig type'];
      }

      const cryptoKeyPathComponents = [];
      for (const component of cosigner.getPath().split('/')) {
        if (component === 'm') continue;
        const index = parseInt(component);
        const hardened = component.endsWith('h') || component.endsWith("'");
        cryptoKeyPathComponents.push(new PathComponent({ index, hardened }));
      }

      const cryptoAccount = new CryptoAccount(Buffer.from(cosigner.getFp(), 'hex'), [
        new CryptoOutput(
          scriptExpressions,
          new CryptoHDKey({
            isMaster: false,
            key: Buffer.from(cosigner.getKeyHex(), 'hex'),
            chainCode: Buffer.from(cosigner.getChainCodeHex(), 'hex'),
            useInfo: urCoinInfo,
            origin: new CryptoKeypath(cryptoKeyPathComponents, Buffer.from(cosigner.getFp(), 'hex'), cosigner.getDepthNumber()),
            parentFingerprint: Buffer.from(cosigner.getParentFingerprintHex(), 'hex'),
          }),
        ),
      ]);
      const ur = cryptoAccount.toUREncoder(2000).nextPart();
      return [ur];
    }
  } catch (_) {}

  // not account. lets try psbt

  try {
    Psbt.fromHex(str, { network }); // will throw if not PSBT hex
    const data = Buffer.from(str, 'hex');
    const cryptoPSBT = new CryptoPSBT(data);
    const encoder = cryptoPSBT.toUREncoder(len);

    const ret = [];
    for (let c = 1; c <= encoder.fragmentsLength; c++) {
      const ur = encoder.nextPart();
      ret.push(ur);
    }

    return ret;
  } catch (_) {}

  // fail. fallback to bytes
  const bytes = new Bytes(Buffer.from(str, 'hex'));
  const encoder = bytes.toUREncoder(len);

  const ret = [];
  for (let c = 1; c <= encoder.fragmentsLength; c++) {
    const ur = encoder.nextPart();
    ret.push(ur);
  }

  return ret;
}

function extractSingleWorkload(arg) {
  return origExtractSingleWorkload(arg);
}

function decodeUR(arg) {
  try {
    return origDecodeUr(arg);
  } catch (_) {}

  const decoder = new URDecoder();

  for (const part of arg) {
    decoder.receivePart(part);
  }

  if (!decoder.isComplete()) {
    throw new Error("decodeUR func can't work with multimart BC-UR data. Prease use BlueURDecoder instead.");
  }

  if (!decoder.isSuccess()) {
    throw new Error(decoder.resultError());
  }

  const decoded = decoder.resultUR();

  if (decoded.type === 'crypto-psbt') {
    const cryptoPsbt = CryptoPSBT.fromCBOR(decoded.cbor);
    return cryptoPsbt.getPSBT().toString('hex');
  }

  if (decoded.type === 'bytes') {
    const b = Bytes.fromCBOR(decoded.cbor);
    return b.getData();
  }

  const cryptoAccount = CryptoAccount.fromCBOR(decoded.cbor);
  const outputs = cryptoAccount.getOutputDescriptors();
  const multisigOutputCount = outputs.filter(candidate => candidate.getMultiKey()).length;
  if (multisigOutputCount > 0 && outputs.length !== 1) {
    throw new Error(
      multisigOutputCount === outputs.length
        ? 'crypto-account contains multiple multisig policies'
        : 'crypto-account mixes multisig and single-key outputs',
    );
  }
  const output = outputs[0];
  const masterFingerprint = uint8ArrayToHex(cryptoAccount.getMasterFingerprint()).toUpperCase();
  let decodedAccount;
  if (output.getMultiKey()) {
    decodedAccount = _outputToDescriptor(output, masterFingerprint);
  } else {
    const result = _hdKeyToResult(output.getCryptoKey(), masterFingerprint, output.getScriptExpressions());
    if (!result) throw new Error('crypto-account contains an unsupported key');
    decodedAccount = JSON.stringify(result);
  }
  return uint8ArrayToHex(stringToUint8Array(decodedAccount));
}

function _formatForHDKey(hdKey, scriptExpressions = [], forceMultisig = false) {
  const scripts = scriptExpressions.map(expression => expression.getExpression());
  const path = hdKey.getOrigin() ? 'm/' + hdKey.getOrigin().getPath() : '';
  const explicitMultisig =
    scripts.includes(ScriptExpressions.MULTISIG.getExpression()) || scripts.includes(ScriptExpressions.SORTED_MULTISIG.getExpression());
  const multisig = forceMultisig || explicitMultisig || scripts.includes(ScriptExpressions.WITNESS_SCRIPT_HASH.getExpression());

  // Script evidence is authoritative, followed by the explicit origin path.
  if (multisig && scripts.includes(ScriptExpressions.WITNESS_SCRIPT_HASH.getExpression())) {
    return scripts.includes(ScriptExpressions.SCRIPT_HASH.getExpression()) ? 'multisigNested' : 'multisigNative';
  }
  if (explicitMultisig) return 'legacy';
  if (!multisig && scripts.includes(ScriptExpressions.WITNESS_PUBLIC_KEY_HASH.getExpression())) {
    return scripts.includes(ScriptExpressions.SCRIPT_HASH.getExpression()) ? 'nested' : 'native';
  }
  if (!multisig && scripts.includes(ScriptExpressions.PUBLIC_KEY_HASH.getExpression())) return 'legacy';
  const multisigPathFormat = getMultisigPathFormat(path);
  if (multisigPathFormat === 'native') return 'multisigNative';
  if (multisigPathFormat === 'wrapped') return 'multisigNested';
  if (multisigPathFormat === 'legacy') return 'legacy';
  if (new RegExp(`^m/49'/${coinType}'/\\d+'$`).test(path)) return 'nested';
  if (new RegExp(`^m/84'/${coinType}'/\\d+'$`).test(path)) return 'native';
  return 'legacy';
}

function _hdKeyToExtendedKey(hdKey, format) {
  assertHDKeyNetwork(hdKey);
  const origin = hdKey.getOrigin();
  const components = origin?.getComponents();
  const chainCode = hdKey.getChainCode();
  let key = hdKey.getKey();
  if (!origin || !components?.length || !chainCode || !key) throw new Error('UR HD key is missing origin or key data');

  const privateKey = hdKey.isPrivateKey();
  if (privateKey && key.length === 32) {
    const privateKeyData = new Uint8Array(33);
    privateKeyData.set(key, 1);
    key = privateKeyData;
  }

  const lastComponent = components[components.length - 1];
  const index = lastComponent.isHardened() ? lastComponent.getIndex() + 0x80000000 : lastComponent.getIndex();
  const encoded = encodeExtendedKey(
    format,
    privateKey ? 'private' : 'public',
    origin.getDepth() ?? components.length,
    hdKey.getParentFingerprint() || new Uint8Array(4),
    index,
    chainCode,
    key,
  );
  if (!privateKey) return encoded;

  const publicKey = bip32.fromBase58(convertExtendedKey(encoded, 'legacy'), network).neutered().toBase58();
  return convertExtendedKey(publicKey, format);
}

function _hdKeyToResult(hdKey, masterFingerprintOverride, scriptExpressions = [], filterNonBitcoin = false) {
  if (!hdKey) return null;
  const origin = hdKey.getOrigin();
  const components = origin?.getComponents();
  const conventionalOrigin =
    components?.length >= 2 &&
    components[0].isHardened() &&
    components[1].isHardened() &&
    [44, 48, 49, 84, 86].includes(components[0].getIndex());
  const pathCoinType = conventionalOrigin ? components[1].getIndex() : undefined;
  const type = hdKey.getUseInfo()?.getType() ?? CryptoCoinInfoType.bitcoin;
  const legacyBitcoinType = type === 1 && conventionalOrigin && pathCoinType === coinType;
  if (filterNonBitcoin && type !== CryptoCoinInfoType.bitcoin && !legacyBitcoinType) return null;
  if (filterNonBitcoin && pathCoinType !== undefined && pathCoinType !== coinType && pathCoinType > 1) return null;
  if (!components?.length) return null;

  const format = _formatForHDKey(hdKey, scriptExpressions);
  const result = {
    ExtPubKey: _hdKeyToExtendedKey(hdKey, format),
    MasterFingerprint:
      (origin.getSourceFingerprint() ? uint8ArrayToHex(origin.getSourceFingerprint()).toUpperCase() : '') ||
      masterFingerprintOverride ||
      '',
    AccountKeyPath: 'm/' + origin.getPath(),
    UseInfo: {
      type: hdKey.getUseInfo()?.getType() ?? CryptoCoinInfoType.bitcoin,
      network: hdKey.getUseInfo()?.getNetwork() ?? CryptoCoinInfoNetwork.mainnet,
    },
  };
  const children = hdKey.getChildren();
  if (children) result.Children = children.getPath();
  return result;
}

function _hdKeyDescriptorContent(hdKey, masterFingerprintOverride, scriptExpressions, forceMultisig) {
  const origin = hdKey.getOrigin();
  if (!origin) throw new Error('UR output key is missing its origin');
  const fingerprint =
    (origin.getSourceFingerprint() && uint8ArrayToHex(origin.getSourceFingerprint()).toUpperCase()) ||
    masterFingerprintOverride ||
    '00000000';
  const childrenPath = hdKey.getChildren()?.getPath();
  if (forceMultisig && childrenPath) {
    throw new Error(`Unsupported multisig child template: ${childrenPath}`);
  }
  const format = _formatForHDKey(hdKey, scriptExpressions, forceMultisig);
  let descriptor = `[${fingerprint}/${origin.getPath()}]${_hdKeyToExtendedKey(hdKey, format)}`;
  if (childrenPath) descriptor += '/' + childrenPath;
  return descriptor;
}

function _outputToDescriptor(output, masterFingerprintOverride) {
  const scriptExpressions = output.getScriptExpressions();
  const multiKey = output.getMultiKey();
  const scripts = scriptExpressions.map(expression => expression.getExpression());
  if (multiKey && !scripts.includes(ScriptExpressions.SORTED_MULTISIG.getExpression())) {
    throw new Error('Unsorted multisig UR outputs are not supported');
  }
  let content;
  if (multiKey) {
    content = [
      multiKey.getThreshold(),
      ...multiKey.getKeys().map(key => _hdKeyDescriptorContent(key, masterFingerprintOverride, scriptExpressions, true)),
    ].join(',');
  } else {
    const hdKey = output.getHDKey();
    if (!hdKey) throw new Error('UR output does not contain an HD key');
    content = _hdKeyDescriptorContent(hdKey, masterFingerprintOverride, scriptExpressions, false);
  }

  return scriptExpressions.reduceRight((descriptor, expression) => `${expression.getExpression()}(${descriptor})`, content);
}

class BlueURDecoder extends URDecoder {
  bbqrParts = {}; // key-value, payload->1

  toString() {
    if (Object.keys(this.bbqrParts).length > 0) {
      // its BBQR, handle differently
      const decodedBbqr = joinQRs(Object.keys(this.bbqrParts));
      if (decodedBbqr.fileType === 'P') {
        // if its psbt we return base64:
        return uint8ArrayToBase64(decodedBbqr.raw);
      }

      // for everything else we covnert bytes to string directly
      return uint8ArrayToString(decodedBbqr.raw);
    }

    const decoded = this.resultUR();

    if (decoded.type === 'crypto-psbt') {
      const cryptoPsbt = CryptoPSBT.fromCBOR(decoded.cbor);
      return cryptoPsbt.getPSBT().toString('base64');
    }

    if (decoded.type === 'bytes') {
      const bytes = Bytes.fromCBOR(decoded.cbor);
      const data = bytes.getData();
      return uint8ArrayToString(data);
    }

    if (decoded.type === 'crypto-account') {
      const cryptoAccount = CryptoAccount.fromCBOR(decoded.cbor);
      const masterFingerprint = uint8ArrayToHex(cryptoAccount.getMasterFingerprint()).toUpperCase();
      const outputs = cryptoAccount.getOutputDescriptors();
      const descriptors = outputs.filter(output => output.getMultiKey()).map(output => _outputToDescriptor(output, masterFingerprint));
      if (descriptors.length > 0) {
        if (descriptors.length !== outputs.length) throw new Error('crypto-account mixes multisig and single-key outputs');
        if (descriptors.length !== 1) throw new Error('crypto-account contains multiple multisig policies');
        return descriptors[0];
      }

      const results = outputs.map(output => _hdKeyToResult(output.getCryptoKey(), masterFingerprint, output.getScriptExpressions()));
      if (results.some(result => !result)) throw new Error('crypto-account contains an unsupported key');
      return JSON.stringify(results);
    }

    if (decoded.type === 'crypto-output') {
      const output = CryptoOutput.fromCBOR(decoded.cbor);
      return _outputToDescriptor(output, null);
    }

    if (decoded.type === 'crypto-hdkey') {
      const hdKey = CryptoHDKey.fromCBOR(decoded.cbor);
      const result = _hdKeyToResult(hdKey, null);
      if (!result) throw new Error('crypto-hdkey: missing origin or components');
      return JSON.stringify([result]);
    }

    if (decoded.type === 'crypto-multi-accounts') {
      const multiAccounts = CryptoMultiAccounts.fromCBOR(decoded.cbor);
      const masterFingerprint = uint8ArrayToHex(multiAccounts.getMasterFingerprint()).toUpperCase();

      const results = [];
      for (const hdKey of multiAccounts.getKeys()) {
        // skip keys without a valid Bitcoin derivation path (e.g. ETH/SOL keys)
        const result = _hdKeyToResult(hdKey, masterFingerprint, [], true);
        if (result) results.push(result);
      }

      if (results.length === 0) throw new Error('crypto-multi-accounts: no valid Bitcoin keys found');
      return JSON.stringify(results);
    }

    // For all other UR types (e.g. btc-signature, eth-signature, sol-signature),
    // return the raw CBOR hex so callers can handle it if needed.
    return decoded.cbor.toString('hex');
  }

  isComplete() {
    if (Object.keys(this.bbqrParts).length > 0) {
      // its BBQR, handle differently
      const bbqrPayload = Object.keys(this.bbqrParts)[0];
      if (bbqrPayload.slice(0, 2) !== 'B$') {
        throw new Error('fixed header not found, expected B$');
      }

      const numParts = parseInt(bbqrPayload.slice(4, 6), 36);
      return Object.keys(this.bbqrParts).length >= numParts;
    }

    // fallback to old BC-UR mechanism
    return super.isComplete();
  }

  estimatedPercentComplete() {
    if (Object.keys(this.bbqrParts).length > 0) {
      // its BBQR, handle differently
      const bbqrPayload = Object.keys(this.bbqrParts)[0];
      if (bbqrPayload.slice(0, 2) !== 'B$') {
        throw new Error('fixed header not found, expected B$');
      }

      const numParts = parseInt(bbqrPayload.slice(4, 6), 36);
      return Object.keys(this.bbqrParts).length / numParts;
    }

    // fallback to old BC-UR mechanism
    return super.estimatedPercentComplete();
  }

  receivePart(s) {
    if (s.startsWith('B$')) {
      // its BBQR, handle differently
      this.bbqrParts[s] = true;
      return true;
    }

    // fallback to old BC-UR mechanism
    return super.receivePart(s);
  }
}

export {
  decodeUR,
  encodeUR,
  extractSingleWorkload,
  BlueURDecoder,
  isURv1Enabled,
  setUseURv1,
  clearUseURv1,
  setWalletIdMustUseBBQR,
  isHexString,
};
