import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { readConfig } from './config.js';
import { Herdr } from './herdr.js';
const c = readConfig();
for (const [name, path] of [['Herdr', c.herdr.binary], ['Whisper', c.speech.whisper], ['Speech model', c.speech.model]]) console.log(`${existsSync(path!) ? 'OK' : 'MISSING'}  ${name}: ${path}`);
if (c.speech.engine === 'kokoro') {
  for (const [name, path] of [['Speech Python', c.speech.python], ['Speech helper', c.speech.helper],
    ['Kokoro model', c.speech.kokoro && join(c.speech.kokoro, 'model.onnx')], ['Kokoro voices', c.speech.kokoro && join(c.speech.kokoro, 'voices.bin')]]) {
    console.log(`${path && existsSync(path) ? 'OK' : 'MISSING'}  ${name}: ${path ?? 'not configured'}`);
  }
}
for (const bin of ['/usr/bin/say', c.speech.lame ?? c.speech.ffmpeg]) {
  try { execFileSync('/usr/bin/which', [bin], { stdio: 'ignore' }); console.log(`OK  ${bin}`); } catch { console.log(`MISSING  ${bin}`); }
}
try { const { targets } = { targets: await new Herdr(c).targets() }; console.log(`OK  Herdr session ${c.herdr.session}: ${targets.length} targets`); }
catch { console.log(`SETUP  Start Herdr: ${c.herdr.binary} --session ${c.herdr.session}`); }
console.log(c.grok ? 'CONFIGURED  Grok webhook (live delivery not checked)' : 'SETUP  Grok webhook and reply helper');
console.log('SETUP  Muse pairing happens on the device using the Muse phone app.');
