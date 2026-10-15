// Assembles a self-contained release folder: release/ncopt-<version>/ runs with `node` alone (no npm install).
// Usage: node scripts/package-release.mjs [version]   (run `npm run build` first for the web UI)
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2] ?? `v${JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version}`;
const name = `ncopt-${version}`;
const out = path.join(root, 'release', name);
const webDist = path.join(root, 'apps/web/dist');
if (!existsSync(path.join(webDist, 'index.html'))) throw new Error('apps/web/dist is missing: run `npm run build` first');

rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, 'apps/server/dist'), { recursive: true });

// server + worker threads with every dependency bundled in (fastify needs `require` inside an ES module)
const common = {
  bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'warning', legalComments: 'none',
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
};
for (const [entry, file] of [['index.ts', 'server.mjs'], ['worker.ts', 'worker.mjs'], ['task-worker.ts', 'task-worker.mjs']]) {
  await build({ ...common, entryPoints: [path.join(root, 'apps/server/src', entry)], outfile: path.join(out, 'apps/server/dist', file) });
}
cpSync(webDist, path.join(out, 'apps/web/dist'), { recursive: true });
for (const f of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) cpSync(path.join(root, f), path.join(out, f));

// licenses of the bundled runtime dependencies (server and web UI)
const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const licenses = [];
for (const [dir, pkg] of Object.entries(lock.packages)) {
  if (!dir.includes('node_modules/') || pkg.dev || pkg.link) continue;
  const abs = path.join(root, dir);
  if (!existsSync(abs)) continue;
  const file = readdirSync(abs).find((f) => /^(licen[cs]e|copying)/i.test(f));
  const text = file ? readFileSync(path.join(abs, file), 'utf8').trim() : `License: ${pkg.license ?? 'see package'}`;
  licenses.push(`${'='.repeat(78)}\n${dir.slice(dir.lastIndexOf('node_modules/') + 13)}@${pkg.version}\n${'='.repeat(78)}\n${text}\n`);
}
writeFileSync(path.join(out, 'THIRD_PARTY_LICENSES.txt'), `Licenses of the open-source packages bundled into this release.\n\n${licenses.join('\n')}`);

writeFileSync(path.join(out, 'start.bat'), [
  '@echo off',
  'cd /d "%~dp0"',
  'where node >nul 2>nul || (echo Node.js 20 or newer is required: https://nodejs.org/ & pause & exit /b 1)',
  'echo NC:O Fission Optimizer: open http://localhost:8787 in your browser (Ctrl+C to stop)',
  'node apps\\server\\dist\\server.mjs',
  'pause',
  '',
].join('\r\n'));
writeFileSync(path.join(out, 'start.sh'), [
  '#!/bin/sh',
  'cd "$(dirname "$0")"',
  'command -v node >/dev/null 2>&1 || { echo "Node.js 20 or newer is required: https://nodejs.org/"; exit 1; }',
  'echo "NC:O Fission Optimizer: open http://localhost:8787 in your browser (Ctrl+C to stop)"',
  'exec node apps/server/dist/server.mjs',
  '',
].join('\n'), { mode: 0o755 });
writeFileSync(path.join(out, 'README.txt'), `NC:O Fission Optimizer ${version}

Requires Node.js 20 or newer (https://nodejs.org/). Nothing else needs to be installed.

Start:   Windows: double-click start.bat      Linux / macOS: ./start.sh
Then open http://localhost:8787 in your browser.

Settings (environment variables): PORT (default 8787), HOST (default 127.0.0.1),
NCOPT_LIBRARY (result library file, default apps/server/data/library.json), LOG_LEVEL.

Source, documentation and issues: https://github.com/Rendant/NCO-Optimizer
License: MIT (LICENSE); bundled packages: THIRD_PARTY_LICENSES.txt, THIRD_PARTY_NOTICES.md
`);
console.log(`release assembled -> release/${name}`);
