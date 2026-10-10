import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';

const target = { id: 'dot', name: 'Dot', provider: 'dot' as const, detail: '', status: 'ready', available: true };

test('a reply wakes only its own waiters, after durable completion', async () => {
  const store = new Store(':memory:');
  try {
    const a = randomUUID(), b = randomUUID();
    store.create(a, a, target, 'First');
    store.create(b, b, { ...target, id: 'another' }, 'Second');
    let arrived = false;
    const waiting = store.waitForReply(a, 5000).then(turn => { arrived = true; return turn; });
    store.update(b, { state: 'done', reply: 'Unrelated answer' });
    store.update(a, { state: 'working' });
    await Promise.resolve();
    assert.equal(arrived, false);
    store.update(a, { state: 'done', reply: 'Full answer' });
    assert.equal((await waiting)?.reply, 'Full answer');
    assert.equal((await store.waitForReply(a, 5000))?.state, 'done');
    assert.equal(store.inbox.page(undefined, target.id).items[0]?.reply, 'Full answer');
  } finally { store.close(); }
});

test('reply waits end on timeout, disconnect, error and shutdown without losing a turn', async () => {
  const store = new Store(':memory:');
  const id = randomUUID();
  store.create(id, id, target, 'Request');
  assert.equal((await store.waitForReply(id, 1))?.state, 'queued');
  const abort = new AbortController();
  const disconnected = store.waitForReply(id, 5000, abort.signal);
  abort.abort();
  assert.equal((await disconnected)?.state, 'queued');
  const failed = store.waitForReply(id, 5000);
  store.update(id, { state: 'failed', error: 'Unavailable' });
  assert.equal((await failed)?.error, 'Unavailable');
  const next = randomUUID();
  store.create(next, next, target, 'Next');
  const closing = store.waitForReply(next, 5000);
  store.close();
  assert.equal((await closing)?.state, 'queued');
});
