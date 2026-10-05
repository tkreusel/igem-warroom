import type { FastifyInstance } from 'fastify';
import { bus } from '../bus.ts';
import { recentNews, testNews } from '../intel/breaking.ts';
import { buildBriefing, getBriefing, listBriefings, nextSlot } from '../intel/briefing.ts';
import { subscribe, subscribedIds, unsubscribe } from '../intel/watch.ts';

export async function intelRoutes(app: FastifyInstance) {
  // ---- subscriptions ----
  app.get('/api/subscriptions', async () => [...subscribedIds()]);

  app.put<{ Params: { id: string } }>('/api/subscriptions/:id', async (req, reply) => {
    if (!subscribe(Number(req.params.id))) return reply.code(404).send({ error: 'team not found' });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/subscriptions/:id', async (req) => {
    unsubscribe(Number(req.params.id));
    return { ok: true };
  });

  // ---- news ----
  app.get<{ Querystring: { limit?: string } }>('/api/news', async (req) => recentNews(Math.min(Number(req.query.limit ?? 50), 200)));

  /** Fire a demo BREAKING NEWS intermission in every open window (not stored). */
  app.post('/api/news/test', async () => {
    const event = testNews();
    bus.emit('news', event);
    return event;
  });

  // ---- briefings ----
  app.get('/api/briefings', async () => ({ items: listBriefings(), nextAt: nextSlot() }));

  /** Live draft covering the last 24 h up to now (not stored). */
  app.get('/api/briefings/preview', async () => ({ ...buildBriefing(Date.now()), id: null, preview: true }));

  app.get<{ Params: { id: string } }>('/api/briefings/:id', async (req, reply) => {
    const b = getBriefing(Number(req.params.id));
    if (!b) return reply.code(404).send({ error: 'briefing not found' });
    return b;
  });
}
