// The page the Chromium check (check.mjs) drives: the app's handshake engine,
// its QWBP channel and protocol module on a test identity, with no camera, no
// account and no server. Built in the 'handshake-check' mode, the only one in
// which the channel honours its relay-only test switch (qwbpChannel.ts).
//
//   npx vite build --config scripts/handshake-check/vite.config.ts --mode handshake-check
import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
	root: fileURLToPath(new URL('.', import.meta.url)),
	base: './',
	resolve: {
		alias: { '@': fileURLToPath(new URL('../../src', import.meta.url)) },
	},
	define: {
		// The harness talks to no backend.
		ELECTRIC_API_URL: JSON.stringify('/no-backend'),
	},
	build: {
		outDir: 'dist',
		emptyOutDir: true,
		target: 'es2022',
	},
});
