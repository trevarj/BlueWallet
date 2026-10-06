import { Platform } from 'react-native';
import type { Account, DeviceInfo } from '../../codegen/NativeBhwi';

jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  Object.defineProperty(actual, 'Platform', {
    value: actual.Platform,
    configurable: true,
  });
  return actual;
});

jest.mock('../../codegen/NativeSettingsModule', () => ({
  __esModule: true,
  get default() {
    return mockNativeModule;
  },
}));

const mockNativeModule = {
  getConstants: () => ({ bitcoinNetwork: 'testnet4' }),
};
function loadTestnetApp() {
  const bitcoin = require('bitcoinjs-lib');
  const ecc = require('../../blue_modules/noble_ecc').default;
  const bip32 = require('bip32').default(ecc);
  const ECPair = require('ecpair').ECPairFactory(ecc);
  bitcoin.initEccLib(ecc);
  return {
    bitcoin,
    bip32,
    ECPair,
    b58: require('bs58check'),
    profile: require('../../models/bitcoinNetwork'),
    extendedKey: require('../../class/wallets/extended-key'),
    HDSegwitBech32Wallet: require('../../class/wallets/hd-segwit-bech32-wallet').HDSegwitBech32Wallet,
    HDLegacyElectrumSeedP2PKHWallet: require('../../class/wallets/hd-legacy-electrum-seed-p2pkh-wallet').HDLegacyElectrumSeedP2PKHWallet,
    HDLegacyBreadwalletWallet: require('../../class/wallets/hd-legacy-breadwallet-wallet').HDLegacyBreadwalletWallet,
    MultisigHDWallet: require('../../class/wallets/multisig-hd-wallet').MultisigHDWallet,
    MultisigCosigner: require('../../class/multisig-cosigner').MultisigCosigner,
    DeeplinkSchemaMatch: require('../../class/deeplink-schema-match').default,
    SegwitBech32Wallet: require('../../class/wallets/segwit-bech32-wallet').SegwitBech32Wallet,
    WatchOnlyWallet: require('../../class/wallets/watch-only-wallet').WatchOnlyWallet,
    ur: require('../../blue_modules/ur'),
    bhwi: require('../../blue_modules/bhwi'),
    bhwiPsbt: require('../../blue_modules/bhwiPsbt'),
    validateBhwiPsbtOriginal: require('../../blue_modules/validateBhwiPsbt').validateBhwiPsbtOriginal,
    registry: require('@keystonehq/bc-ur-registry/dist'),
  };
}

Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
const app = loadTestnetApp();

const seed = Buffer.alloc(32, 7);

function accountNode(path: string) {
  return app.bip32.fromSeed(seed, app.profile.network).derivePath(path);
}

