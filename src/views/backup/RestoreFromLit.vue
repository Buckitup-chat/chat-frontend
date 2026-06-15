<template>
	<div>
		<div class="_divider mt-3">
			Restore from Online Shares
			<InfoTooltip class="align-self-center ms-2" :content="'Restore secret using Lit Protocol. You need to have enough unlocked shares assigned to your connected wallet.'" />
		</div>

		<Account_Activate_Reminder />
		<Offline_Reminder />

		<div v-if="!$userPQ.isAuthenticated" class="text-center mt-4">
			<p>Please connect your wallet to view online shares.</p>
		</div>

		<template v-else>
			<div v-if="fetching" class="text-center mt-4">
				<div class="spinner-border text-dark" role="status">
					<span class="visually-hidden">Loading...</span>
				</div>
			</div>

			<div v-else-if="!backups.length" class="text-center fs-4 mt-4 text-secondary">
				No online shares found for your wallet.
			</div>

			<div v-else class="mt-3">
				<div v-for="backup in backups" :key="backup.tag" class="card mb-3 shadow-sm">
					<div class="card-body">
						<h5 class="card-title text-primary fw-bold">{{ backup.tag }}</h5>
						<h6 class="card-subtitle mb-2 text-muted">Created: {{ $date(backup.createdAt).format('DD-MM-YY HH:mm') }}</h6>
						<p class="card-text">
							Shares available to you: <strong>{{ backup.availableShares.length }}</strong> / Threshold: <strong>{{ backup.treshold }}</strong>
						</p>
						
						<button 
							class="btn btn-dark w-100" 
							:disabled="backup.availableShares.length < backup.treshold || decrypting"
							@click="restoreBackup(backup)"
						>
							<span v-if="decrypting === backup.tag" class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>
							{{ backup.availableShares.length < backup.treshold ? 'Not enough shares' : 'Decrypt & Restore' }}
						</button>
					</div>
				</div>
			</div>
		</template>
	</div>
</template>

<script setup>
import { web3Store } from '@/store/web3.store';

import { userPQStore } from '@/store/userPQ.store';

import { useLoader } from '@/composables/useLoader';


import { ref, onMounted, inject } from 'vue';
import axios from 'axios';
import { Wallet } from 'ethers';
import { decryptToString } from '@lit-protocol/encryption';
import Account_Activate_Reminder from '@/components/Account_Activate_Reminder.vue';
import Offline_Reminder from '@/components/Offline_Reminder.vue';
import errorMessage from '@/utils/errorMessage';

const $userPQ = userPQStore();
const $web3 = web3Store();
const $loader = useLoader();
const $swal = inject('$swal');
const $date = inject('$date');
const $mitt = inject('$mitt');
const $swalModal = inject('$swalModal');
const $router = inject('$router');

const emit = defineEmits(['account']);

const backups = ref([]);
const fetching = ref(false);
const decrypting = ref(null);

onMounted(() => {
	if ($userPQ.isAuthenticated) {
		fetchShares();
	}
});

const fetchShares = async () => {
	const evmSkey = await $userPQ.getEvmPrivateKey();
	if (!evmSkey) return;

	fetching.value = true;
	try {
		const bk = (
			await axios.get(API_URL + '/backup/getAll', {
				params: { chainId: $web3.mainChainId },
			})
		).data;

		const backupsMap = {};

		for (let backup of bk) {
			if (backup.disabled) continue;

			let availableShares = [];

			for (let share of backup.shares) {
				if (share.disabled) continue;
				if (!share.unlocked) continue; // Lit requires it to be unlocked (granted = true)

				const stealthAddr = $web3.bukitupClient.getStealthAddressFromEphemeral(evmSkey, share.ephemeralPubKey);
				if (stealthAddr.toLowerCase() === share.stealthAddress.toLowerCase()) {
					const privateKey = $web3.bukitupClient.generateStealthPrivateKey(evmSkey, share.ephemeralPubKey);
					availableShares.push({ ...share, privateKey });
				}
			}

			if (availableShares.length > 0) {
				backupsMap[backup.tag] = {
					...backup,
					availableShares
				};
			}
		}

		backups.value = Object.values(backupsMap);
	} catch (error) {
		console.error('Failed to fetch online shares', error);
	}
	fetching.value = false;
};

const restoreBackup = async (backup) => {
	if (backup.availableShares.length < backup.treshold) return;
	
	decrypting.value = backup.tag;
	$loader.show();

	try {
		let decryptedShares = [];
		let errorCount = 0;

		for (let i = 0; i < backup.availableShares.length; i++) {
			if (decryptedShares.length >= backup.treshold) break;

			const shareInfo = backup.availableShares[i];
			try {
				const signer = new Wallet(shareInfo.privateKey);

				const checkAccess = await $web3.vaultContract.granted(backup.tag, shareInfo.idx, signer.address);
				if (!checkAccess) throw new Error('Not granted');

				const capacityDelegationAuthSig = (
					await axios.post(API_URL + '/lit/getCreditsSign', {
						address: signer.address,
					})
				).data;

				const sessionSigs = await $web3.getSessionSigs(signer, capacityDelegationAuthSig);
				const unifiedAccessControlConditions = $web3.getAccessControlConditions(backup.tag, shareInfo.idx);
				const ciphertext = Buffer.from(shareInfo.shareEncrypted.slice(2), 'hex');
				
				const decodedShare = await decryptToString(
					{
						unifiedAccessControlConditions,
						chain: 'sepolia',
						ciphertext: ciphertext.toString('base64'),
						dataToEncryptHash: shareInfo.shareEncryptedHash.slice(2),
						sessionSigs,
					},
					$web3.litClient,
				);

				const secret = await $web3.bukitupClient.decryptShare(decodedShare, shareInfo.privateKey);
				decryptedShares.push(secret);

			} catch (err) {
				console.error(`Failed to decrypt share index ${shareInfo.idx}`, err);
				errorCount++;
			}
		}

		await $web3.disconnectLit();

		if (decryptedShares.length < backup.treshold) {
			throw new Error(`Failed to decrypt enough shares. Decrypted: ${decryptedShares.length}, Required: ${backup.treshold}`);
		}

		const secretText = $web3.bukitupClient.recoverSecret(decryptedShares);
		const decoded = JSON.parse(secretText);
		
		if (!decoded.identity || !decoded.keys) {
			throw new Error('Invalid backup format after decryption');
		}

		const existing = $userPQ.myLocalUsers?.find(u => u.user_hash === decoded.identity.user_hash);
		if (existing) {
			const confirmed = await $swalModal.value.open({
				id: 'confirm',
				title: 'Account restore',
				content: `Account <strong>${decoded.identity.name}</strong> already exists. Replace it?`,
			});
			if (!confirmed) {
				decrypting.value = null;
				$loader.hide();
				return;
			}
		}

		await $userPQ.importBackup({ identity: decoded.identity, keys: decoded.keys });
		$mitt.emit('account::created');
		$router.replace({ name: 'chats_home' });
		emit('account');

	} catch (error) {
		console.error(error);
		$swal.fire({
			icon: 'error',
			title: 'Restore failed',
			text: errorMessage(error),
			timer: 15000,
		});
	}

	decrypting.value = null;
	$loader.hide();
};
</script>