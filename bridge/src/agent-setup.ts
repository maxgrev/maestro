import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve, delimiter, join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { localDir } from './config.js';
import { UserError } from './types.js';
const exec = promisify(execFile);
const kinds = ['codex','claude','pi'] as const;
type Kind = typeof kinds[number];
export async function connectAgent(kind: Kind, herdr: string) {
  // Official Herdr integrations only report lifecycle inside Herdr-managed panes.
  const directory = kind === 'pi' ? '.pi/agent' : kind === 'claude' ? '.claude' : '.codex';
  mkdirSync(join(homedir(), directory), { recursive: true, mode: 0o700 });
  await exec(herdr, ['integration', 'install', kind], { timeout: 10000, maxBuffer: 16000 });
}
const packages: Record<Kind,string> = { codex:'@openai/codex@0.160.0', claude:'@anthropic-ai/claude-code@2.1.296', pi:'@mariozechner/pi-coding-agent@0.73.1' };
export function npmCommand(root = process.cwd(), env: NodeJS.ProcessEnv = process.env): { binary: string; args: string[] } {
  const scripts = [resolve(root, '.tools/node/lib/node_modules/npm/bin/npm-cli.js'), env.npm_execpath];
  const script = scripts.find(path => path && existsSync(path));
  if (script) return { binary: process.execPath, args: [script] };
  const binary = (env.PATH ?? '').split(delimiter).filter(Boolean).map(dir => join(dir, 'npm'))
    .find(path => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } });
  if (binary) return { binary, args: [] };
  throw new UserError('npm is missing. Run scripts/bootstrap.sh, then start Maestro with npm start.');
}
export function agentBinary(kind: Kind): string | undefined {
  return [resolve(localDir,'agents/bin'),resolve(localDir,'bin'),resolve('.tools'),...(process.env.PATH??'').split(delimiter)]
    .map(dir=>join(dir,kind)).find(path=>{try{accessSync(path,constants.X_OK);return true;}catch{return false;}});
}
type AgentJob = { kind: Kind; state: 'working'|'done'|'failed'; message: string; url?: string; code?: string };
const readiness = new Map<Kind,{at:number;value:{kind:Kind;installed:boolean;signedIn:boolean}}>();
export async function agentReadiness(kind:Kind) {
  const cached=readiness.get(kind);if(cached&&Date.now()-cached.at<10_000)return cached.value;
  const binary=agentBinary(kind);let signedIn=false;
  if(binary&&kind!=='pi')try{
    const result=await exec(binary,kind==='codex'?['login','status']:['auth','status'],{timeout:4000,maxBuffer:16000});
    signedIn=kind==='claude'?JSON.parse(result.stdout).loggedIn===true:true;
  }catch{}
  if(kind==='pi')try{
    const auth=JSON.parse(readFileSync(join(homedir(),'.pi/agent/auth.json'),'utf8'));
    signedIn=Object.values(auth).some(v=>v&&typeof v==='object'&&('type' in v));
  }catch{}
  const value={kind,installed:!!binary,signedIn};readiness.set(kind,{at:Date.now(),value});return value;
}
export class AgentSetup {
  private job?: AgentJob;
  private child?: ChildProcess;
  async state() {
    const agents = await Promise.all(kinds.map(agentReadiness));
    return {agents,job:this.job};
  }
  start(body:unknown) {
    const {kind,action}=z.object({kind:z.enum(kinds),action:z.enum(['install','login'])}).strict().parse(body);
    if(this.job?.state==='working')throw new UserError('An agent setup step is already running.',409);
    let binary:string,args:string[];
    if(action==='install') {
      const npm = npmCommand();
      binary = npm.binary;
      args=[...npm.args,'install','--global','--prefix',resolve(localDir,'agents'),'--cache',resolve(localDir,'npm-cache'),packages[kind]];
    } else {
      binary=agentBinary(kind)??'';if(!binary)throw new UserError('Install this agent first.');
      if(kind==='pi')throw new UserError('Add an API key below, or use your saved Pi account.');
      args=kind==='codex'?['login','--device-auth']:['auth','login'];
    }
    const job:AgentJob={kind,state:'working',message:action==='install'?'Installing the official agent package…':'Complete sign-in in your browser.'};this.job=job;
    const env={...process.env,PATH:[resolve('.tools/node/bin'),resolve(localDir,'agents/bin'),process.env.PATH].join(delimiter),NO_COLOR:'1'};
    const child=spawn(binary,args,{env,stdio:['ignore','pipe','pipe']});this.child=child;
    let output='';
    const read=(data:Buffer)=>{
      output=(output+data.toString()).replace(/\x1b\[[0-9;]*[A-Za-z]/g,'').slice(-16000);
      if(action!=='login')return;
      // Expose only provider sign-in links and device codes, never arbitrary CLI logs.
      for(const candidate of output.match(/https:\/\/[^\s<>"']+/g)??[]){
        try{const url=new URL(candidate);if(['auth.openai.com','claude.ai','platform.claude.com','console.anthropic.com'].includes(url.hostname))job.url=url.href;}catch{}
      }
      job.code=output.match(/\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/)?.[0]??output.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/)?.[0];
    };
    child.stdout?.on('data',read);child.stderr?.on('data',read);
    const timer=setTimeout(()=>child.kill(),300_000);
    child.once('error',()=>{job.state='failed';job.message='Could not start agent setup. Reopen Maestro and try again.';});
    child.once('close',async code=>{
      clearTimeout(timer); this.child=undefined; readiness.delete(kind);
      if(code===0&&action==='install') {
        try { await connectAgent(kind,resolve('.tools/herdr')); }
        catch { job.state='failed';job.message='Agent installed, but its session connection failed. Retry setup in Maestro.';return; }
      }
      job.state=code===0?'done':'failed';job.message=code===0?(action==='install'?'Installed. Sign in to continue.':'Signed in.'):'Setup did not finish. Try again or use your existing agent account.';delete job.url;delete job.code;
    });
    return job;
  }
  cancel(){this.child?.kill();return {cancelled:true};}
  savePi(body:unknown){
    const {provider,key}=z.object({provider:z.enum(['openai','anthropic','google']),key:z.string().min(10).max(1000).regex(/^[A-Za-z0-9_\-]+$/)}).strict().parse(body);
    const directory=join(homedir(),'.pi/agent'),path=join(directory,'auth.json');
    mkdirSync(directory,{recursive:true,mode:0o700});
    const auth=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{};
    if(!auth||typeof auth!=='object'||Array.isArray(auth))throw new UserError('Pi’s account file is unreadable. Fix it in Pi before saving a key.');
    // The documented Pi format. Forbid command-valued keys (a leading '!').
    auth[provider]={type:'api_key',key};
    writeFileSync(path+'.maestro-tmp',JSON.stringify(auth,null,2)+'\n',{mode:0o600});renameSync(path+'.maestro-tmp',path);
    readiness.delete('pi');
    return {saved:true};
  }
}
