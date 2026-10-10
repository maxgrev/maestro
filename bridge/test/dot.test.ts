import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Webhook } from 'standardwebhooks';
import { Dot } from '../src/dot.js';
import { callbackUrl, publicAddress, type WebhookPost } from '../src/dot-webhook.js';
import { Store } from '../src/store.js';
import { Service } from '../src/service.js';
import { Herdr } from '../src/herdr.js';
import { buildServer } from '../src/server.js';
import type { Config } from '../src/config.js';

const base = 'https://maestro.example.ts.net', resource = base + '/dot/mcp';
const callback = 'https://chatgpt.com/connector_platform_oauth_redirect';
const signingSecret = 'whsec_' + Buffer.alloc(32, 7).toString('base64');
const subscription = { name: 'message.created', arguments: { conversation_id: 'dot' },
  delivery: { mode: 'webhook', url: 'https://chatgpt.com/mcp-events/test', secret: signingSecret } };
const config: Config = { deviceToken: 'a'.repeat(64), host: '127.0.0.1', port: 4211, localPort: 4210, remotePort: 4212,
  herdr: { binary: '/unused', session: 'test' }, projects: [], agents: [],
  speech: { whisper: '/unused', model: '/unused', ffmpeg: '/unused', voice: 'Samantha' } };
const version = '2026-07-28';
const meta = { 'io.modelcontextprotocol/protocolVersion': version,
  'io.modelcontextprotocol/clientInfo': { name: 'dot-test', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} };
function fixture(post: WebhookPost = async (_url, body) => ({ status: 200, body }), path = ':memory:') {
  const store = new Store(path), dot = new Dot(store, () => base, 4210, post);
  dot.configure({ enabled: true, name: 'Dot' });
  const service = new Service(config, store, new Herdr(config, async () => { throw new Error('Herdr offline'); }),
    { transcribe: async () => 'Hello from my watch', speak: async () => Buffer.alloc(2) });
  service.dot = dot;
  const app = buildServer(service), local = buildServer(service, { local: true });
  async function close() { await dot.stop(); await service.drain(); await app.close(); await local.close(); store.close(); }
  return { store, dot, service, app, local, close };
}
type Fixture = ReturnType<typeof fixture>;
async function oauthRequest(f: Fixture, url: string, fields?: Record<string, unknown>, form = false) {
  if (!f.app.server.listening) await f.app.listen({ host: '127.0.0.1', port: 0 });
  const address = f.app.server.address() as { port: number };
  const response = await fetch(`http://127.0.0.1:${address.port}${url}`, { redirect: 'manual', signal: AbortSignal.timeout(5000),
    ...(fields ? { method: 'POST', headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
      body: form ? new URLSearchParams(fields as Record<string, string>).toString() : JSON.stringify(fields) } : {}) });
  const body = await response.text();
  return { statusCode: response.status, body, headers: Object.fromEntries(response.headers), json: () => JSON.parse(body) };
}

