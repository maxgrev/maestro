// The Mac app supplies MAESTRO_DATA and launches this compiled entry point.
import './setup.js';
import { existsSync, mkdirSync, openSync, writeFileSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join, delimiter } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { localDir, readConfig } from './config.js';

const exec = promisify(execFile), config = readConfig(), bin = resolve(localDir, 'bin');
mkdirSync(bin, { recursive: true, mode: 0o700 });
const paths = [join(homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin'];
const codex = [join(homedir(), 'Applications/Codex++.app/Contents/Resources/codex-cli/bin/codex'),
  '/Applications/Codex.app/Contents/Resources/codex', '/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex',
  ...paths.map(p => join(p, 'codex'))].find(existsSync);
if (codex) {
  const link = join(bin, 'codex');
  try { unlinkSync(link); } catch { /* First launch. */ }
  symlinkSync(codex, link); config.codexBinary = codex;
}
process.env.PATH = [resolve(localDir,'agents/bin'), bin, resolve('.tools/node/bin'), resolve('.tools'), ...paths, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter);
config.herdr.binary = resolve('.tools/herdr');
config.herdr.configPath = resolve(localDir, 'herdr/config.toml');
config.speech.whisper = resolve('.tools/whisper/bin/whisper-cli');
config.speech.model = resolve('.tools/whisper/ggml-base.bin');
config.speech.lame = resolve('.tools/lame');
config.speech.python = process.env.MAESTRO_PYTHON ?? resolve('.tools/python/bin/python3');
config.speech.kokoro = resolve('.tools/kokoro');
config.speech.helper = resolve('scripts/speech.py');
config.speech.engine ??= 'kokoro';
config.speech.neuralVoice ??= 'af_heart';
// Fresh installs get a real, writable folder rather than the app's resources.
if (config.projects.length === 1 && config.projects[0]?.path === resolve('.')) {
  const project = join(homedir(), 'Documents/Maestro'); mkdirSync(project, {recursive:true});
  config.projects = [{ id: 'default', name: 'My project', path: project }];
}
writeFileSync(resolve(localDir, 'config.json.tmp'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
renameSync(resolve(localDir, 'config.json.tmp'), resolve(localDir, 'config.json'));
const args = ['--session', config.herdr.session];
const env = { ...process.env, HERDR_CONFIG_PATH: config.herdr.configPath };
const check = () => exec(config.herdr.binary, [...args, 'agent', 'list'], { env, timeout: 5000, maxBuffer: 1024 * 1024 });
try { await check(); } catch {
  const log = openSync(resolve(localDir, 'herdr-server.log'), 'a', 0o600);
  spawn(config.herdr.binary, [...args, 'server'], { env, detached: true, stdio: ['ignore', log, log] }).unref();
  for (let attempt = 0; attempt < 30; attempt++) {
    try { await check(); break; } catch { await new Promise(r => setTimeout(r, 250)); }
  }
}
await import('./main.js');
