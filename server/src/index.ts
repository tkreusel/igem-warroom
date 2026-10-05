import fs from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { config } from './config.ts';
import { apiRoutes } from './routes/api.ts';
import { intelRoutes } from './routes/intel.ts';
import { registryRoutes } from './routes/registry.ts';
import { startNewsDesk } from './intel/breaking.ts';
import { startBriefings } from './intel/briefing.ts';
import { startDiffWorker } from './sync/diffs.ts';
import { startRegistry } from './sync/registry.ts';
import { startScheduler } from './sync/scheduler.ts';

const app = Fastify({ logger: { level: 'warn' } });

await app.register(apiRoutes);
await app.register(registryRoutes);
await app.register(intelRoutes);

// In production the built client is served from here; in dev Vite serves it and proxies /api.
if (fs.existsSync(config.clientDist)) {
  await app.register(fastifyStatic, { root: config.clientDist });
}

await app.listen({ port: config.port, host: '127.0.0.1' });
console.log(`warroom server on http://127.0.0.1:${config.port}  (gitlab auth: ${config.gitlabToken ? 'token' : 'anonymous'})`);

if (process.env.NO_SYNC !== '1') {
  startScheduler().catch((err) => console.error('scheduler failed', err));
  // Separate host and rate limits, so it runs independently of the GitLab sync.
  startRegistry().catch((err) => console.error('registry sync failed', err));
  startDiffWorker().catch((err) => console.error('diff worker failed', err));
  startNewsDesk();
}
// Briefings are built from stored data, so they run even with NO_SYNC.
try {
  startBriefings();
} catch (err) {
  console.error('briefings failed', err);
}
