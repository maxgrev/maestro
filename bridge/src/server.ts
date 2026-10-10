import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { Service } from './service.js';
import { requestId } from './service.js';
import { UserError } from './types.js';
import type { Onboarding } from './onboarding.js';
import { AgentSetup } from './agent-setup.js';
import { voices } from './speech.js';

function tokenMatches(header: string | undefined, token: string | undefined) {
  if (!token || !header?.startsWith('Bearer ')) return false;
  const a = Buffer.from(header.slice(7)), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function buildServer(service: Service, options: { local?: boolean; https?: { key: Buffer; cert: Buffer }; onboarding?: Onboarding } = {}) {
  const app = Fastify({ logger: false, bodyLimit: 700_000, ...(options.https ? { https: options.https } : {}) });
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', "default-src 'self'; connect-src 'self'; media-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    const callback = ['/api/grok/reply', '/api/grok/inbox'].includes(req.url.split('?')[0] ?? '');
    if (callback) {
      if (!tokenMatches(req.headers.authorization, service.config.grok?.replyKey)) throw new UserError('Unauthorized.', 401);
      return;
    }
    if (options.local) {
      const host = req.headers.host;
      const allowed = [`localhost:${service.config.localPort}`, `127.0.0.1:${service.config.localPort}`];
      if (!host || !allowed.includes(host)) throw new UserError('Invalid local host.', 403);
      if (req.headers.origin && req.headers.origin !== `http://${host}`) throw new UserError('Cross-origin requests are not allowed.', 403);
    } else if (!tokenMatches(req.headers.authorization, service.config.deviceToken)) throw new UserError('Unauthorized.', 401);
  });
  app.setErrorHandler((error, _req, reply) => {
    const status = error instanceof UserError ? error.statusCode : error instanceof z.ZodError ? 400 : (error as { statusCode?: number }).statusCode ?? 500;
    const message = error instanceof z.ZodError ? 'Invalid request fields.' : error instanceof Error && (status < 500 || error instanceof UserError) ? error.message : 'The bridge could not complete this request.';
    void reply.status(status).send({ error: message });
  });
  app.addContentTypeParser('audio/pcm', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  app.get('/api/health', async () => ({ name: 'Maestro', version: '0.2.0', speech: 'local', muse: 'Pair on the device using the Muse app' }));
  app.get('/api/targets', () => service.targets());
  app.get('/api/inbox/status', () => ({ ...service.store.inbox.status(), warnings: [...service.observer?.warnings ?? []] }));
  app.get('/api/inbox', req => {
    const q = z.object({ before: z.coerce.number().int().positive().safe().optional(), target: z.string().max(250).default('') }).parse(req.query);
    return service.store.inbox.page(q.before, q.target);
  });
  app.get('/api/inbox/:id', req => {
    const { id } = z.object({ id: z.coerce.number().int().positive().safe() }).parse(req.params);
    const { maxBytes } = z.object({ maxBytes: z.coerce.number().int().min(1000).max(64000).optional() }).parse(req.query);
    const item = service.store.inbox.get(id);
    if (!item) throw new UserError('Reply not found.', 404);
    if (maxBytes) {
      const bytes = Buffer.from(item.reply);
      if (bytes.length > maxBytes) {
        let end = maxBytes;
        while ((bytes[end]! & 0xc0) === 0x80) end--;
        return { ...item, reply: bytes.subarray(0, end).toString('utf8'), truncated: true };
      }
    }
    return item;
  });
  app.post('/api/inbox/ack', req => {
    const b = z.object({ ids: z.array(z.number().int().positive().safe()).max(64), kind: z.enum(['read', 'alert']) }).strict().parse(req.body);
    service.store.inbox.acknowledge(b.ids, b.kind); return { ok: true };
  });
  app.post('/api/inbox/read-turn', req => {
    const { turn } = z.object({ turn: requestId }).strict().parse(req.body);
    service.store.inbox.readTurn(turn); return { ok: true };
  });
  app.post('/api/inbox/muse', req => {
    const b = z.object({ id: z.string().min(1).max(160), text: z.string().trim().min(1).max(64000), read: z.boolean().default(false) }).strict().parse(req.body);
    const item = service.store.inbox.add({ key: `muse:${b.id}`, target: { id: 'muse', name: 'Muse', character: 'muse' }, reply: b.text, read: b.read });
    if (b.read && item) service.store.inbox.acknowledge([item.id], 'read');
    return { ok: true };
  });
  app.get('/api/turns', async () => ({ turns: service.store.list() }));
  app.get('/api/turns/:id', async req => {
    const { id } = z.object({ id: requestId }).parse(req.params);
    const turn = service.store.get(id);
    if (!turn) throw new UserError('Request not found.', 404);
    return turn;
  });
  app.post('/api/turns', async (req, reply) => {
    const body = z.object({ id: requestId, target: z.string().min(1).max(250), text: z.string().min(1).max(8000) }).strict().parse(req.body);
    return reply.code(202).send(await service.submit(body.id, body.target, body.text));
  });
  app.post('/api/voice', async (req, reply) => {
    const q = z.object({ id: requestId, target: z.string().min(1).max(250) }).strict().parse(req.query);
    if (!Buffer.isBuffer(req.body)) throw new UserError('Expected audio/pcm.');
    return reply.code(202).send(await service.submit(q.id, q.target, req.body));
  });
  app.post('/api/grok/reply', async req => {
    const b = z.object({ request_id: requestId, text: z.string().trim().min(1).max(16000), needs_attention: z.boolean().default(false) }).strict().parse(req.body);
    return service.reply(b.request_id, b.text, b.needs_attention);
  });
  app.post('/api/grok/inbox', req => {
    const b = z.object({ request_id: requestId, text: z.string().trim().min(1).max(16000), needs_attention: z.boolean().default(false) }).strict().parse(req.body);
    service.store.inbox.add({ key: `grok:${b.request_id}`, target: { id: 'grok', name: 'Grok Bot', character: 'grok' },
      reply: b.text, attention: b.needs_attention });
    return { ok: true };
  });
  app.post('/api/speech', async (req, reply) => {
    const b = z.object({ text: z.string().trim().min(1).max(16000), format: z.enum(['pcm', 'mp3']).default('pcm'),
      voice: z.string().refine(v => voices.some(x => x.id === v)).optional() }).strict().parse(req.body);
    const audio = service.speech.stream ? service.speech.stream(b.text, b.format, b.voice) : await service.speech.speak(b.text, b.format, b.voice);
    if ('destroy' in audio) reply.raw.once('close', () => audio.destroy());
    return reply.type(b.format === 'pcm' ? 'audio/pcm' : 'audio/mpeg').send(audio);
  });
  if (options.local) {
    if (options.onboarding) {
      const setup = options.onboarding;
      app.get('/api/setup', () => setup.state());
      app.get('/api/setup/grok-guide', async () => setup.grokGuide());
      app.get('/api/setup/remote', () => setup.remote.state());
      app.post('/api/setup/remote', async req => {
        const { action } = z.object({ action: z.enum(['enable', 'disable']) }).strict().parse(req.body);
        return setup.remote.change(action);
      });
      app.post('/api/setup/device', async (req, reply) => reply.code(202).send(setup.start(req.body)));
      app.post('/api/setup/agents', async req => setup.saveAgents(req.body));
      const agents=new AgentSetup();
      app.get('/api/setup/coding',()=>agents.state());
      app.post('/api/setup/coding',async req=>agents.start(req.body));
      app.post('/api/setup/coding/cancel',async()=>agents.cancel());
      app.post('/api/setup/coding/pi',async req=>agents.savePi(req.body));
      app.addHook('onClose',async()=>{agents.cancel();});
    }
    void app.register(fastifyStatic, { root: resolve('bridge/public') });
  }
  return app;
}
