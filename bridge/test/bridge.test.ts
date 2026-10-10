import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/config.js';
import { Store } from '../src/store.js';
import { Herdr } from '../src/herdr.js';
import { Service } from '../src/service.js';
import { buildServer } from '../src/server.js';
import type { SpeechEngine } from '../src/speech.js';

const config: Config = {
  deviceToken: 'a'.repeat(64), host: '127.0.0.1', port: 4211, localPort: 4210, remotePort: 4212,
  herdr: { binary: '/unused', session: 'test' }, projects: [], agents: ['codex'],
  speech: { whisper: '/unused', model: '/unused', ffmpeg: '/unused', voice: 'Samantha' },
  grok: { name: 'Daily assistant', webhook: 'https://example.com/hook', key: 'secret', replyKey: 'b'.repeat(64) },
};
const speech: SpeechEngine = { transcribe: async () => 'Read my calendar.', speak: async () => Buffer.from([0, 0, 1, 0]) };
function fixture(fetcher: typeof fetch = async () => new Response('{}')) {
  const store = new Store(':memory:');
  const herdr = new Herdr(config, async () => ({ agents: [] }));
  const service = new Service(config, store, herdr, { ...speech }, fetcher);
  return { store, service, app: buildServer(service) };
}
const auth = { authorization: `Bearer ${config.deviceToken}` };

test('device reply wait returns a completed callback without waiting for its timeout', async () => {
  const f = fixture(), id = randomUUID();
  await f.service.submit(id, 'grok', 'Latency check');
  await f.service.drain();
  const started = Date.now();
  const waiting = f.app.inject({ method: 'GET', url: `/api/turns/${id}?wait=5000`, headers: auth });
  const callback = setTimeout(() => f.service.reply(id, 'Ready.', false), 40);
  try {
    const result = await waiting;
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().reply, 'Ready.');
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.ok(Date.now() - started < 3000);
    assert.equal((await f.app.inject({ method: 'GET', url: `/api/turns/${id}?wait=6000`, headers: auth })).statusCode, 400);
    assert.equal((await f.app.inject(`/api/turns/${id}?wait=5000`)).statusCode, 401);
  } finally { clearTimeout(callback); await f.app.close(); f.store.close(); }
});

test('speech receives the full reply beyond the old 1800-character cutoff', async () => {
  const f=fixture();let spoken='';
  f.service.speech.speak=async text=>{spoken=text;return Buffer.from([0,0,1,0]);};
  const text='A complete sentence. '.repeat(100)+'The final sentence matters.';
  const response=await f.app.inject({method:'POST',url:'/api/speech',headers:auth,payload:{text,format:'pcm'}});
  assert.equal(response.statusCode,200);assert.equal(spoken,text);
  await f.app.close();f.store.close();
});

test('simultaneous duplicate submissions invoke the upstream webhook only once', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return new Response('{}'); });
  const id = randomUUID();
  const results = await Promise.all(Array.from({ length: 8 }, () => f.app.inject({ method: 'POST', url: '/api/turns', headers: auth, payload: { id, target: 'grok', text: 'Read my calendar.' } })));
  await f.service.drain();
  assert.deepEqual(results.map(r => r.statusCode), Array(8).fill(202));
  assert.equal(calls, 1);
  assert.equal(f.store.get(id)?.state, 'working');
  const conflict = await f.app.inject({ method: 'POST', url: '/api/turns', headers: auth, payload: { id, target: 'grok', text: 'Different action' } });
  assert.equal(conflict.statusCode, 409);
  await f.app.close(); f.store.close();
});

test('a lost webhook acknowledgment is uncertain and replaying the same request never resends it', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; throw new Error('socket closed after server accepted body'); });
  const id = randomUUID();
  await f.service.submit(id, 'grok', 'A request');
  await f.service.drain();
  assert.equal(f.store.get(id)?.state, 'uncertain');
  assert.equal((await f.service.submit(id, 'grok', 'A request')).state, 'uncertain');
  assert.equal(calls, 1);
  await f.app.close(); f.store.close();
});

test('authenticated callback can finish a request before the webhook acknowledgment arrives', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(async () => { await gate; return new Response('{}'); });
  const id = randomUUID();
  await f.service.submit(id, 'grok', 'Read calendar');
  assert.equal(f.store.get(id)?.state, 'dispatching');
  const callback = { method: 'POST' as const, url: '/api/grok/reply', payload: { request_id: id, text: 'You have two meetings.' } };
  assert.equal((await f.app.inject({ ...callback, headers: auth })).statusCode, 401);
  assert.equal((await f.app.inject({ ...callback, headers: { authorization: `Bearer ${config.grok!.replyKey}` } })).statusCode, 200);
  release(); await f.service.drain();
  assert.equal(f.store.get(id)?.state, 'done');
  assert.equal(f.service.reply(id, 'You have two meetings.', false).state, 'done');
  assert.throws(() => f.service.reply(id, 'Changed reply', false), /already has a result/);
  await f.app.close(); f.store.close();
});

