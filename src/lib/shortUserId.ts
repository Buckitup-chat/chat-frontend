/** The short form of a user_hash people read and compare: its first 12 hex digits in groups of 4, "7f3a·e2b1·c91e". */
export const shortUserId = (userHash: string | undefined | null): string => {
	const hex = (userHash ?? '').replace(/^u_/, '').slice(0, 12);
	return hex.match(/.{1,4}/g)?.join('·') ?? '';
};
