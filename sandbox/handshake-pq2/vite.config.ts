// The PQ2 handshake sandbox: its own page, build and tests, outside the app's
// (the root configs cover src/ and tests/ only). It imports the app's crypto
// layer (src/lib/pq) through the same `@` alias.
//
//   npx vite --config sandbox/handshake-pq2/vite.config.ts            # dev server
//   npx vite build --config sandbox/handshake-pq2/vite.config.ts      # → sandbox/handshake-pq2/dist
//   npx vitest run --config sandbox/handshake-pq2/vite.config.ts      # tests
import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
	root: fileURLToPath(new URL('.', import.meta.url)),
	// Relative, so the build runs from any path: a static host, a CDN in front
	// of the repository, or a local file server.
	base: './',
	resolve: {
		alias: { '@': fileURLToPath(new URL('../../src', import.meta.url)) },
	},
	server: {
		host: true,
		fs: { allow: [fileURLToPath(new URL('../..', import.meta.url))] },
	},
	build: {
		outDir: 'dist',
		emptyOutDir: true,
		target: 'es2022',
	},
	test: {
		environment: 'node',
		include: ['tests/**/*.test.ts'],
		testTimeout: 20_000,
	},
});
