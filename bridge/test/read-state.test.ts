import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { applyCodexReads } from '../src/read-state.js';
import { completedMessages, type ReplyMessage } from '../src/agent-reply.js';
import { Herdr } from '../src/herdr.js';
import type { Config } from '../src/config.js';

const id = '01234567-1234-4567-89ab-0123456789ab';
const source = `codex:${id}`;
const target = { id: source, name: 'Codex', detail: 'Fix the clock' };
const state = (ids: string[], identity = 'account') => ({ version: 1, unreadByIdentity: { [identity]: { 'local:mac': ids } } });

test('native read transitions clear only known older replies and survive observer restarts', () => {
  const store = new Store(':memory:'), inbox = store.inbox;
  try {
    const old = inbox.add({ key: `${source}:old`, target, reply: 'Old', created: 90 })!;
    applyCodexReads(inbox, state([]), 95); // Absence on first launch is not a read.
    assert.equal(inbox.get(old.id)?.read, false);
    applyCodexReads(inbox, state([id]), 100);
    applyCodexReads(inbox, state([],'another-account'), 105);
    applyCodexReads(inbox, { version: 2, unreadByIdentity: {} }, 108);
    assert.equal(inbox.get(old.id)?.read, false);
    const newer = inbox.add({ key: `${source}:new`, target, reply: 'New', created: 110 })!;
    applyCodexReads(inbox, state([]), 120);
    assert.equal(inbox.get(old.id)?.read, true);
    assert.equal(inbox.get(newer.id)?.read, false);
    const late = inbox.add({ key: `${source}:late`, target, reply: 'Late old discovery', created: 99 })!;
    assert.equal(inbox.get(late.id)?.read, true);
    inbox.add({ key: `${source}:old`, target, reply: 'Duplicate' });
    assert.deepEqual(inbox.status().alerts.map(row => row.id), [newer.id]);
    assert.equal(inbox.get(old.id)?.read, true);
  } finally { store.close(); }
});

test('a user follow-up reads earlier Claude/Pi answers; a tool result does not', () => {
  const messages: ReplyMessage[] = [
    { id: 'u', role: 'user', message: { content: 'Hello' } },
    { id: 'a', role: 'assistant', message: { content: 'First', stop_reason: 'end_turn' } },
    { id: 'tool', role: 'user', message: { content: [{ type: 'tool_result', content: 'Command result' }] } },
  ];
  assert.equal(completedMessages(messages)[0]?.read, false);
  messages.push({ id: 'u2', role: 'user', message: { content: 'Thanks, continue' } },
    { id: 'a2', role: 'assistant', message: { content: 'Second', stopReason: 'stop' } });
  assert.deepEqual(completedMessages(messages).map(r => [r.reply, r.read]), [['First', true], ['Second', false]]);
  const store = new Store(':memory:');
  try {
    const old = store.inbox.add({ key: 'claude:s:a', target, reply: 'First' })!;
    store.inbox.readSources(['claude:s:a']);
    store.inbox.add({ key: 'claude:s:a2', target, reply: 'Second' });
    assert.equal(store.inbox.get(old.id)?.read, true);
    assert.equal(store.inbox.status().alerts.length, 1);
  } finally { store.close(); }
});

test('agent names and chat subtitles remain separate, without a project-path fallback', async () => {
  const herdr = new Herdr({} as Config, async () => ({ agents: [
    { terminal_id: 't', pane_id: '1', agent: 'codex', agent_status: 'idle', terminal_title_stripped: '✦ Fix the clock | Codex', cwd: '/project' },
    { terminal_id: 't', pane_id: '2', agent: 'pi', agent_status: 'idle', title: '/project', cwd: '/project' },
  ] }));
  assert.deepEqual((await herdr.sessions()).map(s => [s.target.name, s.target.detail]), [['Codex', 'Fix the clock'], ['Pi', '']]);
  const store = new Store(':memory:');
  try {
    const receipt = store.inbox.add({ key: `${source}:old`, target: { ...target, name: 'Codex / Old', detail: '/old/path' }, reply: 'Keep this' })!;
    store.inbox.describeSource(source, target);
    assert.deepEqual(store.inbox.get(receipt.id)?.target, target);
    assert.equal(store.inbox.get(receipt.id)?.reply, 'Keep this');
  } finally { store.close(); }
});
