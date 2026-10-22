// Builds every standalone sandbox page (sandbox/<name>/vite.config.ts) into
// dist/sandbox/<name>/, after the app build: the deploy serves them from there
// at /app/sandbox/<name>/index.html. A new sandbox needs no change here.
import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const names = readdirSync(`${root}sandbox`, { withFileTypes: true })
	.filter((d) => d.isDirectory() && existsSync(`${root}sandbox/${d.name}/vite.config.ts`))
	.map((d) => d.name);

for (const name of names) {
	await build({
		configFile: `${root}sandbox/${name}/vite.config.ts`,
		logLevel: 'warn',
		build: { outDir: `${root}dist/sandbox/${name}`, emptyOutDir: true },
	});
	console.log(`sandbox ${name} → dist/sandbox/${name}`);
}
