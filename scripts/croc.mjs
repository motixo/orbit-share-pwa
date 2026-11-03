import { mkdir, readFile, writeFile, mkdtemp, rm, cp } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';

const revision = '4fc5ac0c8463a3de2b0396205c69a38109863583';
const checksum = '3bc4be3711f9c3b9ec60a55b48be0788d4ea20780f8a8a429068788ff831330f';
const cache = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'orbit-share', 'croc', revision);
const source = join(cache, `croc-${revision}`);
await mkdir(cache, { recursive: true });
try { await readFile(join(source, 'LICENSE')); }
catch {
  const temporary = await mkdtemp(join(tmpdir(), 'orbit-croc-source-'));
  try {
    const response = await fetch(`https://codeload.github.com/schollz/croc/tar.gz/${revision}`);
    if (!response.ok) throw new Error(`Could not download croc: ${response.status}`);
    const archive = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(archive).digest('hex') !== checksum) throw new Error('Croc source checksum mismatch');
    await writeFile(join(temporary, 'croc.tar.gz'), archive);
    execFileSync('tar', ['-xzf', join(temporary, 'croc.tar.gz'), '-C', temporary]);
    await cp(join(temporary, `croc-${revision}`), source, { recursive: true });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

const plugin = {
  name: 'croc-browser',
  setup(bundler) {
    bundler.onResolve({ filter: /^croc-sdk\// }, args => ({ path: join(source, 'web/src/protocol', args.path.slice(9) + '.ts') }));
    bundler.onResolve({ filter: /\?raw$/ }, args => ({ path: resolve(args.resolveDir, args.path.slice(0, -4)), namespace: 'raw' }));
    bundler.onLoad({ filter: /.*/, namespace: 'raw' }, async args => ({ contents: await readFile(args.path, 'utf8'), loader: 'text' }));
    bundler.onLoad({ filter: /\/(engine|sha256)\.ts$/ }, async args => ({
      contents: (await readFile(args.path, 'utf8')).replace(/new URL\("\.\/(engine|sha256)-worker\.ts", import\.meta\.url\)/g, 'new URL("/croc-$1-worker.js", window.location.href)'),
      loader: 'ts', resolveDir: resolve(args.path, '..'),
    }));
    bundler.onLoad({ filter: /\/protocol\/client\.ts$/ }, async args => {
      let contents = await readFile(args.path, 'utf8');
      const before = 'const plain = new Uint8Array(8 + data.byteLength);';
      if (contents.split(before).length !== 2) throw new Error('Croc upload adapter needs updating');
      contents = `import { hashUploadChunk } from ${JSON.stringify(resolve('src/croc-hash.ts'))};\n` +
        contents.replace(before, `await hashUploadChunk(prepared.file, position, data);\n${before}`);
      return { contents, loader: 'ts', resolveDir: resolve(args.path, '..') };
    });
    bundler.onLoad({ filter: /\/protocol\/transport\.ts$/ }, async args => {
      let contents = await readFile(args.path, 'utf8');
      const consumed = '(this.socket as WebSocket & { consume?(bytes: number): void }).consume?.(message.byteLength + 8);';
      // Return stream credit when croc consumes a frame, keeping downloads bounded.
      for (const [before, after] of [
        ['if (this.messages.length > 0) return Promise.resolve(this.messages.shift()!);', `if (this.messages.length > 0) { const message = this.messages.shift()!; ${consumed} return Promise.resolve(message); }`],
        ['if (reader) reader.resolve(message);', `if (reader) { ${consumed} reader.resolve(message); }`],
      ]) {
        if (contents.split(before).length !== 2) throw new Error('Croc transport adapter needs updating');
        contents = contents.replace(before, after);
      }
      return { contents, loader: 'ts', resolveDir: resolve(args.path, '..') };
    });
  },
};
const options = { bundle: true, target: 'es2022', minify: true, define: { 'import.meta.env.BASE_URL': '"/"' }, nodePaths: [resolve('node_modules')], plugins: [plugin], logLevel: 'warning' };
const config = join(cache, 'tsconfig.json');
await writeFile(config, JSON.stringify({
  compilerOptions: {
    target: 'ES2022', module: 'preserve', moduleResolution: 'bundler',
    lib: ['ES2022', 'DOM', 'DOM.Iterable'], strict: true, skipLibCheck: true, types: [], noEmit: true,
    paths: {
      'croc-sdk/*': [join(source, 'web/src/protocol/*')],
      '@noble/*': [resolve('node_modules/@noble/*')],
      'lossless-json': [resolve('node_modules/lossless-json')],
    },
  },
  files: ['src/croc.ts', 'src/croc-socket.ts', 'src/croc-types.d.ts'].map(file => resolve(file)),
}));
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', config], { stdio: 'inherit' });
await build({ ...options, entryPoints: ['src/croc.ts'], outfile: 'dist/croc.js', format: 'iife', globalName: 'OrbitCroc', inject: [resolve('src/croc-socket.ts')] });
for (const worker of ['engine', 'sha256']) {
  await build({ ...options, entryPoints: [join(source, `web/src/protocol/${worker}-worker.ts`)], outfile: `dist/croc-${worker}-worker.js`, format: 'esm' });
}
await cp(join(source, 'LICENSE'), 'dist/croc.LICENSE');