function pathComponents(path: string) {
  const { PathComponent } = app.registry;
  return path
    .replace(/^m\//, '')
    .split('/')
    .map(
      (component: string) =>
        new PathComponent({
          index: Number.parseInt(component, 10),
          hardened: component.endsWith("'"),
        }),
    );
}

function cryptoHDKey(
  path: string,
  childrenPath: string | false = '0/*',
  useInfo = new app.registry.CryptoCoinInfo(0, 1),
  sourceFingerprint = Buffer.from(app.bip32.fromSeed(seed, app.profile.network).fingerprint),
) {
  const { CryptoHDKey, CryptoKeypath, PathComponent } = app.registry;
  const node = accountNode(path);
  const payload = app.extendedKey.decodeExtendedKey(node.neutered().toBase58(), 'public').payload;
  const children = childrenPath
    ? new CryptoKeypath(
        childrenPath.split('/').map((component: string) =>
          component === '*'
            ? new PathComponent({ hardened: false })
            : new PathComponent({
                index: Number.parseInt(component, 10),
                hardened: component.endsWith("'"),
              }),
        ),
      )
    : undefined;
  return new CryptoHDKey({
    isMaster: false,
    isPrivateKey: false,
    key: Buffer.from(node.publicKey),
    chainCode: Buffer.from(node.chainCode),
    useInfo,
    origin: new CryptoKeypath(pathComponents(path), sourceFingerprint, node.depth),
    children,
    parentFingerprint: Buffer.from(payload.slice(5, 9)),
  });
}

function decodeRegistryItem(item: { toUREncoder: (length: number) => { nextPart: () => string } }): string {
  const decoder = new app.ur.BlueURDecoder();
  decoder.receivePart(item.toUREncoder(2000).nextPart());
  expect(decoder.isComplete()).toBe(true);
  return decoder.toString();
}

describe('fixed Testnet4 wallet profile', () => {
  it('strictly converts selected-family extended keys and rejects malformed or opposite-family payloads', () => {
    const { convertExtendedKey, decodeExtendedKey } = app.extendedKey;
    const root = app.bip32.fromSeed(seed, app.profile.network);
    const tpub = root.derivePath("m/84'/1'/0'").neutered().toBase58();
    const tprv = root.derivePath("m/84'/1'/0'").toBase58();
    const vpub = convertExtendedKey(tpub, 'native');
    const vprv = convertExtendedKey(tprv, 'native');

    expect(vpub).toMatch(/^vpub/);
    expect(vprv).toMatch(/^vprv/);
    expect(convertExtendedKey(vpub, 'legacy')).toBe(tpub);
    expect(convertExtendedKey(vprv, 'legacy')).toBe(tprv);
    expect(decodeExtendedKey(vpub, 'public')).toMatchObject({
      format: 'native',
      kind: 'public',
      encoding: 'testnet',
    });
    expect(app.MultisigHDWallet.isXpubValid(tpub)).toBe(true);
    expect(app.MultisigHDWallet.isXpubValid(tprv)).toBe(false);
    expect(app.MultisigHDWallet.isXprvValid(tprv)).toBe(true);
    expect(app.MultisigHDWallet.isXprvValid(tpub)).toBe(false);

    const mainnetXpub = app.bip32.fromSeed(seed, app.bitcoin.networks.bitcoin).neutered().toBase58();
    expect(() => convertExtendedKey(mainnetXpub, 'native')).toThrow(/not valid for testnet4/);

    const payload = app.b58.decode(tpub);
    expect(() => decodeExtendedKey(app.b58.encode(payload.slice(0, 77)))).toThrow(/78 bytes/);
    const badMarker = Uint8Array.from(payload);
    badMarker[45] = 4;
    expect(() => decodeExtendedKey(app.b58.encode(badMarker))).toThrow(/marker/);
  });

  it('uses coin type 1 while preserving nonstandard and BIP45 paths', () => {
    expect(app.HDSegwitBech32Wallet.derivationPath).toBe("m/84'/1'/0'");
    expect(app.MultisigHDWallet.PATH_NATIVE_SEGWIT).toBe("m/48'/1'/0'/2'");
    expect(app.MultisigHDWallet.PATH_WRAPPED_SEGWIT).toBe("m/48'/1'/0'/1'");
    expect(app.MultisigHDWallet.PATH_LEGACY).toBe("m/45'");
    expect(app.HDLegacyBreadwalletWallet.derivationPath).toBe("m/0'");
    expect(app.HDLegacyElectrumSeedP2PKHWallet.derivationPath).toBe('m');

    const wallet = new app.MultisigHDWallet();
    wallet.setDerivationPath(app.MultisigHDWallet.PATH_NATIVE_SEGWIT);
    const vpub = app.extendedKey.convertExtendedKey(
      accountNode(app.MultisigHDWallet.PATH_NATIVE_SEGWIT).neutered().toBase58(),
      'multisigNative',
    );
    const nonzeroAccount = new app.MultisigHDWallet();
    nonzeroAccount.setDerivationPath("m/48'/1'/7'/2'");
    expect(nonzeroAccount.isNativeSegwit()).toBe(true);
    wallet.addCosigner(vpub, 'D34DB33F', app.MultisigHDWallet.PATH_NATIVE_SEGWIT);
    expect(wallet.getN()).toBe(1);
    expect(
      app.MultisigHDWallet.isXpubValid(
        'Zpub74ijpfhERJNjhCKXRspTdLJV5eoEmSRZdHqDvp9kVtdVEyiXk7pXxRbfZzQvsDFpfDHEHVtVpx4Dz9DGUWGn2Xk5zG5u45QTMsYS2vjohNQ',
      ),
    ).toBe(false);
    expect(() => new app.MultisigHDWallet().addCosigner(vpub, 'AABBCCDD', "m/48'/0'/0'/2'")).toThrow(/coin type 1/);
  });

  it('derives test-encoded addresses and WIFs, rejects mainnet imports, and preserves descriptor precedence', () => {
    const testKey = app.ECPair.fromPrivateKey(Buffer.alloc(32, 3), {
      network: app.profile.network,
    });
    const mainKey = app.ECPair.fromPrivateKey(Buffer.alloc(32, 3), {
      network: app.bitcoin.networks.bitcoin,
    });
    const wallet = new app.SegwitBech32Wallet();
    wallet.setSecret(testKey.toWIF());
    expect(wallet.getAddress()).toMatch(/^tb1q/);
    const mainnetAddress = app.bitcoin.payments.p2wpkh({
      pubkey: mainKey.publicKey,
      network: app.bitcoin.networks.bitcoin,
    }).address;
    expect(wallet.isAddressValid(mainnetAddress)).toBe(false);
    expect(app.DeeplinkSchemaMatch.isBitcoinAddress(wallet.getAddress())).toBe(true);
    expect(app.DeeplinkSchemaMatch.isBitcoinAddress(mainnetAddress)).toBe(false);
    expect(app.DeeplinkSchemaMatch.bip21encode(wallet.getAddress())).toMatch(/^bitcoin:TB1/);
    expect(wallet.isAddressValid(wallet.getAddress())).toBe(true);

    const wrongWif = new app.SegwitBech32Wallet();
    wrongWif.setSecret(mainKey.toWIF());
    expect(wrongWif.getAddress()).toBe(false);

    const tpub = accountNode("m/84'/1'/0'").neutered().toBase58();
    const watchOnly = new app.WatchOnlyWallet();
    watchOnly.setSecret(tpub);
    watchOnly.init();
    expect(watchOnly.valid()).toBe(true);
    expect(watchOnly.getDerivationPath()).toBe("m/44'/1'/0'");

    const opposite = new app.WatchOnlyWallet();
    opposite.setSecret(app.bip32.fromSeed(seed, app.bitcoin.networks.bitcoin).neutered().toBase58());
    expect(opposite.valid()).toBe(false);
    expect(opposite.isHd()).toBe(true);
    expect(opposite.isXpubValid()).toBe(false);
    expect(() => new app.WatchOnlyWallet().setSecretForCustomPathImport(opposite.getSecret(), "m/84'/1'/0'")).toThrow(
      /not valid for testnet/,
    );
    expect(() =>
      new app.WatchOnlyWallet().setSecretForCustomPathImport(`[d34db33f/84'/0'/0']${opposite.getSecret()}`, "m/84'/1'/0'"),
    ).toThrow(/not valid for testnet|coin type 1/);

    const privateExtendedKey = new app.WatchOnlyWallet();
    privateExtendedKey.setSecret(accountNode("m/84'/1'/0'").toBase58());
    expect(privateExtendedKey.isHd()).toBe(true);
    expect(privateExtendedKey.isXpubValid()).toBe(false);
    expect(() => new app.WatchOnlyWallet().setSecretForCustomPathImport(privateExtendedKey.getSecret(), "m/84'/1'/0'")).toThrow(
      /extended public key/,
    );

    const foreignAccount = JSON.stringify({
      ExtPubKey: opposite.getSecret(),
      MasterFingerprint: 'D34DB33F',
      AccountKeyPath: "m/84'/0'/0'",
    });
    const structuredImport = new app.WatchOnlyWallet();
    expect(() => structuredImport.setSecret(foreignAccount)).toThrow(/not valid for testnet/);
    expect(structuredImport.getSecret()).toBe(foreignAccount);
    expect(structuredImport._derivationPath).toBeUndefined();

    const descriptor = new app.WatchOnlyWallet();
    descriptor.setSecret(`pkh([d34db33f/84'/1'/0']${tpub})`);
    descriptor.init();
    expect(descriptor.segwitType).toBe('p2pkh');
    expect(descriptor.getSecret()).toMatch(/^tpub/);
    expect(() => new app.WatchOnlyWallet().setSecret(`wpkh([d34db33f/84'/0'/0']${tpub})`)).toThrow(/coin type 1/);
  });

  it('builds and signs a PSBT from a locally constructed test-encoded parent transaction', () => {
    const source = new app.SegwitBech32Wallet();
    source.setSecret(
      app.ECPair.fromPrivateKey(Buffer.alloc(32, 4), {
        network: app.profile.network,
      }).toWIF(),
    );
    const destination = app.bitcoin.payments.p2wpkh({
      pubkey: app.ECPair.fromPrivateKey(Buffer.alloc(32, 5), {
        network: app.profile.network,
      }).publicKey,
      network: app.profile.network,
    }).address;
    const sourceAddress = source.getAddress();
    expect(sourceAddress).toMatch(/^tb1q/);

    const parent = new app.bitcoin.Transaction();
    parent.addInput(new Uint8Array(32), 0xffffffff);
    parent.addOutput(app.bitcoin.address.toOutputScript(sourceAddress, app.profile.network), 100_000n);

    const result = source.createTransaction(
      [
        {
          txid: parent.getId(),
          vout: 0,
          value: 100_000,
          address: sourceAddress,
          txhex: parent.toHex(),
        },
      ],
      [{ address: destination, value: 50_000 }],
      1,
      sourceAddress,
      0xffffffff,
      false,
      0,
    );

    expect(result.psbt.txInputs[0].hash).toEqual(new Uint8Array(Buffer.from(parent.getId(), 'hex').reverse()));
    const parsed = app.bitcoin.Psbt.fromBase64(result.psbt.toBase64(), {
      network: app.profile.network,
    });
    expect(parsed.txOutputs.every((output: { address?: string }) => output.address?.startsWith('tb1'))).toBe(true);
    expect(result.tx.getId()).toHaveLength(64);
    for (const output of result.tx.outs) {
      expect(app.bitcoin.address.fromOutputScript(output.script, app.profile.network)).toMatch(/^tb1q/);
    }
  });

  it('prepares a verified Testnet4 hardware wallet transaction from the real watch-only composer', async () => {
    expect(app.profile.bitcoinNetwork).toBe('testnet4');
    expect(app.profile.coinType).toBe(1);
    expect(app.profile.network).toBe(app.bitcoin.networks.testnet);
    expect(app.profile.genesisHash).toBe('00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043');
    const path = "m/84'/1'/0'";
    const root = app.bip32.fromSeed(seed, app.profile.network);
    const fingerprint = Buffer.from(root.fingerprint).toString('hex');
    const xpub = accountNode(path).neutered().toBase58();
    expect(Buffer.from(app.b58.decode(xpub)).readUInt32BE(0)).toBe(0x043587cf);
    const info: DeviceInfo = {
      family: 'jade',
      fingerprint,
      version: '1',
      model: null,
    };
    const account: Account = {
      family: 'jade',
      fingerprint,
      path,
      xpub,
      format: 'native-segwit',
      // Fixed checksum for the public throwaway seed above, including the native account's complete origin and branches.
      descriptor: `wpkh([${fingerprint}/84h/1h/0h]${xpub}/<0;1>/*)#kuj0z8zn`,
    };
    const wallet = app.WatchOnlyWallet.fromBhwiAccount(info, account, path, 'native-segwit');
    const association = wallet.getHardwareWalletAssociation();
    expect(association).toEqual({
      family: 'jade',
      fingerprint,
      path,
      xpub,
      format: 'native-segwit',
    });
    expect(wallet.getDerivationPath()).toBe(path);
    expect(Buffer.from(app.b58.decode(wallet.getSecret())).readUInt32BE(0)).toBe(0x045f1cf6);
    const sourceAddress = wallet._getExternalAddressByIndex(3);
    const changeAddress = wallet._getInternalAddressByIndex(2);
    const destination = app.bitcoin.payments.p2wpkh({
      pubkey: app.ECPair.fromPrivateKey(Buffer.alloc(32, 5), {
        network: app.profile.network,
      }).publicKey,
      network: app.profile.network,
    }).address;
    expect([sourceAddress, changeAddress, destination].every(address => address.startsWith('tb1q'))).toBe(true);
    const parent = new app.bitcoin.Transaction();
    parent.addInput(Buffer.alloc(32, 1), 0);
    parent.addOutput(app.bitcoin.address.toOutputScript(sourceAddress, app.profile.network), 100_000n);
    const result = wallet.createTransaction(
      [
        {
          txid: parent.getId(),
          vout: 0,
          value: 100_000,
          address: sourceAddress,
          txhex: parent.toHex(),
        },
      ],
      [{ address: destination, value: 50_000 }],
      1,
      changeAddress,
      0xfffffffd,
      false,
      0,
    );
    expect(result.tx).toBeUndefined();
    expect(result.psbt.data.inputs[0].nonWitnessUtxo).toBeUndefined();
    expect(result.psbt.data.inputs[0].bip32Derivation).toEqual([
      {
        masterFingerprint: new Uint8Array(Buffer.from(fingerprint, 'hex')),
        path: `${path}/0/3`,
        pubkey: accountNode(path).derive(0).derive(3).publicKey,
      },
    ]);
    const originalBase64 = result.psbt.toBase64();
    const fetchParents = jest.fn(async () => ({
      [parent.getId()]: parent.toHex(),
    }));
    const hydrated = await app.bhwiPsbt.hydrateBhwiPsbt(result.psbt, fetchParents);
    expect(fetchParents).toHaveBeenCalledTimes(1);
    expect(fetchParents).toHaveBeenCalledWith([parent.getId()]);
    expect(result.psbt.toBase64()).toBe(originalBase64);
    expect(Buffer.from(hydrated.data.inputs[0].nonWitnessUtxo).toString('hex')).toBe(parent.toHex());
    const validated = app.validateBhwiPsbtOriginal(hydrated.toBase64(), wallet, association);
    expect(validated.toBase64()).toBe(hydrated.toBase64());
    expect(app.bhwiPsbt.getBhwiPsbtReview(hydrated)).toEqual({
      fee: BigInt(result.fee),
      outputs: [
        { destination, value: 50_000n },
        { destination: changeAddress, value: 50_000n - BigInt(result.fee) },
      ],
    });

    const wrongParent = app.bitcoin.Transaction.fromHex(parent.toHex());
    wrongParent.version += 1;
    await expect(
      app.bhwiPsbt.hydrateBhwiPsbt(result.psbt, async () => ({
        [parent.getId()]: wrongParent.toHex(),
      })),
    ).rejects.toMatchObject({
      message: 'Unsupported hardware-wallet signing input',
    });
  });

  it('round-trips coin info and origins through account, HD key, multi-account, and multisig output URs', () => {
    const { CryptoAccount, CryptoMultiAccounts, CryptoOutput, MultiKey, ScriptExpressions } = app.registry;
    const masterFingerprint = Buffer.from('d34db33f', 'hex');
    const sourceFingerprint = Buffer.from(app.bip32.fromSeed(seed, app.profile.network).fingerprint).toString('hex').toUpperCase();
    const bip84 = cryptoHDKey("m/84'/1'/0'");
    const bip49Fingerprint = Buffer.from('01020304', 'hex');
    const bip49 = cryptoHDKey("m/49'/1'/0'", '0/*', new app.registry.CryptoCoinInfo(0, 1), bip49Fingerprint);

    const account = new CryptoAccount(masterFingerprint, [new CryptoOutput([ScriptExpressions.PUBLIC_KEY_HASH], bip84)]);
    const accountResult = JSON.parse(decodeRegistryItem(account));
    expect(accountResult[0]).toMatchObject({
      MasterFingerprint: sourceFingerprint,
      AccountKeyPath: "m/84'/1'/0'",
      Children: '0/*',
      UseInfo: { type: 0, network: 1 },
    });
    expect(accountResult[0].ExtPubKey).toMatch(/^tpub/); // script evidence wins over the BIP84 path

    const hdKeyResult = JSON.parse(decodeRegistryItem(bip84));
    expect(hdKeyResult[0].ExtPubKey).toMatch(/^vpub/);
    expect(hdKeyResult[0].Children).toBe('0/*');

    const custom = cryptoHDKey("m/123'/60'/0'");
    const multiAccounts = new CryptoMultiAccounts(masterFingerprint, [bip84, bip49, custom]);
    const multiAccountResult = JSON.parse(decodeRegistryItem(multiAccounts)) as {
      ExtPubKey: string;
      MasterFingerprint: string;
      UseInfo: { network: number };
    }[];
    expect(multiAccountResult.map(entry => entry.ExtPubKey.slice(0, 4))).toEqual(['vpub', 'upub', 'tpub']);
    expect(multiAccountResult.map(entry => entry.MasterFingerprint)).toEqual([sourceFingerprint, '01020304', sourceFingerprint]);
    expect(multiAccountResult.every(entry => entry.UseInfo.network === 1)).toBe(true);

    const multisigKeys = [cryptoHDKey("m/48'/1'/0'/2'", false), cryptoHDKey("m/48'/1'/1'/2'", false)];
    const output = new CryptoOutput(
      [ScriptExpressions.WITNESS_SCRIPT_HASH, ScriptExpressions.SORTED_MULTISIG],
      new MultiKey(2, multisigKeys),
    );
    const descriptor = decodeRegistryItem(output);
    expect(descriptor).toMatch(/^wsh\(sortedmulti\(2,/);
    expect(descriptor.match(/Vpub/g)).toHaveLength(2);
    expect(descriptor).toContain(`[${sourceFingerprint}/48'/1'/0'/2']`);
    expect(decodeRegistryItem(new CryptoAccount(masterFingerprint, [output]))).toBe(descriptor);

    const legacyOutput = new CryptoOutput(
      [ScriptExpressions.SCRIPT_HASH, ScriptExpressions.SORTED_MULTISIG],
      new MultiKey(2, multisigKeys),
    );
    const legacyDescriptor = decodeRegistryItem(legacyOutput);
    expect(legacyDescriptor).toMatch(/^sh\(sortedmulti\(2,/);
    expect(legacyDescriptor.match(/tpub/g)).toHaveLength(2);

    const unsupportedChildren = new CryptoOutput(
      [ScriptExpressions.WITNESS_SCRIPT_HASH, ScriptExpressions.SORTED_MULTISIG],
      new MultiKey(2, [cryptoHDKey("m/48'/1'/0'/2'"), cryptoHDKey("m/48'/1'/1'/2'", false)]),
    );
    expect(() => decodeRegistryItem(unsupportedChildren)).toThrow(/Unsupported multisig child template/);

    const unsorted = new CryptoOutput([ScriptExpressions.WITNESS_SCRIPT_HASH, ScriptExpressions.MULTISIG], new MultiKey(2, multisigKeys));
    expect(() => decodeRegistryItem(unsorted)).toThrow(/Unsorted multisig/);
    expect(() => decodeRegistryItem(new CryptoAccount(masterFingerprint, [output, output]))).toThrow(/multiple multisig policies/);

    const wrongNetworkKey = cryptoHDKey("m/84'/1'/0'", false, new app.registry.CryptoCoinInfo(0, 0));
    expect(() => decodeRegistryItem(wrongNetworkKey)).toThrow(/not valid for testnet4/);
  });

  it('binds app-owned cosigner accounts to Testnet4 while retaining UR test coin info', () => {
    const path = "m/48'/1'/7'/2'";
    const tpub = accountNode(path).neutered().toBase58();
    const cosigner = new app.MultisigCosigner(app.MultisigCosigner.exportToJson('D34DB33F', tpub, path));
    expect(cosigner.isNativeSegwit()).toBe(true);
    expect(cosigner.getXpub()).toMatch(/^Vpub/);
    const vpub = cosigner.getXpub();
    const json = app.MultisigCosigner.exportToJson('D34DB33F', tpub, path);
    expect(JSON.parse(json).network).toBe('testnet4');
    const [encoded] = app.ur.encodeUR(json, 175, null, 'URv2');
    const decoder = new app.ur.BlueURDecoder();
    decoder.receivePart(encoded);
    const [result] = JSON.parse(decoder.toString());

    expect(result.ExtPubKey).toMatch(/^Vpub/);
    expect(result.AccountKeyPath).toBe(path);
    expect(result.MasterFingerprint).toBe('D34DB33F');
    expect(result.UseInfo).toEqual({ type: 0, network: 1 });
    for (const network of ['bitcoin', 'testnet', 'testnet3']) {
      const foreignBinding = JSON.stringify({
        xfp: 'D34DB33F',
        xpub: vpub,
        network,
        path,
      });
      expect(new app.MultisigCosigner(foreignBinding).isValid()).toBe(false);
    }
  });

  it('binds hardware registrations and Ledger HMACs to the app chain, not test key versions', () => {
    const path = "m/48'/1'/7'/2'";
    const xpub = accountNode(path).neutered().toBase58();
    const association = {
      family: 'ledger',
      fingerprint: 'd34db33f',
      path,
      xpub,
      format: 'multisig-native',
    };
    expect(
      app.bhwi.parseHardwareWalletAssociation({
        ...association,
        fingerprint: 'D34DB33F',
      }),
    ).toBeUndefined();
    const descriptor = `wsh(sortedmulti(1,[d34db33f/48'/1'/7'/2']${xpub}/0/*))`;
    const registration = app.bhwi.createHardwareWalletRegistration(association, descriptor, 'complete');
    expect(registration.network).toBe('testnet4');
    expect(app.bhwi.parseHardwareWalletRegistration(registration)).toEqual(registration);
    for (const network of ['bitcoin', 'testnet', 'testnet3']) {
      expect(app.bhwi.parseHardwareWalletRegistration({ ...registration, network })).toBeUndefined();
    }
    expect(
      app.bhwi.parseHardwareWalletRegistration({
        ...registration,
        hmacService: 'obsolete-chain-binding',
      }),
    ).toBeUndefined();
  });
});
