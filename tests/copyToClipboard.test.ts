// @vitest-environment jsdom
// Copying text: a clipboard that refuses the write is reported to the person,
// not thrown out of the click handler.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fire = vi.hoisted(() => vi.fn());
vi.mock('@/libs/swal', () => ({ default: { fire } }));

const { default: copyToClipboard } = await import('@/utils/copyToClipboard');

const clipboard = (writeText: (text: string) => Promise<void>) =>
	Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

beforeEach(() => {
	fire.mockReset();
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('copyToClipboard', () => {
	it('copies and says so', async () => {
		const writeText = vi.fn(async () => {});
		clipboard(writeText);
		await expect(copyToClipboard('hello')).resolves.toBe(true);
		expect(writeText).toHaveBeenCalledWith('hello');
		expect(fire).toHaveBeenCalledWith(expect.objectContaining({ icon: 'success' }));
	});

	it('reports a refused write instead of throwing', async () => {
		clipboard(async () => {
			throw new DOMException('Document is not focused.', 'NotAllowedError');
		});
		await expect(copyToClipboard('hello')).resolves.toBeUndefined();
		expect(fire).toHaveBeenCalledWith(expect.objectContaining({ icon: 'error' }));
	});
});
