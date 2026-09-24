// EVM helpers used by account activation and the Shamir backup flow.
// Node-based Compartmented Secret Sharing recovery is not built yet — see
// docs/backup-recovery-plan.md.

import { defineStore } from 'pinia';
import { BuckItUpClient } from 'buckitup-sdk';
import bcConfig from '../../bcConfig.json';
import { Wallet, JsonRpcProvider, Contract } from 'ethers';

const mainChainId = IS_PRODUCTION_API ? '11155111' : '225'; //
const bc = bcConfig[mainChainId];

const provider = new JsonRpcProvider(bc.chain.rpcUrl); // replace with your chain's RPC if needed
const registryContract = new Contract(bc.registry.address, JSON.parse(bc.registry.abijson), provider);
export const web3Store = defineStore('web3', () => {
	const blockExplorer = 'https://localtrace.io';

	const bukitupClient = new BuckItUpClient();

	const signTypedData = async (privateKey, domain, types, message) => {
		const signer = new Wallet(privateKey);
		const signature = await signer.signTypedData(domain, types, message);
		return signature;
	};

	const addressShort = (address) => {
		if (address) return address.replace(address.substring(6, 38), '...');
		return '...';
	};

	return {
		mainChainId,
		addressShort,
		bukitupClient,
		bc,
		blockExplorer,
		signTypedData,
		registryContract,
	};
});
