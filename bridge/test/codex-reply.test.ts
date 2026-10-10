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

test('external Codex reads the final item without fetching an oversized image or tool history', async () => {
  const { readCodexFinal } = await import('../src/codex-reply.js');
  let calls=0;
  const reply=await readCodexFinal(async <T>(method:string,params:unknown):Promise<T>=>{
    calls++;
    assert.equal(method,'thread/items/list');
    assert.equal((params as {limit:number}).limit,1);
    assert.equal((params as {sortDirection:string}).sortDirection,'desc');
    if(calls>1)throw new Error('The preceding tool result is too large');
    return {data:[{item:{type:'agentMessage',phase:'final_answer',text:'The full answer. '.repeat(4000)}}],nextCursor:'huge-tool-result'} as T;
  },'thread','turn');
  assert.equal(reply,'The full answer. '.repeat(4000).trim());assert.equal(calls,1);
});
