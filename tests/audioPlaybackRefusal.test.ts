// Audio of a file part goes through the same verified download as every other
// file; a refused one is reported as such and to the page's refusal record
// (docs/invariants.md §6a), and its state is the sender's file's alone.
import { describe, it, expect, vi } from 'vitest';
import { effectScope, ref } from 'vue';
import { useAudioPlayback } from '@/composables/useAudioPlayback';
import { FileVerificationError } from '@/lib/data/fileIntegrity';
import { fileKey } from '@/lib/data/fileKey';

const part = (uploaderHash: string) => ({ kind: 'file', fileId: 'f_' + 'a'.repeat(32), uploaderHash, name: 'song.mp3', mimeType: 'audio/mpeg' });

const run = (fetchFile: Parameters<typeof useAudioPlayback>[0], onRefused?: (p: unknown, e: unknown) => void) => {
	const scope = effectScope();
	return scope.run(() => useAudioPlayback(fetchFile, ref(0), { onRefused }))!;
};

describe('audio of a file part', () => {
	it('a refused file: says it could not be verified, and tells the page', async () => {
		const onRefused = vi.fn();
		const p = part('u_' + 'b'.repeat(128));
		const audio = run(async () => { throw new FileVerificationError(p.fileId, 'invalid', 'forged manifest'); }, onRefused);
		await audio.load(p);
		expect(audio.audios.value[fileKey(p)]).toEqual({ status: 'error', message: 'This file could not be verified.' });
		expect(onRefused).toHaveBeenCalledWith(p, expect.any(FileVerificationError));
	});

	it('a network failure is not a refusal', async () => {
		const onRefused = vi.fn();
		const p = part('u_' + 'b'.repeat(128));
		const audio = run(async () => { throw new Error('chunk 3 unavailable: HTTP 404'); }, onRefused);
		await audio.load(p);
		expect(audio.audios.value[fileKey(p)]).toMatchObject({ status: 'error', message: 'Part of this file has not arrived yet. Try again later.' });
		expect(onRefused).not.toHaveBeenCalled();
	});

	it('keeps the state of one sender\'s file apart from another\'s with the same file_id', async () => {
		globalThis.URL.createObjectURL ??= () => 'blob:x';
		const mine = part('u_' + 'b'.repeat(128));
		const theirs = part('u_' + 'c'.repeat(128));
		const audio = run(async (p) => {
			if ((p as { uploaderHash: string }).uploaderHash === theirs.uploaderHash) throw new FileVerificationError(p.fileId, 'invalid', 'not the sender\'s');
			return new Uint8Array([1, 2, 3]);
		});
		await audio.load(mine);
		await audio.load(theirs);
		expect(audio.audios.value[fileKey(mine)]).toMatchObject({ status: 'ready' });
		expect(audio.audios.value[fileKey(theirs)]).toMatchObject({ status: 'error' });
	});
});
