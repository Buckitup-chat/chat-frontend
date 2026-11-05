// Dates as the screens write them: "12 Oct", with the year only when it is
// not this one. Months are spelled here: toLocaleDateString writes "Sept" in
// some browsers.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

/** "12 Oct", or "12 Oct 2025" in another year; `sec` in Unix seconds. */
export const shortDay = (sec: number, now: Date = new Date()): string => {
	const d = new Date(sec * 1000);
	const year = d.getFullYear() === now.getFullYear() ? '' : ` ${d.getFullYear()}`;
	return `${d.getDate()} ${MONTHS[d.getMonth()]}${year}`;
};

/** "12 Oct, 18:04". */
export const shortDayTime = (sec: number, now: Date = new Date()): string => {
	const d = new Date(sec * 1000);
	return `${shortDay(sec, now)}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
