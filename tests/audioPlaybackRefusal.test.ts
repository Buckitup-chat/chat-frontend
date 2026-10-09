// Audio of a file part goes through the same verified download as every other
// file, and its state is the sender's file's alone: the same file_id from
// another sender is another file (fileKey.ts).
import { describe, it, expect } from 'vitest';
import { effectScope, ref } from 'vue';
import { useAudioPlayback } from '@/composables/useAudioPlayback';
import { FileVerificationError } from '@/lib/data/fileIntegrity';
import { fileKey } from '@/lib/data/fileKey';

const part = (uploaderHash: string) => ({ kind: 'file', fileId: 'f_' + 'a'.repeat(32), uploaderHash, name: 'song.mp3', mimeType: 'audio/mpeg' });

describe('audio of a file part', () => {
	it('keeps the state of each sender file apart, for the same file_id', async () => {
		globalThis.URL.createObjectURL ??= () => 'blob:x';
		const mine = part('u_' + 'b'.repeat(128));
		const theirs = part('u_' + 'c'.repeat(128));
		const audio = effectScope().run(() => useAudioPlayback(async (p) => {
			if ((p as { uploaderHash: string }).uploaderHash === theirs.uploaderHash) throw new FileVerificationError(p.fileId, 'invalid', 'not the sender');
			return new Uint8Array([1, 2, 3]);
		}, ref(0)))!;
		await audio.load(mine);
		await audio.load(theirs);
		expect(audio.audios.value[fileKey(mine)]).toMatchObject({ status: 'ready' });
		expect(audio.audios.value[fileKey(theirs)]).toMatchObject({ status: 'error' });
	});
});
