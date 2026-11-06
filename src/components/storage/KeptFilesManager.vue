<template>
	<section class="_kept" data-test="kept-files">
		<div class="fw-bold mb-2">Files kept on this device</div>
		<p class="small text-secondary" data-test="kept-guarantee">
			Kept files open offline and stay when the sender deletes them; the app's cache cleanup never removes them.
			Clearing this site's data removes them, and the browser may remove them when storage is low.
		</p>

		<div class="_totals small mb-3">
			<div data-test="kept-bytes"><span class="text-secondary">Kept files</span> {{ formatBytes(keptBytes) }}</div>
			<div data-test="cache-bytes">
				<span class="text-secondary">Cache</span> {{ formatBytes(cacheBytes) }}
				<button type="button" class="btn btn-link btn-sm p-0 ms-2" data-test="clear-cache" :disabled="busy" @click="clearCache">Clear cache</button>
			</div>
			<div data-test="storage-quota">
				<span class="text-secondary">This site uses</span>
				<template v-if="estimate.usage !== null && estimate.quota">{{ formatBytes(estimate.usage) }} of {{ formatBytes(estimate.quota) }}</template>
				<template v-else>an amount the browser does not report</template>
			</div>
		</div>

		<template v-if="files.length">
			<div class="_filters mb-2">
				<input v-model="filter.text" type="search" class="form-control form-control-sm" placeholder="Search by name" data-test="kept-search" />
				<select v-model="filter.chat" class="form-select form-select-sm" data-test="kept-chat">
					<option value="">All chats</option>
					<option v-for="chat in chats" :key="chat" :value="chat">{{ chatName(chat) }}</option>
				</select>
				<select v-model="filter.category" class="form-select form-select-sm" data-test="kept-type">
					<option value="">All types</option>
					<option v-for="(label, value) in CATEGORY_LABELS" :key="value" :value="value">{{ label }}</option>
				</select>
				<select v-model="filter.period" class="form-select form-select-sm" data-test="kept-period">
					<option value="">Any date</option>
					<option value="week">Last 7 days</option>
					<option value="month">Last 30 days</option>
					<option value="older">Older than 30 days</option>
				</select>
				<select v-model="filter.sort" class="form-select form-select-sm" data-test="kept-sort">
					<option value="newest">Newest first</option>
					<option value="oldest">Oldest first</option>
					<option value="largest">Largest first</option>
					<option value="smallest">Smallest first</option>
				</select>
			</div>

			<div class="d-flex flex-wrap gap-2 mb-2">
				<button type="button" class="btn btn-outline-danger btn-sm" data-test="kept-remove-selected" :disabled="busy || !selected.length" @click="removeSelected">
					Remove selected ({{ selected.length }})
				</button>
				<button v-if="filter.chat" type="button" class="btn btn-outline-danger btn-sm" data-test="kept-remove-chat" :disabled="busy" @click="removeChat">
					Remove all from {{ chatName(filter.chat) }}
				</button>
			</div>

			<div v-for="f in shown" :key="f.fileKey" class="_row" data-test="kept-row">
				<input v-model="selected" type="checkbox" class="form-check-input" :value="f.fileKey" data-test="kept-select" :aria-label="`Select ${f.name}`" />
				<div class="_info">
					<div class="kept-name text-break">{{ f.name }}</div>
					<div class="small text-secondary">
						<span class="kept-chat">{{ chatName(chatOf(f)) }}</span> ·
						<span class="kept-sender">{{ personName(f.uploaderHash) }}</span> ·
						<span class="kept-date">{{ dateOf(f) }}</span> ·
						<span class="kept-size">{{ formatBytes(f.size) }}</span> ·
						<span class="kept-type">{{ CATEGORY_LABELS[categoryOf(f)] }}</span>
					</div>
				</div>
				<div class="_actions">
					<button type="button" class="btn btn-outline-dark btn-sm" data-test="kept-open" :disabled="busy" @click="open(f)">Open</button>
					<button type="button" class="btn btn-outline-dark btn-sm" data-test="kept-save" :disabled="busy" @click="save(f)">Save</button>
					<button type="button" class="btn btn-outline-danger btn-sm" data-test="kept-remove" :disabled="busy" @click="removeOne(f)">Remove</button>
				</div>
			</div>
			<p v-if="!shown.length" class="small text-secondary">No kept file matches.</p>
		</template>
		<p v-else class="small text-secondary">No files are kept on this device.</p>

		<p v-if="failure" class="small text-danger" data-test="kept-error">{{ failure }}</p>

		<div v-if="preview" class="_preview" data-test="kept-preview">
			<img v-if="preview.category === 'image'" :src="preview.url" :alt="preview.name" />
			<video v-else-if="preview.category === 'video'" :src="preview.url" controls playsinline></video>
			<audio v-else :src="preview.url" controls></audio>
			<button type="button" class="btn btn-outline-dark btn-sm mt-2" @click="closePreview">Close</button>
		</div>
	</section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { userPQStore } from '@/store/userPQ.store';
import { useKeptFiles } from '@/composables/useKeptFiles';
import { openKeptFile, type KeptFile } from '@/lib/data/keptFiles';
import { categoryOf, chatOf, filterKeptFiles, keptChats, UNKNOWN_CHAT, type KeptCategory, type KeptFilter } from '@/lib/data/keptFilesView';
import { cachedBytes, clearChunkCache, pinnedBytesOf } from '@/lib/data/chunkCache';
import { formatBytes, storageEstimate } from '@/lib/storageStatus';
import { shortUserId } from '@/lib/shortUserId';

