import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';
import { createRequire } from 'node:module';

const pqClientPackage = createRequire(import.meta.url)('@buckitup/pq-client/package.json');

export default defineConfig({
	// Component tests mount real SFCs, so .vue files must compile here too.
	plugins: [vue()],
	resolve: {
		alias: {
			'@': fileURLToPath(new URL('./src', import.meta.url)),
		},
		dedupe: Object.keys(pqClientPackage.dependencies),
	},
	define: {
		// Build-time constants normally injected by vite.config.js
		ELECTRIC_API_URL: JSON.stringify('/api'),
		HANDSHAKE_DEV_TURN: 'null',
	},
	test: {
		// Transform the installed ESM package so integration mocks of its dependencies apply.
		server: { deps: { inline: ['@buckitup/pq-client'] } },
		// Default stays node; component tests opt into jsdom with a
		// `@vitest-environment jsdom` docblock, so the fast unit tests keep
		// running without a DOM.
		environment: 'node',
		include: ['tests/**/*.test.{js,ts}'],
		testTimeout: 20_000,
	},
});
