// Contact and user lists render names through v-html with the search term
// highlighted; a name or a search is text a person typed.
import { describe, it, expect } from 'vitest';
import highlightText from '@/utils/highlightText';

describe('highlightText', () => {
	it('escapes the text, with or without a search', () => {
		const name = '<img src=x onerror=alert(1)>';
		expect(highlightText(name, '')).toBe('&lt;img src=x onerror=alert(1)&gt;');
		expect(highlightText(name, 'img')).toBe('&lt;<span class="_highlight_search_text">img</span> src=x onerror=alert(1)&gt;');
	});

	it('matches the term literally and case-insensitively, keeping the text’s case', () => {
		expect(highlightText('Ann (work)', '(w')).toBe('Ann <span class="_highlight_search_text">(w</span>ork)');
		expect(highlightText('a.b', '.')).toBe('a<span class="_highlight_search_text">.</span>b');
		expect(highlightText('Bob bob', 'bob')).toBe('<span class="_highlight_search_text">Bob</span> <span class="_highlight_search_text">bob</span>');
		expect(() => highlightText('x', '[')).not.toThrow();
	});

	it('does not match inside the escapes it adds', () => {
		expect(highlightText('a&b', 'amp')).toBe('a&amp;b');
	});

	it('leaves an empty text as it is', () => {
		expect(highlightText(undefined, 'a')).toBeUndefined();
		expect(highlightText('', 'a')).toBe('');
	});
});
