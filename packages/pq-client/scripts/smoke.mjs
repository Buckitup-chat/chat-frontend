// Loads every built module with Node's own ESM resolver, no bundler: the
// published dist must work for a client that does not bundle.
import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const modules = readdirSync(dist).filter((f) => f.endsWith('.js'));
if (!modules.length) throw new Error('dist is empty: build the package first');
for (const file of modules) await import(pathToFileURL(dist + file).href);
console.log(`@buckitup/pq-client: ${modules.length} modules load in Node`);
