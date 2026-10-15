/** HTTP API + static hosting for the NuclearCraft: Overhauled fission optimizer. */
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import {
  FUELS, MODERATORS, REFLECTORS, SHIELDS, IRRADIATOR_RECIPES, SOURCES, SFR_COOLANTS, COOLER_NAMES, HEATER_NAMES, HEATER_COOLANTS, COOLING_RATES, SINK_RULES, HEATER_RULES,
  GAS_COOLER_NAMES, GAS_COOLING_RATES, GAS_COOLER_RULES, GAS_COOLANTS, DECAY_CONFIG, COOLER0, SHIELD0, IRRADIATOR,
  FISSION_CONFIG, NUM_BLOCKS, TURBINE_BLADES, TURBINE_STATOR, TURBINE_COILS, TURBINE_CONNECTOR, TURBINE_FLUIDS, TURBINE_CONFIG, blockKey, blockName, isValidBlock,
  Simulator, explainAll, planSources, shutdownCheck, decayReport, resolveFuels, isFuel, fuelSlot, toLayoutJSON, type ReactorType,
} from '@ncopt/engine';
import { JobManager } from './jobs.js';
import { Library, libraryKey } from './library.js';
import { BadRequest, parseBase, parseGrid, parseOptimize, parseSource, parseTurbine, parseHX } from './validate.js';
import { Worker } from 'node:worker_threads';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, bodyLimit: 8 * 1024 * 1024 });
const library = new Library(process.env.NCOPT_LIBRARY ?? path.resolve(here, '../data/library.json'));
const jobs = new JobManager(new URL('./worker.mjs', import.meta.url), library);

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof BadRequest) return reply.status(400).send({ error: err.message });
  app.log.error(err);
  return reply.status((err as any).statusCode ?? 500).send({ error: err.message });
});

app.get('/api/meta', async () => ({
  fuels: FUELS,
  moderators: MODERATORS,
  reflectors: REFLECTORS,
  sources: SOURCES,
  sfrCoolants: SFR_COOLANTS,
  config: FISSION_CONFIG,
  sinks: COOLER_NAMES.map((id, i) => ({ id, block: COOLER0 + i, cooling: COOLING_RATES[i], rule: SINK_RULES[i] })),
  heaters: HEATER_NAMES.map((id, i) => ({ id, block: COOLER0 + i, cooling: COOLING_RATES[i], rule: HEATER_RULES[i], coolant: HEATER_COOLANTS[i] })),
  gasCoolers: GAS_COOLER_NAMES.map((id, i) => ({ id, block: COOLER0 + i, cooling: GAS_COOLING_RATES[i], rule: GAS_COOLER_RULES[i], coolant: GAS_COOLANTS[i] })),
  shields: SHIELDS.map((s, i) => ({ ...s, block: SHIELD0 + i })),
  irradiator: { block: IRRADIATOR, recipes: IRRADIATOR_RECIPES },
  decay: DECAY_CONFIG,
  blocks: Object.fromEntries((['sfr', 'msr', 'pbr'] as ReactorType[]).map((r) => [r, Array.from({ length: NUM_BLOCKS }, (_, b) => b)
    .filter((b) => isValidBlock(b, r)).map((b) => ({ id: b, key: blockKey(b, r), name: blockName(b, r) }))])),
  maxWorkers: Math.max(1, os.availableParallelism?.() ?? os.cpus().length),
  turbine: { blades: TURBINE_BLADES, stator: TURBINE_STATOR, coils: TURBINE_COILS, connector: TURBINE_CONNECTOR, fluids: TURBINE_FLUIDS, config: TURBINE_CONFIG },
}));

/**
 * Full simulation of a layout: stats, per-block explanation, a neutron-source plan, the shutdown check (with shields)
 * and the decay report (with decay mechanics).
 */
