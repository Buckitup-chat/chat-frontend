export const makeKey = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

// Named so no literal emoji characters need to appear in test code, comments, or test names.
export const THUMBS_UP = '\u{1F44D}';
export const THUMBS_DOWN = '\u{1F44E}';
export const THUMBS_UP_WITH_SKIN_TONE = '\u{1F44D}\u{1F3FD}';
export const FAMILY_SEQUENCE = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}';
