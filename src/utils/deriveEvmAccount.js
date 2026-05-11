import * as secp from '@noble/secp256k1';
import { Wallet } from 'ethers';
import { web3Store } from '@/store/web3.store';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';

export async function deriveEvmAccount(evmPrivateKeyHex) {
  if (!evmPrivateKeyHex) return null;

  const privateKeyHex = evmPrivateKeyHex.startsWith('0x') ? evmPrivateKeyHex : '0x' + evmPrivateKeyHex;
  const wallet = new Wallet(privateKeyHex);
  const address = wallet.address;

  const signature = await wallet.signMessage(privateKeyHex);
  const meta = await web3Store().bukitupClient.generateKeysFromSignature(signature);

  const privKeyBytes = hexToBytes(privateKeyHex.slice(2));
  const pubKeyCompressed = secp.getPublicKey(privKeyBytes, true);

  return {
    wallet,
    address,
    privateKey: privateKeyHex,
    publicKey: '0x' + bytesToHex(pubKeyCompressed),
    metaPublicKey: meta.spendingKeyPair.account.publicKey,
    metaPrivateKey: meta.spendingKeyPair.privatekey,
  };
}
