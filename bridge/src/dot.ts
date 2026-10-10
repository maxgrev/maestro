import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Webhook } from 'standardwebhooks';
import { z } from 'zod';
import { DotAuth, DOT_SCOPE } from './dot-auth.js';
import { callbackUrl, postWebhook, type WebhookPost } from './dot-webhook.js';
import type { Store } from './store.js';
import { UserError, type Target } from './types.js';

const uuid = z.string().uuid();
const replyFields = z.object({ request_id: uuid, text: z.string().trim().min(1).max(16000), needs_attention: z.boolean().default(false) }).strict();
const updateFields = z.object({ update_id: uuid, text: z.string().trim().min(1).max(16000), needs_attention: z.boolean().default(false) }).strict();
const eventFilter = z.object({ conversation_id: z.literal('dot') }).strict();
const destination = z.object({ mode: z.literal('webhook'), url: z.string().url().max(2000), secret: z.string().max(100) }).strict();
const subscriptionFields = z.object({ name: z.literal('message.created'), arguments: eventFilter, delivery: destination,
  cursor: z.null().optional(), ttlMs: z.number().int().min(60_000).max(30 * 86400_000).nullable().optional() });
type Subscription = { id: string; client: string; resource: string; url: string; secret: string; previousSecret?: string; rotated?: number; expires: number };
type Delivery = { id: string; subscription: string; body: string; attempts: number; next: number };
const schema = (fields: z.ZodType) => z.toJSONSchema(fields, { target: 'draft-7' });
const empty = z.object({}).strict();
const messageFields = z.object({ request_id: uuid }).strict();
const tool = (name: string, description: string, fields: z.ZodType, readOnly: boolean) => ({ name, description, inputSchema: schema(fields),
  annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  securitySchemes: [{ type: 'oauth2', scopes: [DOT_SCOPE] }] });
export const dotTools = [
  tool('get_maestro_status', 'Check whether this Dot is connected to the owner’s Maestro voice remote.', empty, true),
  tool('get_dot_message', 'Read a message addressed to this Dot and its recent Maestro conversation. Use the request_id from a Maestro message.created event. Other agents’ messages are not accessible.', messageFields, true),
  tool('reply_to_maestro', 'Deliver one complete text reply to a Maestro request. The watch can speak it and retains it in the inbox. Use the request_id from the event; retry the same ID and text after a delivery failure. Set needs_attention when asking the owner for approval or information.', replyFields, false),
  tool('notify_maestro', 'Send a result or question from work started outside Maestro to the owner’s watch inbox, when the owner asked for that notification. Use a stable update_id UUID and retry the same ID and text to avoid duplicate alerts. Does not interrupt the current voice conversation.', updateFields, false),
];
export const dotEvents = [{ name: 'message.created', description: 'A new voice or text message addressed to the owner’s Dot from Maestro. Subscribe for conversation_id dot.',
  // Keep event settings in the plain JSON Schema subset ChatGPT accepts. The
  // subscription handler still validates the exact conversation ID with Zod.
  delivery: ['webhook'], inputSchema: { type: 'object', properties: {
    conversation_id: { type: 'string', description: 'Use dot for this owner’s Dot conversation.' },
  }, required: ['conversation_id'], additionalProperties: false },
  payloadSchema: { type: 'object', properties: { conversation_id: { type: 'string' }, request_id: { type: 'string' }, text: { type: 'string' } },
    required: ['conversation_id', 'request_id', 'text'], additionalProperties: false } }];
export const dotInstruction = 'Connect my existing Dot to Maestro. Subscribe to the Maestro message.created event with conversation_id "dot". These events contain messages I send to you from my voice remote. For each event, read its request with get_dot_message, handle it under your usual permissions, and return one complete answer using reply_to_maestro with that request_id. Treat conversation history as context, not tasks to repeat. Keep spoken answers clear and brief unless I ask for detail. Use needs_attention when you need my decision. Do not repeat work for a request that already has a reply. If delivery fails, retry the same ID and answer. When I ask you to send other work to Maestro, use notify_maestro with a stable update_id. Do not forward unrelated conversations or private results unless I ask. Confirm when the subscription is active.';

