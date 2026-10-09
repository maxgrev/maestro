import test from 'node:test';
import assert from 'node:assert/strict';
import { finalReply, piMessages, captureReply, type ReplyMessage } from '../src/agent-reply.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { matchingReply } from '../src/codex-reply.js';
const msg = (id: string, role: string, text: string, stop?: string): ReplyMessage => ({ id, role, message: { role, content: [{type:'text',text}], stopReason:stop } });

test('repeated prompts cannot replay an earlier answer, thinking, or an unfinished answer', () => {
  const old = [msg('u1','user','Hello'),msg('a1','assistant','Old answer','stop')];
  const before = new Set(old.map(m=>m.id));
  const fresh = [...old,msg('u2','user','Hello'),msg('a2','assistant','Working','toolUse')];
  assert.equal(finalReply(old,before,'Hello'),undefined);
  assert.equal(finalReply(fresh,before,'Hello'),undefined);
  fresh.push(msg('tool','toolResult','Some tool output'));
  fresh.push({id:'final',role:'assistant',message:{stop_reason:'end_turn',content:[{type:'thinking',thinking:'Private reasoning'},{type:'text',text:'Complete answer'}]}});
  assert.equal(finalReply(fresh,before,'Hello'),'Complete answer');
  assert.equal(finalReply(fresh,before,'Different input'),undefined);
  fresh.push(msg('u3','user','Another request'),msg('a3','assistant','Other reply','stop'));
  assert.equal(finalReply(fresh,before,'Hello'),undefined);
});

test('Claude speaks every text block in the final generation, excluding earlier tool narration', () => {
  const messages: ReplyMessage[] = [msg('u','user','Hello'),
    {id:'work',role:'assistant',message:{id:'model-1',content:[{type:'text',text:'Let me check.'}],stop_reason:'tool_use'}},
    msg('tool','user',''),
    {id:'part-1',role:'assistant',message:{id:'model-2',content:[{type:'text',text:'First part.'}],stop_reason:null}},
    {id:'part-2',role:'assistant',message:{id:'model-2',content:[{type:'text',text:'Second part.'}],stop_reason:'end_turn'}},
  ];
  assert.equal(finalReply(messages,new Set(),'Hello'),'First part.\n\nSecond part.');
});

test('Pi follows the current branch, ignoring abandoned replies and failing on missing parents', () => {
  const entries = [
    {type:'session',id:'session',version:3},
    {type:'message',id:'user',parentId:null,message:{role:'user',content:'Hello'}},
    {type:'message',id:'abandoned',parentId:'user',message:{role:'assistant',content:'Wrong branch',stopReason:'stop'}},
    {type:'message',id:'final',parentId:'user',message:{role:'assistant',content:'Active answer',stopReason:'stop'}},
  ];
  assert.equal(finalReply(piMessages(entries),new Set(),'Hello'),'Active answer');
  assert.throws(()=>piMessages([...entries,{type:'message',id:'broken',parentId:'missing'}]),/Incomplete/);
  assert.throws(()=>piMessages([{type:'session',id:'s',version:4}]),/Unsupported/);
});

test('a new Pi session can capture its first reply before the transcript exists', async () => {
  const dir=await mkdtemp(join(tmpdir(),'maestro-pi-')),path=join(dir,'new-session.jsonl');
  try {
    const read=await captureReply({agent:'pi',agent_status:'idle',terminal_id:'test',pane_id:'test',agent_session:{kind:'path',value:path}},async()=>({}));
    assert.equal(await read('Hello',0),undefined);
    await writeFile(path,[{type:'session',version:3,id:'s'},
      {type:'message',id:'u',parentId:null,message:{role:'user',content:'Hello'}},
      {type:'message',id:'a',parentId:'u',message:{role:'assistant',content:[{type:'text',text:'First complete reply'}],stopReason:'stop'}},
    ].map(x=>JSON.stringify(x)).join('\n')+'\n');
    assert.equal(await read('Hello',0),'First complete reply');
    await writeFile(path,'{"unfinished":', {flag:'a'});
    assert.equal(await read('Hello',0),'First complete reply');
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('Codex excludes already-seen turns even with the same text and timestamp', () => {
  const turn = {id:'previous',status:'completed',startedAt:100,items:[
    {type:'userMessage',content:[{type:'text',text:'Hello'}]},
    {type:'agentMessage',phase:'final_answer',text:'Previous answer'},
  ]};
  assert.deepEqual(matchingReply([turn], 'Hello', 100000, new Set(['previous'])), []);
  assert.deepEqual(matchingReply([{...turn,id:'current'}], 'Hello', 100000, new Set(['previous'])), ['Previous answer']);
});

test('a fresh Codex pane can bind after its first prompt, but cannot read a replacement pane', async () => {
  const agent = {agent:'codex',agent_status:'idle',terminal_id:'original',pane_id:'test'};
  let calls = 0;
  const reader = await captureReply(agent, async () => {
    calls++;
    return {agent:{...agent,terminal_id:'replacement'}};
  }, '/unused', true);
  assert.equal(calls, 0, 'Codex has no native thread before the first prompt');
  await assert.rejects(reader('Hello',Date.now()), /session changed/);
  assert.equal(calls, 1);
});
