// `shamirs-secret-sharing` ships no types and has no @types package on npm;
// without this, vue-tsc fails on src/lib/testbed/sdk.ts (TS7016).
declare module 'shamirs-secret-sharing';
