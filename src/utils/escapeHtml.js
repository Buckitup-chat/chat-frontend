// For the few places that build markup from a string a person typed — a name
// from a backup file, a contact's display name — before handing it to v-html.
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export default (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
