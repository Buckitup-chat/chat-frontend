import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
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
		environment: 'node',
		include: ['tests/**/*.test.{js,ts}'],
	},
});
