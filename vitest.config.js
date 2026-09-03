import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
	// Component tests mount real SFCs, so .vue files must compile here too.
	plugins: [vue()],
	resolve: {
		alias: {
			'@': fileURLToPath(new URL('./src', import.meta.url)),
		},
	},
	define: {
		// Build-time constants normally injected by vite.config.js
		ELECTRIC_API_URL: JSON.stringify('/api'),
	},
	test: {
		// Default stays node; component tests opt into jsdom with a
		// `@vitest-environment jsdom` docblock, so the fast unit tests keep
		// running without a DOM.
		environment: 'node',
		include: ['tests/**/*.test.{js,ts}'],
	},
});
