import { readFileSync, mkdirSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { localDir, readConfig } from './config.js';
import { Store } from './store.js';
import { Speech } from './speech.js';
import { Herdr } from './herdr.js';
import { Service } from './service.js';
import { buildServer } from './server.js';
import { Onboarding } from './onboarding.js';

mkdirSync(localDir, { recursive: true, mode: 0o700 });
chmodSync(localDir, 0o700);
const config = readConfig();
// OS-level exclusive flock is unavailable in core Node. Binding the local port is
// the single-instance guard; recover the database only after that bind succeeds.
const store = new Store(resolve(localDir, 'maestro.sqlite'));
const service = new Service(config, store, new Herdr(config), new Speech(config.speech));
const local = buildServer(service, { local: true, onboarding: new Onboarding(config) });
const device = buildServer(service, { https: { key: readFileSync(resolve(localDir, 'bridge-key.pem')), cert: readFileSync(resolve(localDir, 'bridge-cert.pem')) } });
await local.listen({ host: '127.0.0.1', port: config.localPort });
try { await device.listen({ host: config.host, port: config.port }); }
catch (error) { await local.close(); store.close(); throw error; }
store.recover();
console.log(`Maestro: http://localhost:${config.localPort}`);
console.log(`Device HTTPS port: ${config.port}. Configuration: ${localDir}/config.json`);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await Promise.all([local.close(), device.close()]);
  await service.drain();
  store.close();
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
