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
    const callback = req.url.split('?')[0] === '/api/grok/reply';
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
  app.post('/api/speech', async (req, reply) => {
    const b = z.object({ text: z.string().trim().min(1).max(1800), format: z.enum(['pcm', 'mp3']).default('pcm') }).strict().parse(req.body);
    const audio = await service.speech.speak(b.text, b.format);
    return reply.type(b.format === 'pcm' ? 'audio/pcm' : 'audio/mpeg').send(audio);
  });
  if (options.local) {
    if (options.onboarding) {
      const setup = options.onboarding;
      app.get('/api/setup', () => setup.state());
      app.get('/api/setup/grok-guide', async () => setup.grokGuide());
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