interface Person {
	user_hash?: string;
	name?: string;
}

const CATEGORY_LABELS: Record<KeptCategory, string> = { image: 'Image', video: 'Video', audio: 'Audio', file: 'File' };

const $userPQ = userPQStore() as unknown as {
	currentUserHash: string | null;
	contacts: Person[];
	getUserByHash: (hash: string) => Person | null | undefined;
};
const owner = () => $userPQ.currentUserHash;
const failure = ref('');
const { kept, release } = useKeptFiles({ owner, onError: (message) => { failure.value = message; } });

const filter = reactive<Required<Pick<KeptFilter, 'text' | 'chat' | 'sort'>> & Pick<KeptFilter, 'category' | 'period'>>({
	text: '', chat: '', category: '', period: '', sort: 'newest',
});
const selected = ref<string[]>([]);
const busy = ref(false);

const files = computed(() => Object.values(kept.value));
const shown = computed(() => filterKeptFiles(files.value, filter));
const chats = computed(() => keptChats(files.value));

const personName = (hash: string): string => {
	if (hash === owner()) return 'You';
	const person = $userPQ.contacts.find((c) => c.user_hash === hash) || $userPQ.getUserByHash(hash);
	return person?.name || shortUserId(hash);
};
const chatName = (chat: string): string => (chat === UNKNOWN_CHAT ? 'Unknown chat' : personName(chat));
const dateOf = (f: KeptFile): string => (f.createdAt ? new Date(f.createdAt * 1000).toLocaleDateString() : '');

const keptBytes = ref(0);
const cacheBytes = ref(0);
const estimate = ref<{ usage: number | null; quota: number | null }>({ usage: null, quota: null });

const refreshTotals = async () => {
	const who = owner();
	const [k, c, e] = await Promise.all([who ? pinnedBytesOf(who) : 0, cachedBytes(), storageEstimate()]);
	keptBytes.value = k;
	cacheBytes.value = c;
	estimate.value = e;
};

const withBusy = async (fn: () => Promise<void>) => {
	busy.value = true;
	failure.value = '';
	try {
		await fn();
	} catch (e) {
		failure.value = `Could not finish: ${(e as Error)?.message ?? e}`;
	} finally {
		busy.value = false;
	}
};

const removeKeys = async (keys: string[]) => {
	for (const key of keys) await release(key);
	selected.value = selected.value.filter((k) => !keys.includes(k));
	await refreshTotals();
};

const removeOne = (f: KeptFile) => withBusy(async () => {
	if (!window.confirm(`Remove "${f.name}" from this device?`)) return;
	await removeKeys([f.fileKey]);
});

const removeSelected = () => withBusy(async () => {
	if (!window.confirm(`Remove ${selected.value.length} files from this device?`)) return;
	await removeKeys([...selected.value]);
});

const removeChat = () => withBusy(async () => {
	const keys = files.value.filter((f) => chatOf(f) === filter.chat).map((f) => f.fileKey);
	if (!window.confirm(`Remove all ${keys.length} files kept from ${chatName(filter.chat)} from this device?`)) return;
	await removeKeys(keys);
});

const clearCache = () => withBusy(async () => {
	await clearChunkCache();
	await refreshTotals();
});

const blobUrlOf = async (f: KeptFile): Promise<string> => {
	const who = owner();
	const bytes = who ? await openKeptFile(who, f.fileKey) : null;
	if (!bytes) throw new Error('this file is no longer kept on this device');
	return URL.createObjectURL(new Blob([bytes as unknown as globalThis.BlobPart], { type: f.mimeType || 'application/octet-stream' }));
};

const preview = ref<{ url: string; name: string; category: KeptCategory } | null>(null);
const closePreview = () => {
	if (preview.value) URL.revokeObjectURL(preview.value.url);
	preview.value = null;
};

const open = (f: KeptFile) => withBusy(async () => {
	const url = await blobUrlOf(f);
	const category = categoryOf(f);
	if (category === 'file') {
		window.open(url, '_blank');
		setTimeout(() => URL.revokeObjectURL(url), 60_000);
		return;
	}
	closePreview();
	preview.value = { url, name: f.name, category };
});

const save = (f: KeptFile) => withBusy(async () => {
	const url = await blobUrlOf(f);
	const a = document.createElement('a');
	a.href = url;
	a.download = f.name || 'file';
	a.click();
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
});

onMounted(refreshTotals);
onBeforeUnmount(closePreview);
</script>

<style lang="scss" scoped>
._totals {
	display: flex;
	flex-direction: column;
	gap: 2px;
}

._filters {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 6px;

	input {
		grid-column: 1 / -1;
	}
}

._row {
	display: flex;
	align-items: flex-start;
	gap: 8px;
	padding: 8px 0;
	border-bottom: 1px solid var(--color-border, #e6e6ea);

	.form-check-input {
		margin-top: 4px;
		flex-shrink: 0;
	}
}

._info {
	flex: 1;
	min-width: 0;
}

._actions {
	display: flex;
	flex-wrap: wrap;
	justify-content: flex-end;
	gap: 4px;
}

._preview {
	margin-top: 12px;

	img,
	video,
	audio {
		display: block;
		width: 100%;
		max-height: 60vh;
		object-fit: contain;
	}
}
</style>
