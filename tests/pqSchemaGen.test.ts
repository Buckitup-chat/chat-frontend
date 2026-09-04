// Guards the generated signable-field table against drift from the backend.
//
// Runs the real generator against a backend checkout (CHAT_REPO or ../chat)
// and asserts the committed schema.generated.ts is its exact output. Skipped
// when no checkout is present — frontend-only CI still pins the table through
// the conformance vectors; this test adds the backend comparison on machines
// that have both repos.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
// eslint-disable-next-line import/no-relative-packages
import { generateSchema, findChatRepo, OUTPUT_PATH } from '../scripts/gen-pq-schema.mjs';
import { SIGNABLE } from '@/lib/pq/schema';

const chatRepo = findChatRepo();

describe('schema.generated.ts', () => {
	it.skipIf(!chatRepo)('is exactly what the backend schemas generate', () => {
		expect(fs.readFileSync(OUTPUT_PATH, 'utf8')).toBe(generateSchema(chatRepo!));
	});

	it('covers every relation the client verifies', () => {
		expect(Object.keys(SIGNABLE)).toEqual([
			'user_cards',
			'user_storage',
			'dialog_keys',
			'dialog_messages',
			'dialog_messages_versions',
			'dialog_message_reactions',
			'dialog_message_receipts',
			'files',
		]);
	});

	it('archived revisions keep the dialog_messages field set', () => {
		expect(SIGNABLE.dialog_messages_versions).toEqual(SIGNABLE.dialog_messages);
	});
});