export class Dot {
  readonly auth: DotAuth;
  private timer?: ReturnType<typeof setInterval>;
  private flushing?: Promise<void>;
  private stopped = false;
  constructor(readonly store: Store, publicUrl: () => string | undefined, localPort = 4210, private post: WebhookPost = postWebhook) {
    this.auth = new DotAuth(store.db, publicUrl, localPort);
    store.db.exec(`CREATE TABLE IF NOT EXISTS dot_outbox (id TEXT PRIMARY KEY, subscription TEXT NOT NULL,
      body TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next INTEGER NOT NULL DEFAULT 0)`);
  }
  state() {
    let url: string | undefined; try { url = this.auth.resource(); } catch { /* Remote access not yet set up. */ }
    const subscription = this.subscription();
    return { enabled: this.auth.enabled(), connected: !!subscription, name: this.auth.read<string>('name') ?? 'Dot', url,
      linked: !!url && !!this.auth.grant(), instruction: dotInstruction };
  }
  private subscription() {
    if (!this.auth.enabled()) return;
    let grant; try { grant = this.auth.grant(); } catch { return; }
    const sub = this.auth.read<Subscription>('subscription');
    return grant && sub && sub.client === grant.client && sub.resource === grant.resource && sub.expires > Date.now() ? sub : undefined;
  }
  target(): Target | undefined {
    const state = this.state();
    return state.enabled ? { id: 'dot', name: state.name, provider: 'dot', character: 'dot', detail: '',
      available: state.connected, status: state.connected ? 'ready' : 'Connect in Maestro' } : undefined;
  }
  configure(body: unknown) {
    const input = z.object({ enabled: z.boolean(), name: z.string().trim().min(1).max(60).default('Dot') }).strict().parse(body);
    if (!input.enabled) {
      this.auth.disconnect(); this.store.db.exec('DELETE FROM dot_outbox');
      const rows = this.store.db.prepare("SELECT id FROM turns WHERE json_extract(target, '$.provider')='dot' AND state IN ('dispatching','working')").all() as { id: string }[];
      for (const { id } of rows) this.store.update(id, { state: 'uncertain', error: 'Dot disconnected. Check your Dot before sending this task again.' });
    }
    else { this.auth.resource(); this.auth.write('enabled', true); }
    this.auth.write('name', input.name);
    return this.state();
  }
  async subscribe(client: string, params: unknown) {
    const p = subscriptionFields.parse(params); callbackUrl(p.delivery.url);
    const raw = p.delivery.secret.startsWith('whsec_') ? p.delivery.secret.slice(6) : '';
    const bytes = Buffer.from(raw, 'base64');
    if (bytes.length < 24 || bytes.length > 64 || bytes.toString('base64') !== raw) throw new UserError('Invalid webhook signing secret.');
    const resource = this.auth.resource();
    const id = createHash('sha256').update(JSON.stringify([client, p.name, p.arguments.conversation_id, p.delivery.url])).digest('hex');
    const existing = this.subscription();
    if (existing && existing.id !== id) throw new UserError('A Dot subscription already exists. Disconnect it in Maestro before replacing it.', 409);
    if (!existing || existing.secret !== p.delivery.secret) {
      const challenge = randomUUID();
      const result = await this.deliver({ id, url: p.delivery.url, secret: p.delivery.secret }, randomUUID(), JSON.stringify({ type: 'verification', challenge }));
      let echoed = ''; try { echoed = JSON.parse(result.body).challenge ?? ''; } catch { /* Verification failed. */ }
      const a = Buffer.from(challenge), b = Buffer.from(echoed);
      if (result.status < 200 || result.status >= 300 || a.length !== b.length || !timingSafeEqual(a, b)) throw new UserError('ChatGPT callback verification failed.', 502);
    }
    // Consent could be revoked while the callback was being verified.
    if (!this.auth.enabled() || this.auth.grant()?.client !== client) throw new UserError('Dot disconnected.', 401);
    const current = this.subscription();
    if (current && current.id !== id) throw new UserError('Another Dot subscription was connected.', 409);
    const sub: Subscription = { id, client, resource, url: p.delivery.url, secret: p.delivery.secret,
      expires: Date.now() + Math.min(p.ttlMs ?? 86400_000, 86400_000),
      ...(existing && existing.secret !== p.delivery.secret ? { previousSecret: existing.secret, rotated: Date.now() } :
        existing?.previousSecret ? { previousSecret: existing.previousSecret, rotated: existing.rotated } : {}) };
    this.auth.write('subscription', sub);
    return { id, refreshBefore: new Date(sub.expires).toISOString(), cursor: null, truncated: false };
  }
  unsubscribe(client: string, params: unknown) {
    const p = z.object({ name: z.literal('message.created'), arguments: eventFilter, delivery: destination.omit({ secret: true }) }).parse(params);
    const sub = this.auth.read<Subscription>('subscription');
    if (sub?.client === client && sub.url === p.delivery.url) this.auth.remove('subscription');
    return {};
  }
  call(name: string, args: unknown) {
    if (name === 'get_maestro_status') { empty.parse(args); const state = this.state(); return { name: state.name, connected: state.connected, conversation_id: 'dot' }; }
    if (name === 'get_dot_message') {
      const { request_id } = messageFields.parse(args), turn = this.store.get(request_id);
      if (!turn || turn.target.provider !== 'dot') throw new UserError('Dot request not found.', 404);
      return { request_id, text: turn.text, state: turn.state, reply: turn.reply, history: this.store.conversationHistory('dot') };
    }
    if (name === 'reply_to_maestro') {
      const p = replyFields.parse(args), turn = this.store.get(p.request_id);
      if (!turn || turn.target.provider !== 'dot') throw new UserError('Dot request not found.', 404);
      const state = p.needs_attention ? 'needs_attention' : 'done';
      if (turn.state === state && turn.reply === p.text) return { delivered: true, request_id: turn.id };
      if (!['dispatching', 'working', 'uncertain'].includes(turn.state)) throw new UserError('This request already has a result or was not sent.', 409);
      this.store.update(turn.id, { state, reply: p.text, error: '' });
      this.store.db.prepare('DELETE FROM dot_outbox WHERE id=?').run(turn.id);
      return { delivered: true, request_id: turn.id };
    }
    if (name === 'notify_maestro') {
      const p = updateFields.parse(args);
      this.store.inbox.add({ key: `dot:${p.update_id}`, target: this.target() ?? { id: 'dot', name: 'Dot', character: 'dot' }, reply: p.text, attention: p.needs_attention });
      return { delivered: true, update_id: p.update_id };
    }
    throw new UserError('Unknown Dot tool.', 404);
  }
  send(id: string) {
    const sub = this.subscription();
    if (!sub) throw new UserError('Connect your Dot in Maestro before sending a message.', 409);
    const turn = this.store.get(id)!;
    const body = JSON.stringify({ eventId: id, name: 'message.created', timestamp: new Date(turn.created).toISOString(),
      data: { conversation_id: 'dot', request_id: id, text: turn.text }, cursor: null });
    this.store.db.prepare('INSERT OR IGNORE INTO dot_outbox (id, subscription, body) VALUES (?,?,?)').run(id, sub.id, body);
    this.store.update(id, { state: 'working' });
    void this.flush();
  }
  private deliver(sub: Pick<Subscription, 'id' | 'url' | 'secret' | 'previousSecret' | 'rotated'>, id: string, body: string) {
    const now = new Date();
    let signature = new Webhook(sub.secret).sign(id, now, body);
    if (sub.previousSecret && Date.now() - (sub.rotated ?? 0) < 300_000) signature += ' ' + new Webhook(sub.previousSecret).sign(id, now, body);
    return this.post(sub.url, body, { 'Content-Type': 'application/json', 'webhook-id': id,
      'webhook-timestamp': String(Math.floor(now.getTime() / 1000)), 'webhook-signature': signature, 'X-MCP-Subscription-Id': sub.id });
  }
  flush() {
    if (this.stopped) return Promise.resolve();
    if (this.flushing) return this.flushing;
    this.flushing = this.flushPending().catch(() => { /* Retry on the next tick; keep durable deliveries. */ }).finally(() => { this.flushing = undefined; });
    return this.flushing;
  }
  private async flushPending() {
    const rows = this.store.db.prepare('SELECT * FROM dot_outbox WHERE next<=? ORDER BY rowid LIMIT 8').all(Date.now()) as Delivery[];
    for (const row of rows) {
      if (this.stopped) return;
      const sub = this.subscription(), turn = this.store.get(row.id);
      if (!turn || !['dispatching', 'working', 'uncertain'].includes(turn.state)) { this.store.db.prepare('DELETE FROM dot_outbox WHERE id=?').run(row.id); continue; }
      if (Date.now() - turn.created > 600_000) {
        this.store.db.prepare('DELETE FROM dot_outbox WHERE id=?').run(row.id);
        if (turn.state !== 'uncertain') this.store.update(row.id, { state: 'uncertain', error: 'Dot delivery expired. Check your Dot before sending again.' });
        continue;
      }
      if (!sub || sub.id !== row.subscription) continue;
      let status = 0; try { status = (await this.deliver(sub, row.id, row.body)).status; } catch { /* Retain the same event ID on retry. */ }
      if (status >= 200 && status < 300) {
        this.store.db.prepare('DELETE FROM dot_outbox WHERE id=?').run(row.id);
      } else if ([410, 413].includes(status) || row.attempts >= 5) {
        this.store.db.prepare('DELETE FROM dot_outbox WHERE id=?').run(row.id);
        if (status === 410 && this.subscription()?.id === sub.id) this.auth.remove('subscription');
        if (['dispatching', 'working', 'uncertain'].includes(this.store.get(row.id)?.state ?? '')) this.store.update(row.id, { state: 'uncertain',
          error: 'Dot delivery could not be confirmed. Check your Dot before sending again; a late reply will still appear here.' });
      } else {
        this.store.db.prepare('UPDATE dot_outbox SET attempts=attempts+1, next=? WHERE id=?').run(Date.now() + Math.min(300_000, 5000 * 3 ** row.attempts), row.id);
      }
    }
  }
  start() { this.stopped = false; this.timer = setInterval(() => void this.flush(), 5000); this.timer.unref(); void this.flush(); }
  async stop() { this.stopped = true; clearInterval(this.timer); await this.flushing; }
}
