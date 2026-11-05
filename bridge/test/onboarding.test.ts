import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Onboarding, type DeviceRunner } from '../src/onboarding.js';
import { configSchema } from '../src/config.js';
import { pcmFromWav, wav } from '../src/speech.js';
import { AgentSetup } from '../src/agent-setup.js';
import { Herdr } from '../src/herdr.js';
import { buildServer } from '../src/server.js';
import type { Service } from '../src/service.js';

function fixture() {
  const data = mkdtempSync(resolve(tmpdir(), 'maestro-setup-test-'));
  const config = configSchema.parse({ deviceToken: 'd'.repeat(64), herdr: {binary:'herdr',session:'test'}, speech:{whisper:'whisper',model:'model'} });
  writeFileSync(resolve(data, 'config.json'), JSON.stringify(config));
  writeFileSync(resolve(data, 'device.json'), JSON.stringify({url:'https://test.local:4211'}));
  writeFileSync(resolve(data, 'bridge-cert.pem'), 'private-test-certificate');
  return { data, config, cleanup: () => rmSync(data, {recursive:true,force:true}) };
}
test('a checked StopWatch loses its connected state when USB disconnects', async () => {
  const f=fixture();
  let connected=true;
  const runner: DeviceRunner=async input=>input.action==='ports'?{ports:connected?[{port:'/dev/cu.test'}]:[]}:
    {board:'M5Stack StopWatch',maestro:{version:3},wifi:{state:'connected',ssid:'Test network'}};
  try {
    const setup=new Onboarding(f.config,runner,f.data);
    setup.start({action:'inspect',port:'/dev/cu.test'});
    await new Promise(resolve=>setImmediate(resolve));
    const checked=await setup.state();
    assert.equal(checked.device?.port,'/dev/cu.test');
    assert.equal(checked.job?.message,'StopWatch connected over USB.');
    connected=false;
    assert.equal((await setup.state()).device,undefined);
    connected=true;
    assert.equal((await setup.state()).device,undefined,'reconnecting needs a fresh check');
  } finally { f.cleanup(); }
});
test('USB jobs reject concurrent writes and never return credentials', async () => {
  const f=fixture();
  let complete!: (value: Record<string,unknown>)=>void, captured: Record<string,unknown>|undefined;
  const runner: DeviceRunner = async input => {
    if(input.action==='ports')return {ports:[]};
    captured=input;return new Promise(done=>{complete=done;});
  };
  try {
    const setup=new Onboarding(f.config,runner,f.data);
    const job=setup.start({action:'configure',port:'/dev/cu.test'});
    assert.equal(job.state,'working');
    assert.throws(()=>setup.start({action:'wifi',port:'/dev/cu.test',ssid:'home',password:'secret'}),/busy/);
    assert.equal((captured?.config as {token:string}).token,f.config.deviceToken);
    const view=JSON.stringify(await setup.state());
    assert.ok(!view.includes(f.config.deviceToken));assert.ok(!view.includes('private-test-certificate'));
    complete({saved:true});await new Promise(resolve=>setImmediate(resolve));
    assert.equal((await setup.state()).job?.state,'done');
  } finally {f.cleanup();}
});
test('agent saves preserve keys and reject invalid projects before changing configuration', () => {
  const f=fixture();
  try {
    const setup=new Onboarding(f.config,undefined,f.data);
    setup.saveAgents({grok:{webhook:'https://example.com/webhook',key:'webhook-secret'},muse:'mgst_test-personal-token'});
    const key=f.config.grok!.replyKey;
    setup.saveAgents({grok:{webhook:'https://example.com/updated',key:'new-webhook-secret'}});
    assert.equal(f.config.grok!.replyKey,key);
    assert.equal(readFileSync(resolve(f.data,'muse-sdk-token'),'utf8').trim(),'mgst_test-personal-token');
    assert.equal(statSync(resolve(f.data,'config.json')).mode&0o777,0o600);
    const before=readFileSync(resolve(f.data,'config.json'),'utf8');
    assert.throws(()=>setup.saveAgents({project:{path:'/not-a-real-maestro-project',name:'Missing'},muse:'mgst_other-test-token'}),/existing/);
    assert.equal(readFileSync(resolve(f.data,'config.json'),'utf8'),before);
    assert.equal(readFileSync(resolve(f.data,'muse-sdk-token'),'utf8').trim(),'mgst_test-personal-token');
  } finally {f.cleanup();}
});
test('failed USB writes require a new explicit action and do not retry',async()=>{
  const f=fixture();let calls=0;
  try{
    const setup=new Onboarding(f.config,async input=>{if(input.action==='ports')return {ports:[]};calls++;throw new Error('secret transport dump');},f.data);
    setup.start({action:'configure',port:'/dev/cu.test'});await new Promise(resolve=>setImmediate(resolve));
    const state=await setup.state();assert.equal(state.job?.state,'failed');assert.equal(calls,1);
    assert.ok(!JSON.stringify(state).includes('secret transport dump'));
    assert.throws(()=>setup.start({action:'install',port:'/dev/cu.test'}));assert.equal(calls,1);
  }finally{f.cleanup();}
});
test('speech reads WAV data past metadata and rejects wrong or truncated formats',()=>{
  const pcm=Buffer.from([1,0,2,0,3,0,4,0]);const basic=wav(pcm);
  const extra=Buffer.from('4a554e4b0300000001020300','hex');
  const metadata=Buffer.concat([basic.subarray(0,12),extra,basic.subarray(12)]);metadata.writeUInt32LE(metadata.length-8,4);
  assert.deepEqual(pcmFromWav(metadata),pcm);
  const stereo=Buffer.from(basic);stereo.writeUInt16LE(2,22);assert.throws(()=>pcmFromWav(stereo));
  assert.throws(()=>pcmFromWav(basic.subarray(0,basic.length-1)));
});
test('voice selection applies to the running engine and survives unrelated setup saves',()=>{
  const f=fixture();
  try {
    const speechConfig=f.config.speech, setup=new Onboarding(f.config,undefined,f.data);
    setup.saveAgents({voice:'bf_emma'});
    assert.equal(speechConfig.engine,'kokoro');assert.equal(speechConfig.neuralVoice,'bf_emma');
    setup.saveAgents({grok:{webhook:'https://example.com/hook',key:'test'}});
    assert.equal(f.config.speech,speechConfig);
    assert.equal(JSON.parse(readFileSync(resolve(f.data,'config.json'),'utf8')).speech.neuralVoice,'bf_emma');
    assert.throws(()=>setup.saveAgents({voice:'untrusted/voice'}));
  } finally { f.cleanup(); }
});
test('setup writes are unavailable on the device listener and reject foreign browser origins',async()=>{
  const f=fixture();
  const service={config:f.config} as Service;
  const local=buildServer(service,{local:true,onboarding:new Onboarding(f.config,undefined,f.data)});
  const device=buildServer(service);
  try{
    const foreign=await local.inject({method:'POST',url:'/api/setup/coding',headers:{host:'localhost:4210',origin:'https://untrusted.example'},payload:{action:'install',kind:'codex'}});
    assert.equal(foreign.statusCode,403);
    const remote=await device.inject({method:'POST',url:'/api/setup/coding',headers:{authorization:'Bearer '+f.config.deviceToken},payload:{action:'install',kind:'codex'}});
    assert.equal(remote.statusCode,404);
    const invalid=await local.inject({method:'POST',url:'/api/setup/coding',headers:{host:'localhost:4210'},payload:{action:'install',kind:'codex; touch /tmp/no'}});
    assert.equal(invalid.statusCode,400);
  }finally{await local.close();await device.close();f.cleanup();}
});
test('Pi keys cannot contain executable secret-manager commands',()=>{
  const setup=new AgentSetup();
  assert.throws(()=>setup.savePi({provider:'openai',key:'!curl example.com'}));
  assert.throws(()=>setup.savePi({provider:'../../elsewhere',key:'test-only-key'}));
});
test('Codex cannot launch before folder trust, and trust does not follow a changed project',async()=>{
  const f=fixture();let calls=0;
  try{
    const setup=new Onboarding(f.config,undefined,f.data);
    setup.saveAgents({project:{name:'Test',path:f.data,trusted:true}});
    assert.equal(f.config.projects[0]?.trusted,true);
    setup.saveAgents({project:{name:'Changed',path:tmpdir()}});
    const herdr=new Herdr(f.config,async()=>{calls++;throw new Error('Must not launch');});
    await assert.rejects(herdr.prepare({id:'new:codex:default',name:'Codex',provider:'herdr',detail:'',status:'new',available:true,kind:'codex',project:'default'},'test'),/trust a project/);
    assert.equal(calls,0);
  }finally{f.cleanup();}
});
