import escapeHtml from './escapeHtml';

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `text` as markup for v-html, with every case-insensitive occurrence of
 * `searchTerm` wrapped in a highlight span. Both are text a person typed — a
 * contact's name, a search — so the text is escaped and the term is matched
 * literally, never as markup or as a pattern.
 */
export default (text, searchTerm) => {
	if (!text) return text;
	if (!searchTerm) return escapeHtml(text);
	// split() with one capture group puts the matches at the odd indices.
	return String(text)
		.split(new RegExp(`(${escapeRegExp(searchTerm)})`, 'gi'))
		.map((part, i) => (i % 2 ? `<span class="_highlight_search_text">${escapeHtml(part)}</span>` : escapeHtml(part)))
		.join('');
};
