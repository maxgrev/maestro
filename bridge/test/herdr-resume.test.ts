import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const session = 'codex:11111111-2222-4333-8444-555555555555';

function connect(mode: 'ready' | 'failed' | 'locked' | 'different' | 'no-hook' = 'ready') {
  const root = mkdtempSync(join(tmpdir(), 'maestro-resume-'));
  const log = join(root, 'calls.jsonl'), binary = join(root, 'herdr');
  mkdirSync(join(root, 'agents/bin'), { recursive: true });
  writeFileSync(join(root, 'agents/bin/codex'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  writeFileSync(binary, `#!${process.execPath}
    const fs = require('node:fs'), args = process.argv.slice(2);
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
    const command = args[0] === '--session' ? args.slice(2) : args;
    let result = {};
    const agent = {agent: 'codex', pane_id: 'pane', terminal_id: 'terminal', agent_status: 'idle',
      ...(${!['locked','no-hook'].includes(mode)} ? {agent_session: {value: ${JSON.stringify(mode === 'different' ? '99999999-2222-4333-8444-555555555555' : session.slice(6))}}} : {})};
    if (command[0] === 'agent' && command[1] === 'list') {
      result = {agents: fs.readFileSync(${JSON.stringify(log)}, 'utf8').includes('"start"') ? [agent] : []};
    }
    if (command[0] === 'workspace') result = {root_pane: {pane_id: 'pane'}};
    if (command[0] === 'agent' && command[1] === 'start') {
      if (${mode === 'failed'} || !command.includes('--no-daemon')) {
        process.stderr.write('CLI package differs from daemon; private terminal output'); process.exit(1);
      }
    }
    if (command[0] === 'agent' && ['start', 'get'].includes(command[1])) {
      result = {agent};
    }
    if (command[0] === 'pane' && command[1] === 'process-info') {
      result = {process_info: {foreground_processes: ${mode === 'no-hook'} ? [{name: 'codex', pid: process.ppid}] : []}};
    }
    if (command[0] === 'agent' && command[1] === 'read') {
      process.stdout.write(${JSON.stringify(mode === 'locked' ? 'This conversation is open in another app. Close it there and press R to continue here.' : 'Ask Codex to do anything')}); process.exit(0);
    }
    process.stdout.write(JSON.stringify({result}));
  `, { mode: 0o700 });
  const modules = Object.fromEntries(['herdr', 'store', 'service', 'server'].map(name =>
    [name, new URL('../src/' + name + '.ts', import.meta.url).href]));
  try {
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import {Herdr} from ${JSON.stringify(modules.herdr)};
      import {Store} from ${JSON.stringify(modules.store)};
      import {Service} from ${JSON.stringify(modules.service)};
      import {buildServer} from ${JSON.stringify(modules.server)};
      import {openSync, closeSync, writeFileSync} from 'node:fs';
      const rollout = ${JSON.stringify(join(root, 'rollout-test-' + session.slice(6) + '.jsonl'))};
      let fd;
      if (${mode === 'no-hook'}) {writeFileSync(rollout, ''); fd = openSync(rollout, 'r');}
      const config = {localPort: 4210, herdr: {binary: ${JSON.stringify(binary)}, session: 'fixture'}, agents: [], projects: []};
      const store = new Store(':memory:'), herdr = new Herdr(config);
      store.inbox.add({key: 'saved', target: {id: '${session}', session: '${session}', name: 'Codex', cwd: ${JSON.stringify(root)}}, reply: 'Saved answer'});
      const service = new Service(config, store, herdr, {}), app = buildServer(service, {local: true});
      try {
        const response = await app.inject({method: 'POST', url: '/api/conversations/connect', headers: {host: 'localhost:4210'}, payload: {id: '${session}'}});
        let connection;
        if (response.statusCode === 200) {
          await herdr.validate(response.json().target);
          const {targets} = await service.targets();
          connection = service.conversations.list(targets).find(c => c.id === '${session}')?.connection;
          await service.connectConversation('${session}');
        }
        console.log(JSON.stringify({status: response.statusCode, body: response.json(), connection}));
      } finally {await app.close(); store.close(); if (fd !== undefined) closeSync(fd);}
    `], { cwd: process.cwd(), env: { ...process.env, MAESTRO_DATA: root }, encoding: 'utf8', timeout: 15_000 });
    return { ...JSON.parse(output), calls: readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]) };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('Connect session resumes the exact Codex session despite a mismatched shared daemon', () => {
  const result = connect();
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.target.session, session);
  assert.equal(result.body.target.available, true);
  assert.equal(result.connection, 'ready');
  const start = result.calls.find((args: string[]) => args.includes('start'));
  assert.deepEqual(start?.slice(start.indexOf('--') + 1), ['--no-daemon', 'resume', session.slice(6)]);
  assert.equal(result.calls.filter((args: string[]) => args.includes('start')).length, 1);
});

test('Connect session reports a safe startup error when the agent cannot become ready', () => {
  const result = connect('failed');
  assert.equal(result.status, 503);
  assert.equal(result.body.error, 'Codex did not become ready. Check its session on your Mac for a startup error or approval, then connect again.');
});

test('a session locked by another Codex app gets a specific recovery message', () => {
  const result = connect('locked');
  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'This session is open in another Codex app. Close the session there, then connect again in Maestro.');
});

test('a different native session is never accepted as the saved conversation', () => {
  const result = connect('different');
  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'The session could not be verified. Check it on your Mac before replying.');
});

test('Codex without a session hook binds through its exact pane and stays ready on refresh', { skip: process.platform !== 'darwin' }, () => {
  const result = connect('no-hook');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.target.session, session);
  assert.equal(result.connection, 'ready');
  assert.equal(result.calls.filter((args: string[]) => args.includes('start')).length, 1);
});
