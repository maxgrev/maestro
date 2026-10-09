import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchingReply } from '../src/codex-reply.js';

test('only a completed final answer for the exact recent input is eligible for speech', () => {
  const turn = { status: 'completed', startedAt: 100, items: [
    { type: 'userMessage', content: [{ type: 'text', text: 'What is next?' }] },
    { type: 'agentMessage', phase: 'commentary', text: 'I will check.' },
    { type: 'agentMessage', phase: 'final_answer', text: 'Your next meeting is at three.' },
  ] };
  assert.deepEqual(matchingReply([turn], 'What is next?', 100000), ['Your next meeting is at three.']);
  assert.deepEqual(matchingReply([turn], 'Different request', 100000), []);
  assert.deepEqual(matchingReply([{ ...turn, status: 'inProgress' }], 'What is next?', 100000), []);
  assert.deepEqual(matchingReply([{ ...turn, startedAt: 99 }], 'What is next?', 100000), []);
  assert.deepEqual(matchingReply([{ ...turn, startedAt: undefined }], 'What is next?', 100000), []);
});
