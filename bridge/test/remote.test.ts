import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { configSchema } from '../src/config.js';
import { RemoteAccess, type TailscaleRunner } from '../src/remote.js';
import { Onboarding } from '../src/onboarding.js';
import { buildServer } from '../src/server.js';
import type { Service } from '../src/service.js';

function fixture() {
  const data = mkdtempSync(resolve(tmpdir(), 'maestro-remote-'));
  const config = configSchema.parse({ deviceToken: 'secret'.repeat(12), herdr: {binary:'unused',session:'test'}, speech:{whisper:'unused',model:'unused'} });
  let sharing: unknown = {}, failProbe = false, approval = false, connected = true;
  const calls: string[][] = [];
  const owned = { TCP: {'443':{HTTPS:true}}, Web: {'mac.test.ts.net:443':{Handlers:{'/':{Proxy:'http://127.0.0.1:4212'}}}}, AllowFunnel:{'mac.test.ts.net:443':true} };
  const run: TailscaleRunner = async args => {
    calls.push(args);
    if(args[0]==='status')return {ok:true,stderr:'',stdout:JSON.stringify({BackendState:connected?'Running':'Stopped',Self:{DNSName:'mac.test.ts.net.'}})};
    if(args[1]==='status')return {ok:true,stderr:'',stdout:JSON.stringify(sharing)};
    if(args.includes('off'))sharing={};
    else if(approval)return {ok:false,stdout:'',stderr:'Enable at https://login.tailscale.com/f/funnel?node=test'};
    else sharing=owned;
    return {ok:true,stdout:'',stderr:''};
  };
  const api = buildServer({config} as Service);
  const requests: string[] = [];
  const fetcher: typeof fetch = async (url, options) => {
    requests.push(String(url));
    assert.equal(options?.redirect,'error');
    if(failProbe)return new Response('unprotected',{status:200});
    const reply = await api.inject({url:new URL(String(url)).pathname,headers:options?.headers as Record<string,string>});
    return new Response(reply.body,{status:reply.statusCode});
  };
  const remote=new RemoteAccess(config,data,run,()=>true,fetcher);
  return { data, config, remote, calls, requests, owned, setSharing:(v:unknown)=>{sharing=v;}, fail:()=>{failProbe=true;}, approval:()=>{approval=true;}, disconnect:()=>{connected=false;},
    cleanup:async()=>{await api.close();rmSync(data,{recursive:true,force:true});} };
}
test('remote access verifies real device authentication and setup isolation before USB provisioning',async()=>{
  const f=fixture();try{
    const state=await f.remote.change('enable');
    assert.equal(state.enabled,true);assert.equal(state.available,true);
    assert.deepEqual(f.requests.map(s=>new URL(s).pathname),['/api/health','/api/health','/api/setup']);
    assert.ok(!readFileSync(resolve(f.data,'remote.json'),'utf8').includes(f.config.deviceToken));
    writeFileSync(resolve(f.data,'device.json'),JSON.stringify({url:'https://home.local:4211'}));
    writeFileSync(resolve(f.data,'bridge-cert.pem'),'home-certificate');
    let command:Record<string,unknown>|undefined;
    const setup=new Onboarding(f.config,async input=>{command=input;return {};},f.data);
    setup.start({action:'configure',port:'/dev/cu.test'});
    assert.deepEqual(command?.config,{url:'https://mac.test.ts.net',token:f.config.deviceToken,ca:'',trust:'public',muse:''});
    f.disconnect();assert.equal((await f.remote.state()).enabled,true);
    assert.equal(f.remote.saved()?.url,'https://mac.test.ts.net');
  }finally{await f.cleanup();}
});
test('other services and foreground sharing cannot be overwritten or disabled',async()=>{
  const f=fixture();try{
    for(const sharing of [
      {...f.owned,Web:{'mac.test.ts.net:443':{Handlers:{'/':{Proxy:'http://127.0.0.1:4210'}}}}},
      {...f.owned,Web:{'mac.test.ts.net:443':{Handlers:{'/':{Proxy:'http://127.0.0.1:4212'},'/private':{Path:'/private'}}}}},
      {Foreground:{session:f.owned}}, {TCP:{'443':{TCPForward:'localhost:22'}}},
    ]) {
      f.setSharing(sharing);
      await assert.rejects(f.remote.change('enable'),/another/);
      await assert.rejects(f.remote.change('disable'),/another/);
    }
    assert.ok(f.calls.every(a=>a.includes('status')));assert.equal(f.requests.length,0);
  }finally{await f.cleanup();}
});
test('failed public validation never provisions an address and approval requires an explicit retry',async()=>{
  const f=fixture();try{
    f.approval();const state=await f.remote.change('enable');
    assert.equal(state.approvalUrl,'https://login.tailscale.com/f/funnel?node=test');
    assert.equal(f.remote.saved(),undefined);assert.equal(f.requests.length,0);
    f.setSharing(f.owned);f.fail();
    await assert.rejects(f.remote.change('enable'),/not ready/);
    assert.equal(f.remote.saved(),undefined);
  }finally{await f.cleanup();}
});
test('turning off only removes the matching service and restores home provisioning',async()=>{
  const f=fixture();try{
    await f.remote.change('enable');await f.remote.change('disable');
    assert.equal(f.remote.saved(),undefined);
    assert.ok(f.calls.some(a=>a.join(' ')==='funnel --https=443 off'));
    assert.ok(f.calls.every(a=>!a.includes('reset')));
    writeFileSync(resolve(f.data,'remote.json'),JSON.stringify({url:'https://attacker.example'}));
    assert.throws(()=>f.remote.saved());
  }finally{await f.cleanup();}
});
