import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { Conversations } from '../src/conversations.js';
import { Service } from '../src/service.js';
import { Herdr,type Agent } from '../src/herdr.js';
import { Observer } from '../src/observe.js';
import { buildServer } from '../src/server.js';
import type { Config } from '../src/config.js';
import type { Target } from '../src/types.js';
import type { SpeechEngine } from '../src/speech.js';

const config: Config = { deviceToken:'x'.repeat(64),host:'127.0.0.1',port:4211,localPort:4210,remotePort:4212,
  herdr:{binary:'/unused',session:'test'},projects:[],agents:[],speech:{whisper:'/unused',model:'/unused',ffmpeg:'/unused',voice:'Samantha'} };
const speech: SpeechEngine = { transcribe:async()=>'',speak:async()=>Buffer.alloc(0) };
const source = 'codex:'+randomUUID();
const saved = { id:source,session:source,name:'Codex',detail:'USB reconnect',character:'codex' as const,cwd:'/workspace' };
const live: Target = { ...saved,id:'herdr:new-pane:identity',provider:'herdr',available:true,status:'idle',pane:'pane',identity:'identity' };

test('history belongs to a conversation, survives a pane reconnect, and is not limited by global activity', () => {
  const store=new Store(':memory:'), conversations=new Conversations(store);
  try {
    for(let i=0;i<45;i++)store.inbox.add({key:source+':'+i,target:saved,text:'Question '+i,reply:'Answer '+i,created:100});
    for(let i=0;i<70;i++) {
      const target={...live,id:'other',session:'other'},id=randomUUID();
      store.create(id,'fingerprint-'+i,target,'Other question');store.update(id,{state:'done',reply:'Other answer'});
    }
    const first=conversations.history(source),second=conversations.history(source,first.next!);
    const entries=[...second.entries,...first.entries];
    assert.equal(entries.length,45);assert.equal(new Set(entries.map(entry=>entry.id)).size,45);
    assert.ok(entries.every(entry=>entry.text.startsWith('Question ')));assert.equal(second.next,null);
    const list=conversations.list([live]);
    assert.equal(list.filter(chat=>chat.id===source).length,1);
    assert.equal(list.find(chat=>chat.id===source)?.target?.id,live.id);
    assert.equal(list.find(chat=>chat.id===source)?.connection,'ready');
    assert.throws(()=>conversations.history(source,'not-a-page'),/history page/);
  } finally {store.close();}
});

test('native receipts and Maestro exchanges appear once; reading visible receipts leaves later arrivals unread', () => {
  const store=new Store(':memory:'),conversations=new Conversations(store);
  try {
    const receipt=store.inbox.add({key:source+':native-answer',target:saved,reply:'The answer'})!;
    const id=randomUUID();store.create(id,'fingerprint',live,'The question');
    store.update(id,{state:'done',reply:'The answer',sourceKey:source+':native-answer'});
    const page=conversations.history(source);
    assert.equal(page.entries.length,1);assert.equal(page.entries[0]?.text,'The question');
    assert.deepEqual(page.entries[0]?.receipts,[receipt.id]);
    const latest=store.inbox.add({key:source+':later',target:saved,reply:'Arrived while reading'})!;
    store.inbox.acknowledge(page.entries.flatMap(entry=>entry.receipts),'read');
    assert.equal(store.inbox.get(latest.id)?.read,false);
    assert.equal(conversations.list([live]).find(chat=>chat.id===source)?.unread,1);
    // Legacy watch endpoints keep summaries small even when native prompts are large.
    store.inbox.add({key:source+':large',target:saved,text:'Large prompt '.repeat(3000),reply:'Short answer'});
    assert.ok(JSON.stringify(store.inbox.page()).length<5000);
  } finally {store.close();}
});

test('the reply state distinguishes missing connections, busy agents, setup, and watch-only replies', () => {
  const store=new Store(':memory:'),conversations=new Conversations(store);
  try {
    store.inbox.add({key:source+':1',target:saved,reply:'Saved answer'});
    assert.equal(conversations.list([])[0]?.connection,'connect');
    assert.equal(conversations.list([{...live,available:false,status:'working'}])[0]?.connection,'busy');
    assert.equal(conversations.list([{...live,available:false,status:'blocked'}])[0]?.connection,'attention');
    assert.equal(conversations.list([{...live,available:false,status:'Sign in on Mac'}])[0]?.connection,'setup');
    store.create(randomUUID(),'pending',live,'Still working');
    assert.equal(conversations.list([live])[0]?.connection,'busy');
    store.inbox.add({key:'muse:1',target:{id:'muse',name:'Muse'},reply:'From the watch'});
    assert.equal(conversations.list([]).find(chat=>chat.id==='muse')?.connection,'watch');
  } finally {store.close();}
});

