// `shamirs-secret-sharing` ships no types and has no @types package on npm;
// without this, vue-tsc fails on src/lib/testbed/sdk.ts (TS7016).
declare module 'shamirs-secret-sharing';

// `var` is required here: only ambient `var` declarations attach to `globalThis`
// in TypeScript, and tests assign via `globalThis.ELECTRIC_API_URL = ...`.
// eslint-disable-next-line no-var
declare var ELECTRIC_API_URL: string;
