// The service worker and the installed app are scoped to the build base
// (vite.config.js `base`: '/app/' where the chat server hosts the build, '/'
// on a host of its own). A page outside that scope is neither served from
// the offline cache nor part of the installed app, so the app runs entirely
// under the base: the router is created with it, and an entry through any
// other path — the bare domain, or a link written without the base — moves
// inside before the router reads the location (src/enterBase.ts).

/** Where `pathname` belongs under `base`, or null when it is there already. */
export const insideBase = (pathname: string, base: string): string | null => {
	if (base === '/' || pathname.startsWith(base)) return null;
	if (`${pathname}/` === base) return base;
	return base + pathname.replace(/^\/+/, '');
};

/** Move the current page under the build base. Call before the router exists. */
export const enterBase = (): void => {
	if (typeof location === 'undefined' || typeof history === 'undefined') return;
	const target = insideBase(location.pathname, import.meta.env.BASE_URL);
	if (target) history.replaceState(history.state, '', target + location.search + location.hash);
};
