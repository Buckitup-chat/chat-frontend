import { ref, watch, onScopeDispose, type WatchSource } from 'vue';
import { fileKey } from '@/lib/data/fileKey';

const AUDIO_TYPES: Record<string, string> = {
	mp3: 'audio/mpeg',
	m4a: 'audio/mp4',
	aac: 'audio/aac',
	ogg: 'audio/ogg',
	oga: 'audio/ogg',
	opus: 'audio/ogg',
	wav: 'audio/wav',
	weba: 'audio/webm',
	flac: 'audio/flac',
};
const PLAYABLE_MIME = new Set([...Object.values(AUDIO_TYPES), 'audio/mp3', 'audio/x-m4a', 'audio/x-wav', 'audio/webm', 'audio/opus']);

interface FileRef {
	kind?: string;
	fileId: string;
	uploaderHash?: string;
	name?: string;
	mimeType?: string;
}

export const playableAudioType = (part: FileRef | null | undefined): string | null => {
	if (!part || part.kind !== 'file') return null;
	const mime = (part.mimeType || '').toLowerCase().split(';')[0]?.trim() ?? '';
	if (PLAYABLE_MIME.has(mime)) return mime;
	if (mime && mime !== 'application/octet-stream') return null;
	const ext = (part.name || '').toLowerCase().split('.').pop() ?? '';
	return AUDIO_TYPES[ext] ?? null;
};

export type AudioState =
	| { status: 'loading'; done: number; total: number }
	| { status: 'ready'; url: string }
	| { status: 'error'; message: string };

type FetchFile = (part: FileRef, opts: { onProgress?: (p: { done: number; total: number }) => void; signal?: AbortSignal }) => Promise<Uint8Array>;

const failureMessage = (e: unknown): string => {
	const text = String((e as Error)?.message ?? e);
	if (/manifest not found/.test(text)) return 'This file is not available here yet.';
	if (/deleted/.test(text)) return 'This file was deleted by its sender.';
	if (/chunk \d+ unavailable/.test(text)) return 'Part of this file has not arrived yet. Try again later.';
	if ((e as Error)?.name === 'OperationError') return 'This file is damaged and cannot be played.';
	return 'This file could not be loaded.';
};

/** Audio of the dialog's file parts, by fileKey. */
export function useAudioPlayback(fetchFile: FetchFile, resetOn: WatchSource<unknown>) {
	const audios = ref<Record<string, AudioState>>({});
	let urls: string[] = [];
	let inFlight = new Map<string, AbortController>();

	const set = (fileId: string, state: AudioState) => {
		audios.value = { ...audios.value, [fileId]: state };
	};

	const release = () => {
		for (const controller of inFlight.values()) controller.abort();
		inFlight = new Map();
		for (const url of urls) URL.revokeObjectURL(url);
		urls = [];
		audios.value = {};
	};

	const load = async (part: FileRef) => {
		const type = playableAudioType(part);
		const id = fileKey(part);
		const current = audios.value[id];
		if (!type || inFlight.has(id) || current?.status === 'ready') return;

		const controller = new AbortController();
		const owned = inFlight;
		owned.set(id, controller);
		set(id, { status: 'loading', done: 0, total: 0 });
		try {
			const bytes = await fetchFile(part, {
				signal: controller.signal,
				onProgress: (p) => {
					if (!controller.signal.aborted) set(id, { status: 'loading', done: p.done, total: p.total });
				},
			});
			if (controller.signal.aborted) return;
			const url = URL.createObjectURL(new Blob([bytes as unknown as globalThis.BlobPart], { type }));
			urls.push(url);
			set(id, { status: 'ready', url });
		} catch (e) {
			if (controller.signal.aborted) return;
			console.error('Audio load failed:', e);
			set(id, { status: 'error', message: failureMessage(e) });
		} finally {
			owned.delete(id);
		}
	};

	watch(resetOn, release);
	onScopeDispose(release);

	return { audios, load, release };
}
