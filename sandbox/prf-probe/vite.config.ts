// The WebAuthn PRF probe: a standalone page with its own build, outside the
// app's (the root configs cover src/ and tests/ only). It imports nothing from
// the app: plain DOM and WebAuthn.
//
//   npx vite --config sandbox/prf-probe/vite.config.ts            # dev server
//   npx vite build --config sandbox/prf-probe/vite.config.ts      # → sandbox/prf-probe/dist
//
// PRF_CERT and PRF_KEY (PEM files) serve the dev server over HTTPS: WebAuthn
// needs a secure context, and a phone on the network reaches the dev server
// by its address, not by localhost.
import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

const { PRF_CERT, PRF_KEY } = process.env;

export default defineConfig({
	root: fileURLToPath(new URL('.', import.meta.url)),
	// Relative, so the build runs from any path: /app/sandbox/prf-probe/ on the
	// app's host, or a local file server.
	base: './',
	server: {
		host: true,
		https: PRF_CERT && PRF_KEY ? { cert: readFileSync(PRF_CERT), key: readFileSync(PRF_KEY) } : undefined,
	},
	build: {
		outDir: 'dist',
		emptyOutDir: true,
		target: 'es2022',
	},
});
