import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { readConfig } from './config.js';
import { Herdr } from './herdr.js';
const c = readConfig();
for (const [name, path] of [['Herdr', c.herdr.binary], ['Whisper', c.speech.whisper], ['Speech model', c.speech.model]]) console.log(`${existsSync(path!) ? 'OK' : 'MISSING'}  ${name}: ${path}`);
for (const bin of ['say', c.speech.ffmpeg]) {
  try { execFileSync('/usr/bin/which', [bin], { stdio: 'ignore' }); console.log(`OK  ${bin}`); } catch { console.log(`MISSING  ${bin}`); }
}
try { const { targets } = { targets: await new Herdr(c).targets() }; console.log(`OK  Herdr session ${c.herdr.session}: ${targets.length} targets`); }
catch { console.log(`SETUP  Start Herdr: ${c.herdr.binary} --session ${c.herdr.session}`); }
console.log(c.grok ? 'CONFIGURED  Grok webhook (live delivery not checked)' : 'SETUP  Grok webhook and reply helper');
console.log('SETUP  Muse pairing happens on the device using the Muse phone app.');
