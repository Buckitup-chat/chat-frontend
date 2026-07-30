// @electric-sql/client >= 1.5 pauses shape streams while document.hidden
// (battery saver). Team decision (2026-07-21): a messenger must keep
// receiving messages in background tabs, so sync stays always active.
// Flip this adapter if the policy ever changes.
export const alwaysActiveVisibility = {
	getCurrentState: () => 'visible' as const,
	subscribe: () => () => {},
};
