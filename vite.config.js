import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import topLevelAwait from 'vite-plugin-top-level-await';

import WALC from '@lo-fi/webauthn-local-client/bundlers/vite';

import { viteCommonjs } from '@originjs/vite-plugin-commonjs'

import path from 'path';

import wasm from 'vite-plugin-wasm';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';

const DOMAIN = process.env.DOMAIN
const isLocalhost = DOMAIN?.startsWith('localhost')
const isProduction = !isLocalhost
const apiBase = isLocalhost ? `http://${DOMAIN}` : `https://${DOMAIN || 'buckitup.xyz'}`

// https://vite.dev/config/
export default defineConfig(({ command }) => {
	const isDev = command !== 'build'

	return {
		esbuild: {
			supported: {
				'top-level-await': true,
			},
		},
		worker: {
			format: 'es',
			plugins: () => [topLevelAwait(), wasm()],
		},
		plugins: [
			topLevelAwait(),
			wasm(),
			WALC(),
			nodePolyfills({
				// To add only specific polyfills, add them here. If no option is passed, adds all polyfills
				include: [
					'assert',
					'buffer',
					'crypto',
					'util',
					'vm',
					// 'stream',
					// 'stream-browserify'
				],
				globals: {
					Buffer: true,
					global: true,
					process: true,
				},
				protocolImports: true,
			}),
			viteCommonjs(
				{
					include: [
						'**/node_modules/@noble/hashes/**',
					]
				}
			),
			vue(),
			// Offline shell: src/sw.js precaches the build and hosts the
			// encrypted-video streamer (one worker per scope). Disabled in dev —
			// the stand runs on a self-signed cert where workers cannot
			// register, and the video path has a no-worker fallback anyway.
			VitePWA({
				strategies: 'injectManifest',
				srcDir: 'src',
				filename: 'sw.js',
				registerType: 'autoUpdate',
				injectRegister: false, // main.js registers explicitly
				injectManifest: {
					globPatterns: ['**/*.{js,css,html,svg,png,webp,woff,woff2,wasm}'],
					// the main bundle is far past workbox's 2 MiB default
					maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
				},
				manifest: {
					name: 'BuckitUp',
					short_name: 'BuckitUp',
					description: 'Privacy-first end-to-end encrypted messenger',
					// #241824 — the brand dark the icon set is built on (designer's
					// handoff): splash, status bar and icon background are one
					// paint, no seam at the icon edge.
					theme_color: '#241824',
					background_color: '#241824',
					display: 'standalone',
					icons: [
						{ src: 'img/pwa/pwa-192.png', sizes: '192x192', type: 'image/png' },
						{ src: 'img/pwa/pwa-512.png', sizes: '512x512', type: 'image/png' },
						{ src: 'img/pwa/pwa-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
						{ src: 'img/pwa/pwa-monochrome.png', sizes: '512x512', type: 'image/png', purpose: 'monochrome' },
					],
				},
			}),
		],
		define: {
			ELECTRIC_API_URL: JSON.stringify(
				isDev ? '/api'
				: `${apiBase}/electric/v1`
			),
			API_URL: JSON.stringify(apiBase),
			CONNECTOR_URL: JSON.stringify(isLocalhost ? 'ws://localhost:3953' : 'wss://buckitupss.appdev.pp.ua/connector'),
			IS_PRODUCTION: isProduction,
			IS_PRODUCTION_API: isProduction,
			API_SURL: JSON.stringify(isLocalhost ? `http://${DOMAIN}` : apiBase),
			API_SPATH: JSON.stringify('/api'),
			TM_BOT: JSON.stringify(isLocalhost ? 'BuckitUpLocalBot' : 'BuckitUpDemoBot'),
		},
		resolve: {
			alias: {
				'@': fileURLToPath(new URL('./src', import.meta.url)),
				bootstrap: path.resolve(__dirname, 'node_modules/bootstrap'), // ✅ Fix Sass Import
				'aes-js': path.resolve(__dirname, 'node_modules/ethers/node_modules/aes-js/lib.commonjs/index.js'),
				// '@noble/hashes/hmac': '@noble/hashes/hmac.js',
				// '@noble/hashes/sha256': '@noble/hashes/sha256.js',
				// '@noble/hashes/sha512': '@noble/hashes/sha512.js',
				// '@noble/hashes/utils': '@noble/hashes/utils.js',

				// 'stream/promises': require.resolve('./src/polyfills/stream-promises.js'),
			},
		},
		optimizeDeps: {
			esbuildOptions: {
				target: 'es2022',
				// plugins: [
				// 	esbuildCommonjs(['@noble/hashes'])
				// ]
			},
			exclude: [
				'@lo-fi/webauthn-local-client',
				// Ships its OPFS worker + wasm as relative-URL assets; Vite's
				// dep pre-bundling breaks those URLs ("OPFS worker terminated
				// unexpectedly"), so serve both packages unbundled.
				'@tanstack/browser-db-sqlite-persistence',
				'@journeyapps/wa-sqlite',
			],
			include: [
				'@noble/hashes',
				'@noble/hashes/sha3',
				'ethers',
			]
		},
		server: {
			proxy: {
				'/api': {
					target: isLocalhost
						? `http://${DOMAIN}/electric/v1`
						: `${apiBase}/electric/v1`,
					changeOrigin: true,
					rewrite: (path) => path.replace(/^\/api/, ''),
					secure: false,
				},
			},
		},
		base: DOMAIN ? '/app/' : '/',
		build: {
			//outDir: "../priv/static/frontend",
			emptyOutDir: true,
			// disable source maps & size reports to save memory
			sourcemap: false,
			reportCompressedSize: false,
			minify: 'esbuild',
			cssCodeSplit: false,
			rollupOptions: {
				onwarn(warning, warn) {
					if (warning.message.includes('PURE') || warning.message.includes('has been externalized')) return;
					warn(warning); // Let Rollup handle other warnings normally
				},
				maxParallelFileOps: 10
			},
		},
	}
});

