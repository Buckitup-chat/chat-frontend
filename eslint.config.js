import js from '@eslint/js';
import pluginVue from 'eslint-plugin-vue';
import tsParser from '@typescript-eslint/parser';
import globals from 'globals';

export default [
	{
		ignores: ['dist/**', 'node_modules/**', 'public/**'],
	},
	js.configs.recommended,
	...pluginVue.configs['flat/recommended'],
	{
		languageOptions: {
			ecmaVersion: 2023,
			sourceType: 'module',
			globals: {
				...globals.browser,
				// Injected by vite-plugin-node-polyfills (see vite.config.js)
				Buffer: 'readonly',
				process: 'readonly',
				// Build-time constants injected by Vite (see vite.config.js `define`)
				API_URL: 'readonly',
				API_SURL: 'readonly',
				API_SPATH: 'readonly',
				ELECTRIC_API_URL: 'readonly',
				CONNECTOR_URL: 'readonly',
				IS_PRODUCTION: 'readonly',
				IS_PRODUCTION_API: 'readonly',
				TM_BOT: 'readonly',
				LIT_PKP_PUBLIC_KEY: 'readonly',
				IPFS_URL: 'readonly',
				INFURA_PR_ID: 'readonly',
				INFURA_SERCET: 'readonly',
			},
		},
	},
	{
		files: ['**/*.vue'],
		languageOptions: {
			parserOptions: {
				// <script setup lang="ts"> support (e.g. UserList.vue)
				parser: { ts: tsParser },
			},
		},
	},
	{
		rules: {
			// Formatting is Prettier's job — keep ESLint focused on correctness.
			'vue/html-indent': 'off',
			'vue/max-attributes-per-line': 'off',
			'vue/singleline-html-element-content-newline': 'off',
			'vue/multiline-html-element-content-newline': 'off',
			'vue/html-self-closing': 'off',
			'vue/html-closing-bracket-newline': 'off',
			'vue/first-attribute-linebreak': 'off',
			'vue/attributes-order': 'off',

			// Relaxed for the existing codebase.
			'vue/multi-word-component-names': 'off',
			'vue/require-default-prop': 'off',
			'vue/no-v-html': 'off',

			// BASELINE DEBT: the rules below are violated by pre-lint legacy code
			// (~130 findings). They are demoted to `warn` so CI stays green while
			// keeping the problems visible. Escalate each back to `error` as the
			// violations get fixed. New code must not add warnings.
			'no-undef': 'warn',
			'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
			'no-empty': ['warn', { allowEmptyCatch: true }],
			'no-redeclare': 'warn',
			'no-unreachable': 'warn',
			'no-unused-private-class-members': 'warn',
			'no-async-promise-executor': 'warn',
			'no-prototype-builtins': 'warn',
			'vue/require-v-for-key': 'warn',
			'vue/return-in-computed-property': 'warn',
			'vue/no-mutating-props': 'warn',
			'vue/no-parsing-error': 'warn',
			'vue/no-unused-vars': 'warn',
			'vue/no-ref-as-operand': 'warn',
			'vue/no-side-effects-in-computed-properties': 'warn',
		},
	},
];
