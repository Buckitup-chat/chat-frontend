// Byte counts as the app shows them.
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** Decimals to show for `value` in `UNITS[unit]`. */
type Decimals = (value: number, unit: number) => number;

/** Storage figures: "512 B", "120 MB", "1.5 GB"; one decimal below 10. */
export const formatBytes = (bytes: number, decimals: Decimals = (v, u) => (u && v < 10 ? 1 : 0)): string => {
	// The unit moves on by the figure shown: 1023.99 KB would print "1024 KB".
	const shown = (v: number, u: number): string => v.toFixed(decimals(v, u));
	let value = bytes;
	let unit = 0;
	while (Number(shown(value, unit)) >= 1024 && unit < UNITS.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${shown(value, unit)} ${UNITS[unit]}`;
};

/** An attachment's size as the chat shows it (design board §1.5): "512 B", "2 KB", "61.7 MB". */
export const fileSize = (bytes: number): string => formatBytes(bytes, (_v, u) => (u >= 2 ? 1 : 0));
