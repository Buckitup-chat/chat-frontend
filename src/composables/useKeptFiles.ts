// "Keep on this device" for the open chat: which files the account keeps, the
// switch's progress while a file is being kept, and what went wrong when it
// could not be. A failed keep leaves the switch off and says why — a full
// disk is not swallowed the way a cache write is.
import { computed, ref, watch } from 'vue';
import { fileKey } from '@/lib/data/fileKey';
import { keepFile, listKeptFiles, releaseKeptFile, type KeepablePart, type KeptFile, type KeptIndex } from '@/lib/data/keptFiles';
import { isDeletedFile } from '@/lib/data/fileTransfer';
import { isRefusedFile } from '@/lib/data/fileIntegrity';

export interface KeepProgress {
	done: number;
	total: number;
}

/** What the person is told when a file could not be kept. */
export const keepFailureMessage = (e: unknown): string => {
	const name = (e as Error)?.name;
	const text = String((e as Error)?.message ?? e);
	if (name === 'QuotaExceededError') return 'There is not enough storage on this device to keep this file.';
	if (isDeletedFile(e)) return 'The sender deleted this file from the server, so it can no longer be kept.';
	if (isRefusedFile(e)) return 'This file could not be verified, so it is not kept.';
	if (name === 'VaultLockedError' || name === 'AccountMismatchError') return 'Unlock the account to keep files on this device.';
	if (name === 'ChunkPinError') return text;
	if (/manifest not found/.test(text)) return 'This file has not reached this device yet.';
	if (/chunk \d+ unavailable/.test(text)) return 'Part of this file has not arrived yet. Try again later.';
	return `This file could not be kept on this device: ${text}`;
};

export function useKeptFiles(opts: {
	/** The account whose kept files these are; watched. */
	owner: () => string | null | undefined;
	/** Told once per failure, beside the message the switch shows. */
	onError?: (message: string, error: unknown) => void;
}) {
	const kept = ref<KeptIndex>({});
	const keeping = ref<Record<string, KeepProgress>>({});
	const errors = ref<Record<string, string>>({});

	const without = <T>(map: Record<string, T>, key: string): Record<string, T> => {
		const next = { ...map };
		delete next[key];
		return next;
	};

	const load = async () => {
		const owner = opts.owner();
		kept.value = {};
		keeping.value = {};
		errors.value = {};
		if (!owner) return;
		try {
			const index = await listKeptFiles(owner);
			if (opts.owner() === owner) kept.value = index;
		} catch (e) {
			console.warn('[keptFiles] the index could not be read', e);
		}
	};
	watch(opts.owner, load, { immediate: true });

	/** Kept files by the message that carried them: a deleted message still shows its kept copies. */
	const keptByMessage = computed(() => {
		const out: Record<string, KeptFile[]> = {};
		for (const f of Object.values(kept.value)) (out[f.messageId] ??= []).push(f);
		return out;
	});

	const fail = (key: string, e: unknown) => {
		const message = keepFailureMessage(e);
		errors.value = { ...errors.value, [key]: message };
		opts.onError?.(message, e);
	};

	const keep = async (part: KeepablePart, messageId: string): Promise<void> => {
		const owner = opts.owner();
		const key = fileKey(part);
		if (!owner || kept.value[key] || keeping.value[key]) return;
		errors.value = without(errors.value, key);
		keeping.value = { ...keeping.value, [key]: { done: 0, total: 0 } };
		try {
			const entry = await keepFile(owner, part, messageId, {
				onProgress: (p) => {
					if (keeping.value[key]) keeping.value = { ...keeping.value, [key]: { done: p.done, total: p.total } };
				},
			});
			if (opts.owner() === owner) kept.value = { ...kept.value, [key]: entry };
		} catch (e) {
			if (opts.owner() === owner) fail(key, e);
		} finally {
			keeping.value = without(keeping.value, key);
		}
	};

	const release = async (key: string): Promise<void> => {
		const owner = opts.owner();
		if (!owner || !kept.value[key]) return;
		errors.value = without(errors.value, key);
		try {
			await releaseKeptFile(owner, key);
			if (opts.owner() === owner) kept.value = without(kept.value, key);
		} catch (e) {
			if (opts.owner() === owner) fail(key, e);
		}
	};

	/** The switch: on keeps, off releases. */
	const setKept = (part: KeepablePart, messageId: string, on: boolean): Promise<void> =>
		on ? keep(part, messageId) : release(fileKey(part));

	return { kept, keptByMessage, keeping, errors, setKept };
}
