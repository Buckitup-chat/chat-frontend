import { describe, it, expect } from 'vitest';
import { isRemoteConfirmation } from '@/utils/db/tanstack/userQueue';

describe('isRemoteConfirmation — user_cards', () => {
	const sent = {
		user_hash: 'u_alice',
		sign_pkey: 'sign-pkey-b64',
		contact_pkey: 'contact-pkey-b64',
		contact_cert: 'contact-cert-b64',
		crypt_pkey: 'crypt-pkey-b64',
		crypt_cert: 'crypt-cert-b64',
		name: 'Alice',
		deleted_flag: false,
		owner_timestamp: 1700000000,
		sign_b64: 'signature-b64',
	};

	it('confirms when Electric record matches every field actually sent', () => {
		const remote = { ...sent };
		expect(isRemoteConfirmation('user_cards', sent, remote)).toBe(true);
	});

	it('does not confirm against a stale remote record missing the new name', () => {
		const remote = { ...sent, name: 'OldName' };
		expect(isRemoteConfirmation('user_cards', sent, remote)).toBe(false);
	});

	it('does not confirm when signature differs (wrong/old mutation)', () => {
		const remote = { ...sent, sign_b64: 'different-signature' };
		expect(isRemoteConfirmation('user_cards', sent, remote)).toBe(false);
	});

	it('is not fooled by extra server/Electric-only fields on the remote record', () => {
		const remote = { ...sent, created_at: '2024-01-01', updated_at: '2024-01-02', modified_columns: null };
		expect(isRemoteConfirmation('user_cards', sent, remote)).toBe(true);
	});

	it('returns false when there is no remote record yet', () => {
		expect(isRemoteConfirmation('user_cards', sent, undefined)).toBe(false);
	});

	it('returns false when nothing has been sent yet', () => {
		expect(isRemoteConfirmation('user_cards', null, { ...sent })).toBe(false);
	});

	it('treats null and undefined as equivalent for a field (nullable columns)', () => {
		const remote = { ...sent, owner_timestamp: null };
		const sentWithUndefined = { ...sent, owner_timestamp: undefined };
		expect(isRemoteConfirmation('user_cards', sentWithUndefined, remote)).toBe(true);
	});

	it('confirms owner_timestamp as a Number against the same value as a BigInt', () => {
		const remote = { ...sent, owner_timestamp: 1700000000n };
		expect(isRemoteConfirmation('user_cards', sent, remote)).toBe(true);
	});

	it('still rejects a genuinely different owner_timestamp even as a BigInt', () => {
		const remote = { ...sent, owner_timestamp: 1700000001n };
		expect(isRemoteConfirmation('user_cards', sent, remote)).toBe(false);
	});

	it('does not weaken comparison of actual content fields (name) via the same normalization path', () => {
		const remote = { ...sent, name: 'NotAlice' };
		expect(isRemoteConfirmation('user_cards', sent, remote)).toBe(false);
	});
});