app.post('/api/simulate', async (req) => {
  const body = req.body as any;
  const base = parseBase(body);
  const grid = parseGrid(body.grid, base.dims[0] * base.dims[1] * base.dims[2], base.reactor);
  const sourceType = parseSource(body.sourceType);
  const fuels = resolveFuels(base);
  for (const b of grid) if (isFuel(b) && fuelSlot(b) >= fuels.length) throw new BadRequest(`layout uses fuel #${fuelSlot(b) + 1} but only ${fuels.length} fuel(s) are listed`);
  const sim = new Simulator(base.dims, {
    reactor: base.reactor, fuel: fuels[0], fuels, sfrCoolant: base.sfrCoolant, irradiatorRecipe: base.irradiatorRecipe, decayMechanics: base.decayMechanics,
  });
  const stats = sim.evaluate(grid);
  const blocks = explainAll(sim).filter((b) => b.block !== 0);
  const decay = base.decayMechanics ? decayReport(sim) : null;
  const shutdown = stats.shields > 0 ? shutdownCheck(new Simulator(base.dims, sim.opts), grid) : null;
  const plan = planSources(new Simulator(base.dims, sim.opts), grid, sourceType);
  return {
    stats, blocks, sourcePlan: plan, shutdown, decay,
    layout: toLayoutJSON(grid, base.dims, base.reactor, base.fuelId, base.sfrCoolant, base.fuelIds, base.irradiatorRecipe),
  };
});

/** Design the best steam turbine(s) for a steam flow (runs in a worker thread, ~0.3-3 s). */
app.post('/api/turbine', async (req) => {
  const cfg = parseTurbine(req.body);
  return await new Promise((resolve, reject) => {
    const w = new Worker(new URL('./task-worker.mjs', import.meta.url), { workerData: { type: 'turbine', cfg } });
    w.once('message', (m: any) => (m.ok ? resolve(m.result) : reject(new BadRequest(m.error))));
    w.once('error', reject);
  });
});

/** Design heat exchanger(s) for an MSR's hot coolant (runs in a worker thread). */
app.post('/api/hx', async (req) => {
  const cfg = parseHX(req.body);
  return await new Promise((resolve, reject) => {
    const w = new Worker(new URL('./task-worker.mjs', import.meta.url), { workerData: { type: 'hx', cfg } });
    w.once('message', (m: any) => (m.ok ? resolve(m.result) : reject(new BadRequest(m.error))));
    w.once('error', reject);
  });
});

app.post('/api/optimize', async (req) => {
  const { cfg, workers, options } = parseOptimize(req.body);
  const job = jobs.create(cfg, workers, options);
  return { jobId: job.id, workers };
});

/** Result library: best saved layouts for the configuration in the body (same shape as /api/optimize). */
app.post('/api/library/query', async (req) => {
  const { cfg } = parseOptimize(req.body);
  return { key: libraryKey(cfg), entries: library.forConfig(cfg) };
});
app.get('/api/library', async () => ({ entries: library.list() }));
app.delete('/api/library/:id', async (req, reply) => {
  if (!library.remove((req.params as any).id)) return reply.status(404).send({ error: 'entry not found' });
  return { ok: true };
});

app.get('/api/jobs/:id', async (req, reply) => {
  const job = jobs.get((req.params as any).id);
  if (!job) return reply.status(404).send({ error: 'job not found' });
  return jobs.snapshot(job);
});

app.post('/api/jobs/:id/cancel', async (req, reply) => {
  const job = jobs.get((req.params as any).id);
  if (!job) return reply.status(404).send({ error: 'job not found' });
  jobs.cancel(job);
  return { ok: true };
});

/** Server-sent events: `progress` snapshots while running, then one `done` with all results. */
app.get('/api/jobs/:id/events', (req, reply) => {
  const job = jobs.get((req.params as any).id);
  if (!job) { reply.status(404).send({ error: 'job not found' }); return; }
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  if (job.status !== 'running' && job.threads.length === 0) { send('done', jobs.snapshot(job)); res.end(); return; }
  send('progress', jobs.snapshot(job, false));
  let pending: unknown = null, timer: NodeJS.Timeout | null = null;
  const off = jobs.subscribe(job, (event, data) => {
    if (event === 'done') { if (timer) clearTimeout(timer); send('done', data); off(); res.end(); return; }
    pending = data; // coalesce progress bursts from many workers
    if (!timer) timer = setTimeout(() => { timer = null; if (pending) send('progress', pending); pending = null; }, 200);
  });
  req.raw.on('close', () => { off(); if (timer) clearTimeout(timer); });
});

const webDist = path.resolve(here, '../../web/dist');
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api/') ? reply.status(404).send({ error: 'not found' }) : reply.sendFile('index.html')));
} else {
  app.get('/', async () => 'Web UI not built yet: run `npm run build` (or `npm run dev:web` for the Vite dev server).');
}

const port = Number(process.env.PORT ?? 8787);
await app.listen({ port, host: process.env.HOST ?? '127.0.0.1' });