test('restart preserves receipts and never marks interrupted work as complete', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maestro-test-'));
  try {
    const path = join(dir, 'receipt.sqlite');
    let store = new Store(path);
    const target = { id: 'grok', name: 'Bot', provider: 'grok' as const, detail: '', available: true, status: 'ready' };
    const first = randomUUID(), second = randomUUID();
    store.create(first, 'hash1', target, 'sent'); store.update(first, { state: 'working' });
    store.create(second, 'hash2', { ...target, id: 'other' }, 'not sent');
    store.close(); store = new Store(path); store.recover();
    assert.equal(store.get(first)?.state, 'uncertain');
    assert.equal(store.get(second)?.state, 'failed');
    assert.equal(store.existing(first, 'hash1')?.text, 'sent');
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a busy conversation stays reserved after it leaves the recent activity window', () => {
  const store = new Store(':memory:');
  const target = { id: 'grok', name: 'Bot', provider: 'grok' as const, detail: '', available: true, status: 'ready' };
  const active = randomUUID();
  store.create(active, 'active', target, 'Long task');
  store.update(active, { state: 'working' });
  store.db.prepare('UPDATE turns SET created=0 WHERE id=?').run(active);
  for (let n = 0; n < 51; n++) {
    const id = randomUUID();
    store.create(id, id, { ...target, id: `other-${n}` }, 'Done');
    store.update(id, { state: 'done' });
  }
  assert.equal(store.list().some(t => t.id === active), false);
  assert.throws(() => store.create(randomUUID(), 'later', target, 'Another task'), /in progress/);
  store.close();
});

test('an upstream server error does not imply that a Grok action was never started', async () => {
  const f = fixture(async () => new Response('{}', { status: 503 }));
  const id = randomUUID();
  await f.service.submit(id, 'grok', 'A request'); await f.service.drain();
  assert.equal(f.store.get(id)?.state, 'uncertain');
  assert.equal(f.service.reply(id, 'A late successful reply', false).state, 'done');
  await f.app.close(); f.store.close();
});

test('replaced or blocked Herdr sessions are never sent input', async () => {
  const agent = { terminal_id: 'terminal-1', pane_id: 'w1:p1', agent: 'codex', name: 'notes', agent_status: 'idle', agent_session: { value: 'session-1' } };
  let current = { ...agent }, prompts = 0;
  const herdr = new Herdr(config, async args => {
    if (args[1] === 'list') return { agents: [current] };
    if (args[1] === 'get') return { agent: current };
    prompts++; return { agent: current };
  });
  const target = (await herdr.targets())[0]!;
  current = { ...agent, agent_session: { value: 'session-2' } };
  await assert.rejects(herdr.prompt(target, 'hello'), /session changed/);
  current = { ...agent, agent_status: 'blocked' };
  await assert.rejects(herdr.prompt(target, 'hello'), /attention/);
  assert.equal(prompts, 0);
});

test('device auth, callback auth, audio validation, and local origin checks fail closed', async () => {
  const f = fixture();
  assert.equal((await f.app.inject('/api/turns')).statusCode, 401);
  const bad = await f.app.inject({ method: 'POST', url: `/api/voice?id=${randomUUID()}&target=grok`, headers: { ...auth, 'content-type': 'audio/pcm' }, payload: Buffer.alloc(11) });
  assert.equal(bad.statusCode, 400);
  assert.equal(f.store.list().length, 0);
  const local = buildServer(f.service, { local: true });
  assert.equal((await local.inject({ url: '/api/health', headers: { host: 'evil.example:4210' } })).statusCode, 403);
  assert.equal((await local.inject({ url: '/api/health', headers: { host: 'localhost:4210', origin: 'https://evil.example' } })).statusCode, 403);
  assert.equal((await local.inject({ url: '/api/health', headers: { host: 'localhost:4210' } })).statusCode, 200);
  await local.close(); await f.app.close(); f.store.close();
});

test('voice is transcribed once and the request remains tied to its selected agent', async () => {
  let sent: Record<string, string> | undefined;
  const f = fixture(async (_url, init) => { sent = JSON.parse(init!.body as string); return new Response('{}'); });
  const id = randomUUID();
  await f.service.submit(id, 'grok', Buffer.alloc(32000));
  await f.service.drain();
  assert.deepEqual(sent, { request_id: id, message: 'Read my calendar.', history: [] });
  assert.equal(f.store.get(id)?.target.id, 'grok');
  await f.app.close(); f.store.close();
});