describe('isRemoteConfirmation — user_cards binary fields (base64 vs Postgres bytea \\xHEX)', () => {
	const bytesFor = (field: string) => `${field}-bytes-000`;
	const base64For = (field: string) => Buffer.from(bytesFor(field)).toString('base64');
	const byteaFor = (field: string) => '\\x' + Buffer.from(bytesFor(field)).toString('hex');
	const flipLastHexDigit = (hex: string) => hex.slice(0, -1) + (hex.slice(-1) === '0' ? '1' : '0');

	const BINARY_FIELDS = ['sign_pkey', 'contact_pkey', 'contact_cert', 'crypt_pkey', 'crypt_cert', 'sign_b64'];

	const sentBase64 = {
		user_hash: 'u_alice',
		name: 'Alice',
		deleted_flag: false,
		owner_timestamp: 1700000000,
		...Object.fromEntries(BINARY_FIELDS.map((f) => [f, base64For(f)])),
	};

	const remoteBytea = {
		...sentBase64,
		...Object.fromEntries(BINARY_FIELDS.map((f) => [f, byteaFor(f)])),
	};

	it('A: confirms when every binary field is the same bytes, sent as base64 vs Electric as \\xHEX', () => {
		expect(isRemoteConfirmation('user_cards', sentBase64, remoteBytea)).toBe(true);
	});

	it('E: every known user_cards binary field individually confirms base64 <-> \\xHEX for identical bytes', () => {
		for (const field of BINARY_FIELDS) {
			const remote = { ...sentBase64, [field]: byteaFor(field) };
			expect(isRemoteConfirmation('user_cards', sentBase64, remote)).toBe(true);
		}
	});

	it('B: rejects when the bytea side differs by a single byte, despite matching base64 text elsewhere', () => {
		const oneByteOff = '\\x' + flipLastHexDigit(Buffer.from(bytesFor('sign_pkey')).toString('hex'));
		const remote = { ...remoteBytea, sign_pkey: oneByteOff };
		expect(isRemoteConfirmation('user_cards', sentBase64, remote)).toBe(false);
	});

	it('C: does not confirm when a content/text field (name) differs, even with all binary fields matching', () => {
		const remote = { ...remoteBytea, name: 'NotAlice' };
		expect(isRemoteConfirmation('user_cards', sentBase64, remote)).toBe(false);
	});

	it('D: Number vs BigInt owner_timestamp still confirms alongside base64 <-> \\xHEX binary fields', () => {
		const remote = { ...remoteBytea, owner_timestamp: 1700000000n };
		expect(isRemoteConfirmation('user_cards', sentBase64, remote)).toBe(true);
	});

	it('rejects a genuinely different owner_timestamp even as a BigInt, alongside matching binary fields', () => {
		const remote = { ...remoteBytea, owner_timestamp: 1700000001n };
		expect(isRemoteConfirmation('user_cards', sentBase64, remote)).toBe(false);
	});

	it('also confirms both sides given as base64url without padding for the same bytes', () => {
		const urlSafe = Buffer.from(bytesFor('crypt_pkey')).toString('base64url');
		const remote = { ...sentBase64, crypt_pkey: urlSafe };
		expect(isRemoteConfirmation('user_cards', sentBase64, remote)).toBe(true);
	});

	it('never reinterprets `name` as binary even when two different-looking values decode to the same bytes', () => {
		const sent = { ...sentBase64, name: 'QQ==' };
		const remote = { ...remoteBytea, name: 'QQ' };
		expect(isRemoteConfirmation('user_cards', sent, remote)).toBe(false);
	});
});

