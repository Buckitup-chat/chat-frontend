import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import topLevelAwait from 'vite-plugin-top-level-await';

import WALC from '@lo-fi/webauthn-local-client/bundlers/vite';

import { viteCommonjs } from '@originjs/vite-plugin-commonjs'

import path from 'path';

import wasm from 'vite-plugin-wasm';
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
						'**/node_modules/@spruceid/siwe-parser/**',
						'**/node_modules/siwe/**',
						'**/node_modules/@noble/hashes/**',
						'**/node_modules/@lit-protocol/**',
					]
				}
			),
			vue(),
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
			LIT_PKP_PUBLIC_KEY: JSON.stringify('0x040886717a89b4ca1f41c39006c85f27dad31ef1d53072bc63ba1b69e7cd70363b8e283077071af75f29c48375c98c77ae5e81995986edcd783b8fa3c45e2c1d1e'),
			IPFS_URL: JSON.stringify('https://fanaticodev.infura-ipfs.io/ipfs/'),
			INFURA_PR_ID: JSON.stringify('c683c07028924e35ae07d1b82ecbe342'),
			INFURA_SERCET: JSON.stringify('iWIYyzBCkJHfHxYlHYSKnulu3rkCP3stdSr6AX6BVsFxi4kZYPXN7Q'),
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
				'@electric-sql/pglite',
				'@electric-sql/pglite/worker',
			],
			include: [
				'@noble/hashes',
				'@noble/hashes/sha3',
				'@spruceid/siwe-parser',
				'siwe',
				'ethers',
				'@lit-protocol/auth-helpers',
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

