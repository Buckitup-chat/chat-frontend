import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Every .ts, .js and .vue file under `dir`, recursively. */
export const sourceFiles = (dir: string): string[] => readdirSync(dir).flatMap((entry) => {
	const path = join(dir, entry);
	return statSync(path).isDirectory() ? sourceFiles(path) : /\.(ts|js|vue)$/.test(entry) ? [path] : [];
});