describe('isRemoteConfirmation — user_storage', () => {
	const sent = {
		user_hash: 'u_alice',
		uuid: 'profile',
		value_b64: 'ciphertext-b64-v1',
		hash_b64: 'hash-v1',
		deleted_flag: false,
		owner_timestamp: 1700000000,
		parent_sign_hash: null,
		sign_hash: null,
		sign_b64: 'sig-v1',
	};

	it('confirms when Electric content matches the sent snapshot', () => {
		expect(isRemoteConfirmation('user_storage', sent, { ...sent })).toBe(true);
	});

	it('does not confirm against an older ciphertext (stale version never sent as `version`)', () => {
		const staleRemote = { ...sent, value_b64: 'ciphertext-b64-OLD', hash_b64: 'hash-OLD', sign_b64: 'sig-OLD' };
		expect(isRemoteConfirmation('user_storage', sent, staleRemote)).toBe(false);
	});

	it('is unaffected by a `version` field on either side (never part of the wire payload)', () => {
		const remoteWithVersion = { ...sent, version: 999 };
		const sentWithVersion = { ...sent, version: 1 };
		expect(isRemoteConfirmation('user_storage', sentWithVersion, remoteWithVersion)).toBe(true);
	});

	it('confirms a delete (deleted_flag true) only once Electric reflects it', () => {
		const sentDelete = { ...sent, value_b64: null, deleted_flag: true };
		expect(isRemoteConfirmation('user_storage', sentDelete, { ...sent, deleted_flag: false })).toBe(false);
		expect(isRemoteConfirmation('user_storage', sentDelete, { ...sentDelete })).toBe(true);
	});

	it('confirms value_b64/sign_b64 when Electric echoes them as Postgres bytea \\xHEX', () => {
		const valueBytes = Buffer.from('ciphertext-payload-000');
		const sigBytes = Buffer.from('signature-payload-000');
		const sentBase64 = {
			...sent,
			value_b64: valueBytes.toString('base64'),
			sign_b64: sigBytes.toString('base64'),
		};
		const remoteBytea = {
			...sent,
			value_b64: '\\x' + valueBytes.toString('hex'),
			sign_b64: '\\x' + sigBytes.toString('hex'),
		};
		expect(isRemoteConfirmation('user_storage', sentBase64, remoteBytea)).toBe(true);
	});

	it('rejects value_b64 as bytea when a single byte actually differs', () => {
		const valueBytes = Buffer.from('ciphertext-payload-000');
		const sentBase64 = { ...sent, value_b64: valueBytes.toString('base64') };
		const hex = valueBytes.toString('hex');
		const oneByteOff = '\\x' + hex.slice(0, -1) + (hex.slice(-1) === '0' ? '1' : '0');
		const remote = { ...sent, value_b64: oneByteOff };
		expect(isRemoteConfirmation('user_storage', sentBase64, remote)).toBe(false);
	});

	it('does NOT canonicalize parent_sign_hash/sign_hash as binary (they are hex-digest TEXT, not bytea)', () => {
		const sentWithHexHash = { ...sent, sign_hash: 'uss_deadbeef' };
		const remoteWithByteaLookingHash = { ...sent, sign_hash: '\\xdeadbeef' };
		expect(isRemoteConfirmation('user_storage', sentWithHexHash, remoteWithByteaLookingHash)).toBe(false);
	});

	describe('hash_b64 exclusion (confirmed bug fix)', () => {
		it('A: confirms even when the authoritative row has no hash_b64 at all, given every other field matches', () => {
			const remoteWithoutHashB64: { user_hash: string; hash_b64?: string | null } & Record<string, unknown> = { ...sent };
			delete remoteWithoutHashB64.hash_b64;
			expect('hash_b64' in remoteWithoutHashB64).toBe(false);
			expect(isRemoteConfirmation('user_storage', sent, remoteWithoutHashB64)).toBe(true);
		});

		it('a differing hash_b64 alone (present on both sides, but different) no longer blocks confirmation', () => {
			const remote = { ...sent, hash_b64: 'a-completely-different-hash' };
			expect(isRemoteConfirmation('user_storage', sent, remote)).toBe(true);
		});

		it('B: value_b64 bytes still matter — a one-byte mismatch still rejects confirmation', () => {
			const valueBytes = Buffer.from('ciphertext-payload-000');
			const sentBase64 = { ...sent, value_b64: valueBytes.toString('base64') };
			const hex = valueBytes.toString('hex');
			const oneByteOff = hex.slice(0, -1) + (hex.slice(-1) === '0' ? '1' : '0');
			const remote = { ...sent, value_b64: '\\x' + oneByteOff };
			expect(isRemoteConfirmation('user_storage', sentBase64, remote)).toBe(false);
		});

		it('C: sign_b64 bytes still matter — a one-byte mismatch still rejects confirmation', () => {
			const sigBytes = Buffer.from('signature-payload-000');
			const sentBase64 = { ...sent, sign_b64: sigBytes.toString('base64') };
			const hex = sigBytes.toString('hex');
			const oneByteOff = hex.slice(0, -1) + (hex.slice(-1) === '0' ? '1' : '0');
			const remote = { ...sent, sign_b64: '\\x' + oneByteOff };
			expect(isRemoteConfirmation('user_storage', sentBase64, remote)).toBe(false);
		});

		it('D: a different sign_hash still rejects confirmation', () => {
			const remote = { ...sent, sign_hash: 'uss_' + 'a'.repeat(128) };
			const sentWithHash = { ...sent, sign_hash: 'uss_' + 'b'.repeat(128) };
			expect(isRemoteConfirmation('user_storage', sentWithHash, remote)).toBe(false);
		});

		it('E: a different uuid still rejects confirmation', () => {
			const remote = { ...sent, uuid: 'a-different-uuid' };
			expect(isRemoteConfirmation('user_storage', sent, remote)).toBe(false);
		});

		it('F: owner_timestamp Number/BigInt normalization still holds', () => {
			const sameNumeric = { ...sent, owner_timestamp: 1700000000n };
			expect(isRemoteConfirmation('user_storage', sent, sameNumeric)).toBe(true);

			const different = { ...sent, owner_timestamp: 1700000001n };
			expect(isRemoteConfirmation('user_storage', sent, different)).toBe(false);
		});
	});

	describe('parent_sign_hash exclusion (confirmed bug fix)', () => {
		it('1: confirms when sent parent_sign_hash is null but the authoritative row has a backend-assigned non-null value', () => {
			const remote = { ...sent, parent_sign_hash: 'server-assigned-parent-hash' };
			expect(isRemoteConfirmation('user_storage', sent, remote)).toBe(true);
		});

		it('2: a genuinely different non-null parent_sign_hash on both sides still does not block confirmation', () => {
			const sentWithParent = { ...sent, parent_sign_hash: 'local-guess' };
			const remote = { ...sent, parent_sign_hash: 'server-assigned-different-value' };
			expect(isRemoteConfirmation('user_storage', sentWithParent, remote)).toBe(true);
		});

		it('3: a different sign_hash still rejects confirmation, regardless of parent_sign_hash', () => {
			const remote = { ...sent, parent_sign_hash: 'server-value', sign_hash: 'uss_' + 'a'.repeat(128) };
			const sentWithHash = { ...sent, sign_hash: 'uss_' + 'b'.repeat(128) };
			expect(isRemoteConfirmation('user_storage', sentWithHash, remote)).toBe(false);
		});

		it('4: a different uuid still rejects confirmation, regardless of parent_sign_hash', () => {
			const remote = { ...sent, parent_sign_hash: 'server-value', uuid: 'a-different-uuid' };
			expect(isRemoteConfirmation('user_storage', sent, remote)).toBe(false);
		});

		it('5: value_b64 bytes still matter alongside a backend-assigned parent_sign_hash', () => {
			const valueBytes = Buffer.from('ciphertext-payload-000');
			const sentBase64 = { ...sent, value_b64: valueBytes.toString('base64') };
			const hex = valueBytes.toString('hex');
			const oneByteOff = hex.slice(0, -1) + (hex.slice(-1) === '0' ? '1' : '0');
			const remote = { ...sent, parent_sign_hash: 'server-value', value_b64: '\\x' + oneByteOff };
			expect(isRemoteConfirmation('user_storage', sentBase64, remote)).toBe(false);
		});

		it('6: sign_b64 bytes still matter alongside a backend-assigned parent_sign_hash', () => {
			const sigBytes = Buffer.from('signature-payload-000');
			const sentBase64 = { ...sent, sign_b64: sigBytes.toString('base64') };
			const hex = sigBytes.toString('hex');
			const oneByteOff = hex.slice(0, -1) + (hex.slice(-1) === '0' ? '1' : '0');
			const remote = { ...sent, parent_sign_hash: 'server-value', sign_b64: '\\x' + oneByteOff };
			expect(isRemoteConfirmation('user_storage', sentBase64, remote)).toBe(false);
		});

		it('7: owner_timestamp Number/BigInt normalization still holds alongside a backend-assigned parent_sign_hash', () => {
			const sameNumeric = { ...sent, parent_sign_hash: 'server-value', owner_timestamp: 1700000000n };
			expect(isRemoteConfirmation('user_storage', sent, sameNumeric)).toBe(true);
		});

		it('8: a genuinely different owner_timestamp still rejects confirmation alongside a backend-assigned parent_sign_hash', () => {
			const different = { ...sent, parent_sign_hash: 'server-value', owner_timestamp: 1700000001n };
			expect(isRemoteConfirmation('user_storage', sent, different)).toBe(false);
		});

		it("9: USER_CARD_CONFIRM_FIELDS is unaffected — an unrelated parent_sign_hash-shaped field on a user_cards record is ignored, not required", () => {
			const cardsSent = {
				user_hash: 'u_alice',
				sign_pkey: 'sign-pkey-b64',
				contact_pkey: 'contact-pkey-b64',
				contact_cert: 'contact-cert-b64',
				crypt_pkey: 'crypt-pkey-b64',
				crypt_cert: 'crypt-cert-b64',
				name: 'Alice',
				deleted_flag: false,
				owner_timestamp: 1700000000,
				sign_b64: 'signature-b64',
			};
			const cardsRemote = { ...cardsSent, parent_sign_hash: 'irrelevant-for-user-cards' };
			expect(isRemoteConfirmation('user_cards', cardsSent, cardsRemote)).toBe(true);
		});
	});
});