// Exercise the actual SDK OAuth HTTP handlers, PKCE and loopback consent route.
async function authorize(f: Fixture) {
  const registration = await oauthRequest(f, '/register', { client_name: 'ChatGPT',
    redirect_uris: [callback], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
  assert.equal(registration.statusCode, 201, registration.body);
  const client = registration.json() as { client_id: string };
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({ client_id: client.client_id, response_type: 'code', redirect_uri: callback,
    scope: 'dot:messages', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource, state: 'saved-state' });
  const redirect = await oauthRequest(f, '/authorize?' + query);
  assert.equal(redirect.statusCode, 302, redirect.body);
  const ticket = new URL(redirect.headers.location!).searchParams.get('authorize');
  const approved = await f.local.inject({ method: 'POST', url: '/api/setup/dot/authorize', headers: { host: 'localhost:4210' }, payload: { ticket } });
  assert.equal(approved.statusCode, 200, approved.body);
  const result = new URL(approved.json().redirect);
  assert.equal(result.searchParams.get('state'), 'saved-state');
  const grant = { client_id: client.client_id, grant_type: 'authorization_code', redirect_uri: callback,
    code: result.searchParams.get('code')!, code_verifier: verifier, resource };
  const exchange = (fields: Record<string, string>) => oauthRequest(f, '/token', fields, true);
  return { client: client.client_id, grant, exchange };
}
async function connect(f: Fixture) {
  const auth = await authorize(f), token = await auth.exchange(auth.grant);
  assert.equal(token.statusCode, 200, token.body);
  await f.dot.subscribe(auth.client, subscription);
  return { ...auth, ...token.json() as { access_token: string; refresh_token: string } };
}
function rpc(f: Fixture, token: string, method: string, params: object = {}) {
  const payload = { jsonrpc: '2.0', id: 1, method, params: { _meta: meta, ...params } };
  return f.app.inject({ method: 'POST', url: '/dot/mcp', headers: { authorization: `Bearer ${token}`,
    accept: 'application/json, text/event-stream', 'mcp-protocol-version': version, 'mcp-method': method,
    ...('name' in params ? { 'mcp-name': String(params.name) } : {}) }, payload });
}

test('Dot OAuth rejects wrong PKCE, audience, replay and revoked tokens; cannot access device or setup APIs', { timeout: 15000 }, async () => {
  const f = fixture();
  try {
    const auth = await authorize(f);
    assert.equal((await auth.exchange({ ...auth.grant, code_verifier: 'wrong'.repeat(12) })).statusCode, 400);
    assert.equal((await auth.exchange({ ...auth.grant, resource: 'https://other.example/dot/mcp' })).statusCode, 400);
    const token = await auth.exchange(auth.grant); assert.equal(token.statusCode, 200, token.body);
    const access = token.json().access_token;
    assert.equal((await auth.exchange(auth.grant)).statusCode, 400);
    assert.equal((await f.app.inject({ url: '/api/inbox', headers: { authorization: `Bearer ${access}` } })).statusCode, 401);
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/setup/dot/authorize', payload: { ticket: 'no' } })).statusCode, 401);
    assert.equal((await rpc(f, config.deviceToken, 'server/discover')).statusCode, 401);
    const discovery = await rpc(f, access, 'server/discover');
    assert.equal(discovery.statusCode, 200); assert.deepEqual(discovery.json().result.capabilities.events, {});
    const metadata = await oauthRequest(f, '/.well-known/oauth-protected-resource/dot/mcp');
    assert.equal(metadata.json().resource, resource);
    f.dot.configure({ enabled: false });
    assert.equal((await rpc(f, access, 'tools/list')).statusCode, 404);
  } finally { await f.close(); }
});

test('refresh preserves the subscription but replaces the bearer token; MCP rejects mismatched headers', { timeout: 15000 }, async () => {
  const f = fixture();
  try {
    const auth = await connect(f);
    const refreshed = await auth.exchange({ client_id: auth.client, grant_type: 'refresh_token', refresh_token: auth.refresh_token, resource });
    assert.equal(refreshed.statusCode, 200, refreshed.body); assert.equal(f.dot.state().connected, true);
    assert.equal((await rpc(f, auth.access_token, 'tools/list')).statusCode, 401);
    const access = refreshed.json().access_token;
    const bad = await f.app.inject({ method: 'POST', url: '/dot/mcp', headers: { authorization: `Bearer ${access}`, 'mcp-protocol-version': version, 'mcp-method': 'tools/list' },
      payload: { jsonrpc: '2.0', id: 2, method: 'server/discover', params: { _meta: meta } } });
    assert.equal(bad.statusCode, 400); assert.equal(bad.json().error.code, -32020);
    const tools = await rpc(f, access, 'tools/list'); assert.equal(tools.json().result.tools.length, 4);
  } finally { await f.close(); }
});

test('signed verification gates readiness; an incorrect challenge never enables Dot', { timeout: 15000 }, async () => {
  let correct = false, deliveries = 0;
  const f = fixture(async (_url, body, headers) => {
    const event = new Webhook(signingSecret).verify(body, headers) as { type: string; challenge: string };
    assert.equal(event.type, 'verification'); deliveries++;
    return { status: 200, body: JSON.stringify({ challenge: correct ? event.challenge : 'wrong' }) };
  });
  try {
    const auth = await authorize(f); await auth.exchange(auth.grant);
    await assert.rejects(f.dot.subscribe(auth.client, { ...subscription, arguments: { conversation_id: 'grok' } }));
    assert.equal(deliveries, 0);
    await assert.rejects(f.dot.subscribe(auth.client, subscription), /verification failed/);
    assert.equal(f.dot.state().connected, false);
    correct = true; await f.dot.subscribe(auth.client, subscription); assert.equal(f.dot.state().connected, true);
    await f.dot.subscribe(auth.client, subscription); assert.equal(deliveries, 2);
  } finally { await f.close(); }
});

test('voice dispatch works with Herdr offline; fast reply and duplicate callbacks create one inbox item', { timeout: 15000 }, async () => {
  let events = 0;
  const f = fixture(async (_url, body, headers) => {
    const event = new Webhook(signingSecret).verify(body, headers) as { type?: string; data: { request_id: string; text: string } };
    if (!event.type) { events++; assert.equal(event.data.text, 'Hello from my watch'); f.dot.call('reply_to_maestro', { request_id: event.data.request_id, text: 'Hello, Max.' }); }
    return { status: 200, body };
  });
  try {
    await connect(f); const id = randomUUID();
    await f.service.submit(id, 'dot', Buffer.alloc(32000)); await f.service.drain(); await f.dot.flush();
    assert.equal(f.store.get(id)?.state, 'done'); assert.equal(events, 1);
    f.dot.call('reply_to_maestro', { request_id: id, text: 'Hello, Max.' });
    assert.equal(f.store.inbox.status().counts[0]?.unread, 1);
    assert.throws(() => f.dot.call('reply_to_maestro', { request_id: id, text: 'A changed answer' }), /already has/);
    const other = randomUUID(); f.store.create(other, other, { ...f.dot.target()!, id: 'other', provider: 'grok' }, 'Private');
    assert.throws(() => f.dot.call('get_dot_message', { request_id: other }), /not found/);
    assert.throws(() => f.dot.call('reply_to_maestro', { request_id: other, text: 'No' }), /not found/);
  } finally { await f.close(); }
});

test('lost acknowledgement is retried after restart with the same signed event ID and a late reply still completes', { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'maestro-dot-')), path = join(dir, 'db.sqlite');
  const received: string[] = [];
  const post: WebhookPost = async (_url, body, headers) => {
    const event = new Webhook(signingSecret).verify(body, headers) as { type?: string; eventId: string };
    if (event.type) return { status: 200, body };
    received.push(event.eventId); throw new Error('Acknowledgement lost');
  };
  let f = fixture(post, path);
  try {
    await connect(f); const id = randomUUID(); await f.service.submit(id, 'dot', 'Remember this'); await f.dot.flush();
    await f.close(); f = fixture(post, path); f.store.recover();
    f.store.db.exec('UPDATE dot_outbox SET next=0'); await f.dot.flush();
    assert.deepEqual(received, [id, id]);
    assert.equal(f.store.get(id)?.state, 'uncertain');
    f.dot.call('reply_to_maestro', { request_id: id, text: 'Remembered.' }); await f.dot.flush();
    assert.equal(f.store.get(id)?.state, 'done'); assert.equal(received.length, 2);
  } finally { await f.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('outside updates preserve the active turn; delayed replies and disconnect never stay stuck working', { timeout: 15000 }, async () => {
  const f = fixture();
  try {
    await connect(f); const id = randomUUID(); await f.service.submit(id, 'dot', 'A long task'); await f.dot.flush();
    const update = { update_id: randomUUID(), text: 'Your other task finished.' };
    f.dot.call('notify_maestro', update); f.dot.call('notify_maestro', update);
    assert.equal(f.store.get(id)?.state, 'working'); assert.equal(f.store.inbox.status().counts[0]?.unread, 1);
    f.store.db.prepare('UPDATE turns SET updated=? WHERE id=?').run(Date.now() - 601000, id);
    assert.equal(f.store.get(id)?.state, 'uncertain');
    f.dot.call('reply_to_maestro', { request_id: id, text: 'Finished.' }); assert.equal(f.store.get(id)?.state, 'done');
    const pending = randomUUID(); await f.service.submit(pending, 'dot', 'Another task');
    f.dot.configure({ enabled: false }); assert.equal(f.store.get(pending)?.state, 'uncertain');
    assert.equal(f.dot.target(), undefined);
  } finally { await f.close(); }
});

test('callbacks reject private addresses, redirect destinations and lookalike domains', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '::1', '::ffff:127.0.0.1', 'fe80::1', 'fc00::1', '0.0.0.0']) assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress('8.8.8.8'), true);
  for (const url of ['http://chatgpt.com/callback', 'https://chatgpt.com.evil.example/callback', 'https://evilchatgpt.com', 'https://127.0.0.1', 'https://user:pass@chatgpt.com', 'https://chatgpt.com:8080']) assert.throws(() => callbackUrl(url));
});

