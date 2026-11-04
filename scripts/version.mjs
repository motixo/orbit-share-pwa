import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';

const hash = createHash('sha256');
async function contents(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const path = directory + '/' + entry.name;
    if (entry.isDirectory()) await contents(path);
    else hash.update(path).update('\0').update(await readFile(path)).update('\0');
  }
}
await contents('dist');
const source = await readFile('dist/sw.js', 'utf8');
assert.equal(source.split('__VERSION__').length, 2);
await writeFile('dist/sw.js', source.replace('__VERSION__', hash.digest('hex').slice(0, 16)));
