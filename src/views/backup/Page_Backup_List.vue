<template>
	<div>
		<div class="d-flex align-items-center justify-content-between mb-3">
			<div class="d-flex align-items-center w-100">
				<div class="_search flex-grow-1">
					<div class="_input_search ps-2">
						<input class="" type="text" v-model="data.query.s" autocomplete="off" placeholder="find by backup tag..." />
						<div class="_icon_times" v-if="data.query.s" @click="resetSearch()"></div>
					</div>
				</div>

				<div class="d-flex">
					<button class="btn btn-dark ms-1 rounded-pill d-flex align-items-center flex-fill py-2" @click="search()">
						<i class="_icon_search bg-white"></i>
						<span class="d-none d-sm-block ms-2">{{ data.query.s ? 'Search' : 'Scan' }}</span>
					</button>

					<button class="btn btn-dark ms-1 rounded-pill" @click="getList()">
						<i class="_icon_reload bg-white"></i>
					</button>
                    
                    <button v-if="$userPQ.isAuthenticated" class="btn btn-dark rounded-pill ms-1 d-flex align-items-center justify-content-center py-2"
						@click="$router.push({ name: 'backup_create' })">
						<i class="_icon_plus bg-white"></i>
						<span class="ms-2" v-if="$breakpoint.gte('sm')">Create</span>
					</button>
				</div>
			</div>
		</div>

        <Account_Activate_Reminder />
        <Offline_Reminder />
        <template v-if="$userPQ.isAuthenticated">
            <div v-if="data.fetched">
                <div v-if="!data.items.length" class="mt-3">
                    <div class="text-center fs-2 mb-3">No backups found</div>

                    <div class="row justify-content-center gx-2 mb-2" v-if="!data.searched">
                        <div class="col-lg-12 col-xl-10">
                            <button type="button" class="btn btn-dark w-100" @click="$router.push({ name: 'backup_create' })"
                                :disabled="false">Create backup</button>
                        </div>
                    </div>
                </div>
                <div class="_data_block mb-3" v-for="(backup, $index) in data.items"
                        :key="backup.id + backup.fetchTimestamp">
                        <BackupItem :backup="backup" />
                </div>
            </div>

            <Paginate :page-count="parseInt(data.totalPages)" :click-handler="setPage"
                :force-page="parseInt(data.query.page)"> </Paginate>
        </template>
	</div>
</template>

<style lang="scss" scoped>
@import '@/scss/variables.scss';
@import '@/scss/breakpoints.scss';

._search {
	height: 2.2rem;

	@include media-breakpoint-up(sm) {
		height: 2.5rem;
	}
}
</style>

<script setup>
import Offline_Reminder from '../../components/Offline_Reminder.vue';
import Account_Activate_Reminder from '@/components/Account_Activate_Reminder.vue';
import BackupItem from './Backup_Item.vue';
import Paginate from '@/components/Paginate.vue';
import { ref, onMounted, inject, onUnmounted, watch } from 'vue';
import axios from 'axios';

const $router = inject('$router');
const $web3 = inject('$web3');
const $userPQ = inject('$userPQ');
const $socket = inject('$socket');
const $loader = inject('$loader');
const $swal = inject('$swal');
const $breakpoint = inject('$breakpoint');

const dataDefault = {
	query: { sort: 'desc', page: 1, limit: 5, s: '' },
	items: [],
	totalPages: 0,
	totalResults: 0,
	fetching: false,
	fetched: false,
	searched: false,
};

const data = ref(JSON.parse(JSON.stringify(dataDefault)));

onMounted(async () => {
	if (!$socket.connected && $userPQ.isOnline) await $socket.connect();
	$socket.on('BACKUP_UPDATE', backupUpdateListener);
	$socket.on('DISPATCH', dispatchListener);
	data.value = JSON.parse(JSON.stringify(dataDefault));
	getList();
});

onUnmounted(async () => {
	$socket.off('BACKUP_UPDATE', backupUpdateListener);
	$socket.off('DISPATCH', dispatchListener);
	if ($socket.connected) $socket.disconnect();
});

const backupUpdateListener = async (backupUpdateData) => {
	try {
		const idx = data.value.items.findIndex((b) => b.tag === backupUpdateData.backup.tag);
		if (idx > -1) {
			data.value.items[idx] = backupUpdateData.backup;

			if (backupUpdateData.action === 'updateBackupDisabled') {
				$swal.fire({
					icon: 'success',
					title: 'Backup updated',
					timer: 5000,
				});
			}
			if (backupUpdateData.action === 'updateShareDelay') {
				$swal.fire({
					icon: 'success',
					title: 'Delay updated',
					timer: 5000,
				});
			}
			if (backupUpdateData.action === 'updateShareDisabled') {
				$swal.fire({
					icon: 'success',
					title: 'Share updated',
					timer: 5000,
				});
			}
		}
	} catch (error) {
		console.error(error);
	}
};

const dispatchListener = async (tx) => {
	const idx = data.value.items.findIndex((i) => i.tag === tx.methodData.tag);
	if (idx > -1 && tx.status === 'PROCESSING') {
		data.value.items[idx].processingTx = tx;
		data.value.items[idx].fetchTimestamp++;
	}
};

watch(
	() => $userPQ.isAuthenticated,
	async (newVal) => {
		if (newVal) {
			getList();
		}
	},
);

const resetSearch = async () => {
	data.value.query.s = null;
	data.value.fetched = false;
	data.value.items = [];
	data.value.totalPages = 0;
	data.value.totalResults = 0;
	getList();
};

const search = async () => {
	if (!data.value.query.s) return;
	getList();
};

function setPage(page) {
	data.value.query.page = page;
	getList();
}

async function getList() {
	if (!$userPQ.isAuthenticated) return;
	$loader.show();
	data.value.fetching = true;
	try {
		const evmSkey = await $userPQ.getEvmPrivateKey();
		if (!evmSkey) throw new Error('No EVM key');
		const wallet = new $web3.ethers.Wallet(evmSkey);

		const res = (
			await axios.get(API_URL + '/backup/getList', {
				params: {
					...data.value.query,
					wallet: wallet.address,
					chainId: $web3.mainChainId,
				},
			})
		).data;
		data.value.items = res.results;
		data.value.totalPages = res.totalPages;
		data.value.totalResults = res.totalResults;
	} catch (error) {
		console.error(error);
	}
	$loader.hide();
	data.value.fetched = true;
	data.value.fetching = false;
	if (data.value.query.s) data.value.searched = true;
}
</script>