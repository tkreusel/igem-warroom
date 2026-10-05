import type { FastifyInstance } from 'fastify';
import { bus } from '../bus.ts';
import { config } from '../config.ts';
import { gitlab } from '../sources/gitlab.ts';
import { registry } from '../sources/registry.ts';
import type { LivePart } from '../sync/registry.ts';
import type { NewsEvent } from '../intel/breaking.ts';
import { registryStatus } from '../sync/registry.ts';
import { activity, feed, globalStats, teamDetail, teamSummaries } from '../stats/aggregate.ts';
import { status } from '../sync/scheduler.ts';
import type { NewCommit } from '../sync/commits.ts';
import { db } from '../db/db.ts';

function meta() {
  return {
    year: config.year,
    homeTeam: config.homeTeam,
    wikiFreezeAt: config.wikiFreezeAt,
    pollIntervalSec: config.pollIntervalSec,
    serverTime: Date.now(),
    sync: status,
    budget: gitlab.budget,
    stats: globalStats(),
  };
}

export async function apiRoutes(app: FastifyInstance) {
  app.get('/api/meta', async () => meta());

  app.get('/api/teams', async () => teamSummaries());

  app.get<{ Params: { id: string } }>('/api/teams/:id', async (req, reply) => {
    const detail = teamDetail(Number(req.params.id));
    if (!detail) return reply.code(404).send({ error: 'team not found' });
    return detail;
  });

  app.get<{ Querystring: { limit?: string } }>('/api/feed', async (req) =>
    feed(Math.min(Number(req.query.limit ?? 60), 500)),
  );

  app.get<{ Querystring: { days?: string } }>('/api/activity', async (req) =>
    activity(Math.min(Number(req.query.days ?? 120), 400)),
  );

  /** Server-sent events: new commits, sync status, and "teams changed" hints. */
  app.get('/api/events', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('meta', meta());

    const teamNames = db.prepare('SELECT name, slug FROM teams WHERE id = ?');
    const onCommits = (commits: NewCommit[]) =>
      send(
        'commits',
        commits.map((c) => ({ ...c, ...(teamNames.get(c.teamId) as { name: string; slug: string }) })),
      );
    const onStatus = () => send('meta', meta());
    const onTeams = () => send('teams-updated', {});
    const onBudget = () => send('budget', gitlab.budget);
    const onParts = (parts: LivePart[]) => send('parts', parts);
    const onRegistryUpdated = () => send('registry-updated', {});
    const onRegistryStatus = () => send('registry-status', { status: registryStatus, budget: registry.budget });
    const onNews = (e: NewsEvent) => send('news', e);
    const onBriefing = (b: unknown) => send('briefing', b);
    const onSubs = (s: unknown) => send('subscriptions-changed', s);

    let lastBudget = 0;
    const throttledBudget = () => {
      if (Date.now() - lastBudget > 5000) {
        lastBudget = Date.now();
        onBudget();
      }
    };

    bus.on('commits', onCommits);
    bus.on('status', onStatus);
    bus.on('teams-updated', onTeams);
    bus.on('parts', onParts);
    bus.on('registry-updated', onRegistryUpdated);
    bus.on('registry-status', onRegistryStatus);
    bus.on('news', onNews);
    bus.on('briefing', onBriefing);
    bus.on('subscriptions-changed', onSubs);
    gitlab.on('budget', throttledBudget);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);

    req.raw.on('close', () => {
      clearInterval(ping);
      bus.off('commits', onCommits);
      bus.off('status', onStatus);
      bus.off('teams-updated', onTeams);
      bus.off('parts', onParts);
      bus.off('registry-updated', onRegistryUpdated);
      bus.off('registry-status', onRegistryStatus);
      bus.off('news', onNews);
      bus.off('briefing', onBriefing);
      bus.off('subscriptions-changed', onSubs);
      gitlab.off('budget', throttledBudget);
    });
  });
}