test('disconnect during callback verification cannot reactivate access', { timeout: 15000 }, async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(async (_url, body) => { await gate; return { status: 200, body }; });
  try {
    const auth = await authorize(f); await auth.exchange(auth.grant);
    const pending = f.dot.subscribe(auth.client, subscription);
    f.dot.configure({ enabled: false }); release();
    await assert.rejects(pending, /disconnected/);
    assert.equal(f.dot.state().connected, false);
  } finally { release(); await f.close(); }
});

test('an expired delivery is not sent hours later when the subscription returns', { timeout: 15000 }, async () => {
  let events = 0;
  const f = fixture(async (_url, body) => {
    if (!JSON.parse(body).type) { events++; return { status: 503, body: '' }; }
    return { status: 200, body };
  });
  try {
    await connect(f); const id = randomUUID(); await f.service.submit(id, 'dot', 'Do this now'); await f.dot.flush();
    assert.equal(events, 1);
    f.store.db.prepare('UPDATE turns SET created=?,updated=? WHERE id=?').run(Date.now() - 601000, Date.now() - 601000, id);
    f.store.db.exec('UPDATE dot_outbox SET next=0'); await f.dot.flush();
    assert.equal(events, 1); assert.equal(f.store.get(id)?.state, 'uncertain');
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM dot_outbox').get()?.n, 0);
  } finally { await f.close(); }
});
