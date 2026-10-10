// Bundles the server and the optimizer worker (engine is TypeScript source in the workspace).
import { build } from 'esbuild';
const common = { bundle: true, platform: 'node', format: 'esm', target: 'node20', sourcemap: true, external: ['fastify', '@fastify/static'], logLevel: 'warning' };
await build({ ...common, entryPoints: ['src/index.ts'], outfile: 'dist/server.mjs' });
await build({ ...common, entryPoints: ['src/worker.ts'], outfile: 'dist/worker.mjs' });
await build({ ...common, entryPoints: ['src/task-worker.ts'], outfile: 'dist/task-worker.mjs' });
console.log('server bundled -> dist/');
