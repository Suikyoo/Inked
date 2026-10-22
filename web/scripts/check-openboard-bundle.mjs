#!/usr/bin/env node
// Fails (exit 1) when the openboard visitor or editor bundle statically pulls in the notes app's store,
// crypto (hash-wasm / argon2) or transformers. Run after `npm run build -w web`.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const manifestPath = join(dist, '.vite', 'manifest.json');
const ENTRIES = ['openboard.html', 'openboard-editor.html'];
const FORBIDDEN_PATH = /hash-wasm|@huggingface|inked-core\/crypto|core\/src\/crypto|state\/store|argon|StoreContext/i;
const FORBIDDEN_CODE = ['hash-wasm', 'argon2'];

if (!existsSync(manifestPath)) {
  console.error(`check-openboard-bundle: ${manifestPath} not found; run \`npm run build -w web\` first`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const problems = [];
const seen = new Set();
const stack = [];
for (const key of ENTRIES) {
  if (!manifest[key]) problems.push(`entry ${key} is missing from the manifest`);
  else stack.push([key, [key]]);
}

while (stack.length) {
  const [key, path] = stack.pop();
  if (seen.has(key)) continue;
  seen.add(key);
  const chunk = manifest[key];
  if (!chunk) {
    problems.push(`${path.join(' -> ')}: not in the manifest`);
    continue;
  }
  const via = path.join(' -> ');
  for (const name of [key, chunk.src, chunk.file, chunk.name].filter(Boolean)) {
    if (FORBIDDEN_PATH.test(name)) problems.push(`${via}: forbidden module ${name}`);
  }
  if (chunk.file?.endsWith('.js')) {
    const file = join(dist, chunk.file);
    const code = existsSync(file) ? readFileSync(file, 'utf8') : '';
    for (const s of FORBIDDEN_CODE) if (code.includes(s)) problems.push(`${via}: ${chunk.file} contains "${s}"`);
  }
  for (const next of chunk.imports ?? []) stack.push([next, [...path, next]]);
}

if (problems.length) {
  console.error('openboard bundles are not clean:');
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log('openboard bundles clean');
