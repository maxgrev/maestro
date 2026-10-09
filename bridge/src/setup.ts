import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { localDir, type Config } from './config.js';

mkdirSync(localDir, { recursive: true, mode: 0o700 });
mkdirSync(resolve(localDir, 'herdr'), { recursive: true, mode: 0o700 });
if (!existsSync(resolve(localDir, 'herdr/config.toml'))) {
  writeFileSync(resolve(localDir, 'herdr/config.toml'), '[terminal]\ndefault_shell = "/bin/bash"\nshell_mode = "non_login"\n', { mode: 0o600 });
}
const ips = Object.values(networkInterfaces()).flat().filter(a => a?.family === 'IPv4' && !a.internal).map(a => a!.address);
const host = hostname().replace(/[^a-zA-Z0-9.-]/g, '');
if (!existsSync(resolve(localDir, 'bridge-cert.pem'))) {
  const cnf = `[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=Maestro local bridge\n[ext]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nsubjectAltName=DNS:localhost,DNS:${host || 'maestro.local'},IP:127.0.0.1${ips.map(ip => `,IP:${ip}`).join('')}\n`;
  writeFileSync(resolve(localDir, 'tls.cnf'), cnf, { mode: 0o600 });
  execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '365', '-keyout', resolve(localDir, 'bridge-key.pem'), '-out', resolve(localDir, 'bridge-cert.pem'), '-config', resolve(localDir, 'tls.cnf')], { stdio: 'ignore' });
  chmodSync(resolve(localDir, 'bridge-key.pem'), 0o600);
}
if (!existsSync(resolve(localDir, 'config.json'))) {
  const config: Config = {
    deviceToken: randomBytes(32).toString('hex'), host: '0.0.0.0', port: 4211, localPort: 4210,
    herdr: { binary: resolve('.tools/herdr'), session: 'maestro', configPath: resolve(localDir, 'herdr/config.toml') },
    projects: [{ id: 'maestro', name: 'Maestro', path: resolve('.') }], agents: ['codex', 'claude', 'pi'],
    ...(existsSync(resolve('.tools/codex')) ? { codexBinary: resolve('.tools/codex') } : {}),
    speech: { whisper: resolve('.tools/whisper/bin/whisper-cli'), model: resolve('.tools/whisper/ggml-base.bin'), ffmpeg: 'ffmpeg', voice: 'Samantha',
      engine: 'kokoro', neuralVoice: 'af_heart', python: resolve('.tools/python/bin/python'), kokoro: resolve('.tools/kokoro'), helper: resolve('scripts/speech.py'),
      ...(existsSync('/opt/homebrew/opt/lame/bin/lame') ? { lame: '/opt/homebrew/opt/lame/bin/lame' } : {}),
    },
  };
  writeFileSync(resolve(localDir, 'config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}
if (!existsSync(resolve(localDir, 'device.json'))) writeFileSync(resolve(localDir, 'device.json'), JSON.stringify({ url: `https://${host.endsWith('.local') ? host : ips[0] ?? '127.0.0.1'}:4211` }, null, 2) + '\n', { mode: 0o600 });
console.log(`Saved private configuration in ${localDir}. Existing configuration was preserved.`);