test('Grok follow-ups survive restart and unrelated activity without replaying unfinished work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'maestro-history-'));
  const path = join(dir, 'receipts.sqlite');
  let store = new Store(path);
  try {
    const target = { id: 'grok', name: 'Bot', provider: 'grok' as const, detail: '', available: true, status: 'ready' };
    const first = randomUUID(), second = randomUUID(), uncertain = randomUUID();
    store.create(first, first, target, 'Remember sequoia');
    store.update(first, { state: 'done', reply: 'Remembered.' });
    store.create(second, second, target, 'Which appointment?');
    store.update(second, { state: 'needs_attention', reply: 'What date?' });
    store.create(uncertain, uncertain, target, 'An unconfirmed action');
    store.update(uncertain, { state: 'uncertain' });
    for (let i = 0; i < 60; i++) {
      const id = randomUUID();
      store.create(id, id, { ...target, id: 'another-agent' }, 'Unrelated private message');
      store.update(id, { state: 'done', reply: 'Unrelated answer' });
    }
    store.close(); store = new Store(path);
    let sent: unknown;
    const service = new Service(config, store, new Herdr(config, async () => ({ agents: [] })), speech,
      async (_url, init) => { sent = JSON.parse(init!.body as string); return new Response('{}'); });
    const id = randomUUID();
    await service.submit(id, 'grok', 'What was the word?'); await service.drain();
    assert.deepEqual(sent, { request_id: id, message: 'What was the word?', history: [
      { request_id: first, message: 'Remember sequoia', reply: 'Remembered.', needs_attention: false },
      { request_id: second, message: 'Which appointment?', reply: 'What date?', needs_attention: true },
    ] });
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Grok context keeps recent complete exchanges within its size bound', () => {
  const store = new Store(':memory:');
  try {
    const target = { id: 'grok', name: 'Bot', provider: 'grok' as const, detail: '', available: true, status: 'ready' };
    for (let i = 0; i < 15; i++) {
      const id = randomUUID();
      store.create(id, id, target, `question-${i}`);
      store.update(id, { state: 'done', reply: 'x'.repeat(10_000) });
    }
    assert.deepEqual(store.conversationHistory('grok').map(t => t.message), ['question-13', 'question-14']);
    store.db.prepare("UPDATE turns SET reply='short'").run();
    assert.equal(store.conversationHistory('grok').length, 12);
  } finally { store.close(); }
});

test('a missing Grok callback expires without a resend and a late reply still completes it', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return new Response('{}'); });
  const id = randomUUID();
  await f.service.submit(id, 'grok', 'Test delayed reply'); await f.service.drain();
  f.store.db.prepare('UPDATE turns SET updated=? WHERE id=?').run(Date.now() - 121_000, id);
  assert.equal(f.store.get(id)?.state, 'uncertain');
  assert.match(f.store.get(id)!.error, /do not resend/);
  await f.service.submit(id, 'grok', 'Test delayed reply');
  assert.equal(calls, 1);
  const late = f.service.reply(id, 'The reply arrived.', false);
  assert.equal(late.state, 'done'); assert.equal(late.error, '');
  await f.app.close(); f.store.close();
});

test('Grok submission succeeds even when coding-agent discovery cannot return', async () => {
  const f = fixture();
  f.service.herdr.targets = () => { throw new Error('Coding sessions offline'); };
  try {
    const id = randomUUID();
    const response = await f.app.inject({ method: 'POST', url: '/api/turns', headers: auth, payload: { id, target: 'grok', text: 'Hello' } });
    assert.equal(response.statusCode, 202);
    await f.service.drain();
    assert.equal(f.store.get(id)?.state, 'working');
  } finally { await f.app.close(); f.store.close(); }
});

test('external Grok receipts use callback authority, deduplicate, and cannot read or acknowledge inbox data', async () => {
  const f=fixture(), callback={authorization:`Bearer ${config.grok!.replyKey}`};
  const payload={request_id:randomUUID(),text:'Work started outside Maestro has finished.'};
  assert.equal((await f.app.inject({method:'POST',url:'/api/grok/inbox',headers:auth,payload})).statusCode,401);
  for(let i=0;i<2;i++)assert.equal((await f.app.inject({method:'POST',url:'/api/grok/inbox',headers:callback,payload})).statusCode,200);
  const page=(await f.app.inject({url:'/api/inbox',headers:auth})).json();
  assert.equal(page.items.length,1);assert.equal(page.items[0].target.id,'grok');
  assert.equal((await f.app.inject({url:'/api/inbox',headers:callback})).statusCode,401);
  assert.equal((await f.app.inject({method:'POST',url:'/api/inbox/ack',headers:callback,payload:{ids:[page.items[0].id],kind:'read'}})).statusCode,401);
  assert.equal((await f.app.inject({method:'POST',url:'/api/inbox/ack',headers:auth,payload:{ids:[page.items[0].id],kind:'read'}})).statusCode,200);
  assert.deepEqual(f.store.inbox.status().alerts,[]);
  await f.app.close();f.store.close();
});

test('watch inbox reads are bounded at a UTF-8 boundary while the Mac retains the full answer',async()=>{
  const f=fixture(),text='界'.repeat(400);
  const item=f.store.inbox.add({key:'long',target:{id:'muse',name:'Muse'},reply:text})!;
  const limited=(await f.app.inject({url:`/api/inbox/${item.id}?maxBytes=1000`,headers:auth})).json();
  assert.equal(limited.truncated,true);assert.equal(limited.reply,'界'.repeat(333));
  const full=(await f.app.inject({url:`/api/inbox/${item.id}`,headers:auth})).json();assert.equal(full.reply,text);
  await f.app.close();f.store.close();
});
