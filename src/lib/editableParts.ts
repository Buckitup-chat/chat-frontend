import type { ContentPart } from '@buckitup/pq-client/content';

const KEPT_ON_EDIT = new Set<ContentPart['kind']>(['text', 'quote', 'file', 'image', 'video']);

export const canEditText = (parts: readonly ContentPart[]): boolean =>
	parts.every((part) => KEPT_ON_EDIT.has(part.kind)) && parts.filter((part) => part.kind === 'text').length <= 1;

export const withEditedText = (parts: readonly ContentPart[], text: string): ContentPart[] => {
	if (!canEditText(parts)) throw new Error('This message cannot be edited: an edit would not keep all of its parts.');
	const edited: ContentPart = { kind: 'text', text };
	return parts.some((part) => part.kind === 'text')
		? parts.map((part) => (part.kind === 'text' ? edited : part))
		: [...parts, edited];
};
