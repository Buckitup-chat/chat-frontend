// The PQ2 handshake sandbox: its own page, build and tests, outside the app's
// (the root configs cover src/ and tests/ only). It imports the app's crypto
// layer (src/lib/pq) through the same `@` alias.
//
//   npx vite --config sandbox/handshake-pq2/vite.config.ts            # dev server
//   npx vite build --config sandbox/handshake-pq2/vite.config.ts      # → sandbox/handshake-pq2/dist
//   npx vitest run --config sandbox/handshake-pq2/vite.config.ts      # tests
//
// PQ2_CERT and PQ2_KEY (PEM files) serve the dev server over HTTPS: a phone
// on the network gets the camera and WebCrypto only in a secure context.
import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

const { PQ2_CERT, PQ2_KEY } = process.env;

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
		https: PQ2_CERT && PQ2_KEY ? { cert: readFileSync(PQ2_CERT), key: readFileSync(PQ2_KEY) } : undefined,
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