test('existing inbox databases migrate without losing replies or read state', () => {
  const dir=mkdtempSync(join(tmpdir(),'maestro-conversations-')),path=join(dir,'store.sqlite');
  const db=new DatabaseSync(path);
  db.exec(`CREATE TABLE inbox(id INTEGER PRIMARY KEY AUTOINCREMENT,source TEXT NOT NULL UNIQUE,target TEXT NOT NULL,
    reply TEXT NOT NULL,attention INTEGER NOT NULL DEFAULT 0,turn TEXT NOT NULL DEFAULT '',created INTEGER NOT NULL,
    read INTEGER NOT NULL DEFAULT 0,alerted INTEGER NOT NULL DEFAULT 0)`);
  db.prepare('INSERT INTO inbox(source,target,reply,created,read,alerted) VALUES(?,?,?,?,?,?)').run(source+':old',JSON.stringify(saved),'Kept answer',100,1,1);
  db.close();let store=new Store(path);
  try {
    assert.equal(new Conversations(store).history(source).entries[0]?.reply,'Kept answer');
    assert.equal(store.inbox.get(1)?.read,true);store.close();store=new Store(path);
    assert.equal(new Conversations(store).list([])[0]?.unread,0);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('connecting twice opens one exact session, and a reattached session is reused', async () => {
  const store=new Store(':memory:'),herdr=new Herdr(config,async()=>({agents:[]}));
  const service=new Service(config,store,herdr,speech);let calls=0,attached:Target|undefined,release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  herdr.sessions=async()=>attached?[{agent:{} as Agent,target:attached}]:[];
  herdr.resume=async target=>{calls++;assert.equal(target.session,source);await gate;attached=live;return live;};
  store.inbox.add({key:source+':1',target:saved,reply:'History'});
  try {
    const first=service.connectConversation(source),second=service.connectConversation(source);
    assert.equal(first,second);release();assert.equal((await first).id,live.id);assert.equal(calls,1);
    assert.equal((await service.connectConversation(source)).id,live.id);assert.equal(calls,1);
    await assert.rejects(service.connectConversation('codex:unknown'),/no longer available/);
  } finally {store.close();}
});

test('reconnecting binds watch unread counts to the live pane without changing history or read state', async () => {
  const store=new Store(':memory:'),herdr=new Herdr(config,async()=>({agents:[]}));
  const service=new Service(config,store,herdr,speech);herdr.targets=async()=>[live];
  const receipt=store.inbox.add({key:source+':unread',target:saved,text:'Saved question',reply:'Saved answer'})!;
  try {
    const {targets}=await service.targets();assert.equal(targets.length,1);
    assert.equal(store.inbox.status().counts[0]?.target,live.id);
    assert.equal(store.inbox.get(receipt.id)?.read,false);
    assert.equal(service.conversations.history(source).entries[0]?.text,'Saved question');
    assert.equal(service.conversations.list(targets)[0]?.title,saved.detail);
  } finally {store.close();}
});

test('connecting does not resume an external session that is still working', async () => {
  const store=new Store(':memory:'),herdr=new Herdr(config,async()=>({agents:[]}));
  const service=new Service(config,store,herdr,speech);let resumed=false;
  herdr.resume=async()=>{resumed=true;return live;};
  service.observer={warnings:new Set(),history:async()=>({next:null,busy:true})};
  store.inbox.add({key:source+':1',target:saved,reply:'Earlier answer'});
  try {await assert.rejects(service.connectConversation(source),/still working/);assert.equal(resumed,false);}
  finally {store.close();}
});

test('native history omits task notices, handoffs, and compaction prompts while preserving real user text and replies', () => {
  const store=new Store(':memory:'),conversations=new Conversations(store);
  try {
    store.inbox.add({key:source+':notice',target:saved,text:'<task-notification>internal task metadata</task-notification>',reply:'The build finished.'});
    store.inbox.add({key:source+':summary',target:saved,text:'This session is being continued from a previous conversation that ran out of context. Internal summary.',reply:'I continued the task.'});
    store.inbox.add({key:source+':handoff',target:saved,text:'<agent-message from="helper">\n[Subagent hand-back] Internal report.</agent-message>',reply:'Here is the final answer.'});
    store.inbox.add({key:source+':literal',target:saved,text:'<agent-message> is an XML tag I want explained.',reply:'It is a tag.'});
    const id=randomUUID();store.create(id,'literal',live,'<task-notification> is the format I want explained.');
    store.update(id,{state:'done',reply:'Explanation'});
    const entries=conversations.history(source).entries;
    assert.ok(entries.find(entry=>entry.reply==='The build finished.')?.text==='');
    assert.ok(entries.find(entry=>entry.reply==='I continued the task.')?.text==='');
    assert.equal(entries.find(entry=>entry.reply==='Here is the final answer.')?.text,'');
    assert.equal(entries.find(entry=>entry.reply==='It is a tag.')?.text,'<agent-message> is an XML tag I want explained.');
    assert.equal(entries.find(entry=>entry.id==='turn:'+id)?.text,'<task-notification> is the format I want explained.');
  } finally {store.close();}
});

test('history APIs enforce authentication, render safe Markdown locally, and keep connection actions local', async () => {
  const store=new Store(':memory:'),service=new Service(config,store,new Herdr(config,async()=>({agents:[]})),speech);
  const local=buildServer(service,{local:true}),device=buildServer(service),headers={host:'localhost:4210'};
  store.inbox.add({key:source+':1',target:saved,text:'Question',reply:'**Answer** <script>bad()</script>'});
  try {
    assert.equal((await device.inject('/api/conversations')).statusCode,401);
    assert.equal((await local.inject({url:'/api/conversations',headers:{host:'elsewhere'}})).statusCode,403);
    const response=await local.inject({url:'/api/conversations/history?id='+encodeURIComponent(source),headers});
    assert.equal(response.statusCode,200);assert.match(response.json().entries[0].replyHtml,/<strong>Answer<\/strong>/);
    assert.doesNotMatch(response.json().entries[0].replyHtml,/<script>/);
    const redirect=await local.inject({url:'/inbox.html',headers});assert.equal(redirect.statusCode,302);assert.equal(redirect.headers.location,'/?filter=unread');
    assert.equal((await device.inject({method:'POST',url:'/api/conversations/connect',headers:{authorization:'Bearer '+config.deviceToken},payload:{id:source}})).statusCode,404);
    assert.equal((await local.inject({method:'POST',url:'/api/conversations/connect',headers,payload:{id:source,command:'anything'}})).statusCode,400);
  } finally {await local.close();await device.close();store.close();}
});

test('loading native history restores prompts and earlier replies without clearing an unread receipt or alerting for old history', async () => {
  const dir=mkdtempSync(join(tmpdir(),'maestro-history-')),binary=join(dir,'codex');
  writeFileSync(binary,`#!/usr/bin/env node
const rl=require('node:readline').createInterface({input:process.stdin});
rl.on('line',line=>{const m=JSON.parse(line);if(m.id==null)return;let result={};
if(m.method==='thread/turns/list')result={data:[{id:'native',status:'completed',completedAt:100,items:[{type:'userMessage',content:[{type:'text',text:'Original question'}]},{type:'agentMessage',phase:'final_answer',text:'Saved answer'}]},{id:'older',status:'completed',completedAt:90,items:[{type:'userMessage',content:[{type:'text',text:'Earlier question'}]},{type:'agentMessage',phase:'final_answer',text:'Earlier answer'}]}]};
process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');});\n`,{mode:0o755});
  const store=new Store(':memory:'),observer=new Observer({...config,codexBinary:binary},store.inbox,{} as Herdr);
  const receipt=store.inbox.add({key:source+':native',target:saved,reply:'Saved answer',created:100000})!;
  try {
    await observer.history(source);
    const page=new Conversations(store).history(source);
    assert.deepEqual(page.entries.map(entry=>entry.text),['Earlier question','Original question']);
    assert.equal(store.inbox.get(receipt.id)?.read,false);
    assert.equal(store.inbox.page().items.find(item=>item.source===source+':older')?.read,true);
    assert.equal(store.inbox.status().alerts.length,1);assert.equal(page.entries.length,2);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});
