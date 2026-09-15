// Word-level diff for the edit history (board screen 06).
//
// The board highlights what changed INSIDE the text — "в 19:30, не в 19:00"
// with the changed words marked — instead of a separate compare mode. An LCS
// over words is enough at message size; anything smarter buys nothing a chat
// message can show.

export interface DiffPart {
	text: string;
	kind: 'same' | 'added' | 'removed';
}

const tokenize = (s: string): string[] => s.split(/(\s+)/).filter((t) => t.length > 0);

/**
 * Marks how `to` differs from `from`, word by word. Whitespace travels with
 * the change so highlights do not swallow the gaps around kept words.
 */
export const diffWords = (from: string, to: string): DiffPart[] => {
	const a = tokenize(from);
	const b = tokenize(to);

	// standard LCS table; messages are short, O(n·m) is nothing
	const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
		}
	}

	const parts: DiffPart[] = [];
	const push = (text: string, kind: DiffPart['kind']) => {
		const last = parts[parts.length - 1];
		if (last && last.kind === kind) last.text += text;
		else parts.push({ text, kind });
	};

	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			push(a[i], 'same');
			i++; j++;
		} else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
			push(a[i], 'removed');
			i++;
		} else {
			push(b[j], 'added');
			j++;
		}
	}
	while (i < a.length) push(a[i++], 'removed');
	while (j < b.length) push(b[j++], 'added');
	return parts;
};
