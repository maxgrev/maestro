import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { Observer } from '../src/observe.js';
import { Herdr } from '../src/herdr.js';
import { completedMessages, messageReplyKey, piMessages } from '../src/agent-reply.js';
import type { Config } from '../src/config.js';
const a = { id:'claude:chat',name:'Claude / First',character:'claude' as const };
const b = { id:'codex:chat',name:'Codex / Second',character:'codex' };

test('parallel replies survive restart; read and vibration acknowledgements never clear later arrivals', () => {
  const dir=mkdtempSync(join(tmpdir(),'maestro-inbox-')),path=join(dir,'store.sqlite');
  let store=new Store(path);
  try {
    const first=store.inbox.add({key:'a1',target:a,reply:'A complete answer'} )!;
    const second=store.inbox.add({key:'b1',target:b,reply:'Another complete answer'})!;
    const third=store.inbox.add({key:'b2',target:b,reply:'Needs a choice',attention:true})!;
    store.inbox.acknowledge([first.id,second.id],'alert');
    store.inbox.acknowledge([first.id],'read');
    store.close();store=new Store(path);
    assert.equal(store.inbox.get(first.id)?.read,true);
    assert.equal(store.inbox.get(second.id)?.read,false);
    assert.deepEqual(store.inbox.status().alerts.map(x=>x.id),[third.id]);
    assert.deepEqual(store.inbox.status().counts.map(x=>[x.target,x.unread,x.attention]),[[b.id,2,1]]);
    assert.equal(store.inbox.page(undefined,a.id).items[0]?.reply,'A complete answer');
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('native and Maestro receipts coalesce even when the native observer arrives first', () => {
  const store=new Store(':memory:');
  try {
    const receipt=store.inbox.add({key:'claude:same:model-answer',target:a,reply:'Answer'})!;
    store.inbox.acknowledge([receipt.id],'read');
    const turn=randomUUID();
    const target={...a,id:'herdr:pane',detail:'',provider:'herdr' as const,status:'idle',available:true};
    store.create(turn, 'fingerprint',target,'Question');
    store.update(turn,{state:'done',reply:'Answer',sourceKey:'claude:same:model-answer'});
    assert.equal(store.inbox.page().items.length,1);
    assert.equal(store.inbox.get(receipt.id)?.target.id,target.id);
    assert.equal(store.inbox.get(receipt.id)?.turn,turn);
    assert.equal(store.inbox.get(receipt.id)?.read,true);
  } finally {store.close();}
});

test('pagination preserves older replies while newer replies arrive', () => {
  const store=new Store(':memory:');
  try {
    for(let i=0;i<43;i++)store.inbox.add({key:String(i),target:a,reply:'Reply '+i});
    const first=store.inbox.page();
    store.inbox.add({key:'new',target:b,reply:'New arrival'});
    const second=store.inbox.page(first.next!);const third=store.inbox.page(second.next!);
    assert.equal(new Set([...first.items,...second.items,...third.items].map(x=>x.source)).size,43);
    assert.equal(third.next,null);
    assert.equal(store.inbox.page().items[0]?.source,'new');
  } finally {store.close();}
});

test('external observation baselines old history but collects new finals and offline completions once', () => {
  const store=new Store(':memory:');
  try {
    const epoch=Date.now();store.inbox.saveCursor('started',epoch);
    const observer=new Observer({} as Config,store.inbox,{} as Herdr);
    observer.accept('source',1,a,[{key:'old',reply:'Old history',at:epoch-1},{key:'baseline',reply:'No timestamp'}]);
    observer.accept('source',2,a,[{key:'old',reply:'Old history',at:epoch-1},{key:'baseline',reply:'No timestamp'},
      {key:'live',reply:'Fresh final',at:epoch+1}]);
    const restart=new Observer({} as Config,store.inbox,{} as Herdr);
    restart.accept('source',3,a,[{key:'live',reply:'Fresh final',at:epoch+1},{key:'offline',reply:'Finished offline',at:epoch+2}]);
    restart.accept('new-chat',4,b,[{key:'new-chat-final',reply:'New external chat',at:epoch+3}]);
    assert.deepEqual(store.inbox.page().items.map(x=>x.reply),['New external chat','Finished offline','Fresh final']);
  } finally {store.close();}
});

test('external Pi and Claude finals exclude tools, thought blocks, partial messages and abandoned branches', () => {
  const messages=piMessages([{type:'session',id:'s',version:3},
    {type:'message',id:'u',parentId:null,message:{role:'user',content:'Hello'}},
    {type:'message',id:'abandoned',parentId:'u',message:{role:'assistant',content:'Abandoned',stopReason:'stop'}},
    {type:'message',id:'tool',parentId:'u',message:{role:'assistant',content:'Tool narration',stopReason:'toolUse'}},
    {type:'message',id:'p1',parentId:'tool',message:{id:'m',role:'assistant',content:[{type:'text',text:'First'},{type:'thinking',thinking:'secret'}]}},
    {type:'message',id:'p2',parentId:'p1',message:{id:'m',role:'assistant',content:[{type:'text',text:'Second'}],stop_reason:'end_turn'}},
    {type:'message',id:'partial',parentId:'p2',message:{role:'assistant',content:'Incomplete'}},
  ]);
  const found=completedMessages(messages);
  assert.deepEqual(found.map(x=>x.reply),['First\n\nSecond']);
  assert.equal(messageReplyKey('claude','/sessions/session.jsonl',found[0]!.message),'claude:session:m');
});
