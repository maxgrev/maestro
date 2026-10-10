import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Speech } from '../src/speech.js';

function worker() {
  const dir = mkdtempSync(join(tmpdir(), 'maestro-speech-'));
  const helper = join(dir, 'helper.py');
  // Real child pipes: split headers and payloads, crash mid-frame, stall on
  // cancellation, and expose PID/voice so reuse cannot hide stale reply bytes.
  writeFileSync(helper, `
import sys,json,struct,os,time
for line in sys.stdin:
  r=json.loads(line); header=struct.pack('<I',256)
  if r['text']=='crash':
    sys.stdout.buffer.write(header+b'1234');sys.stdout.buffer.flush();sys.exit(1)
  if r['text']=='stall': continue
  data=(struct.pack('<I',os.getpid())+r['voice'].encode()).ljust(256,b'\\0')
  sys.stdout.buffer.write(header[:1]);sys.stdout.buffer.flush();time.sleep(.01)
  sys.stdout.buffer.write(header[1:]+data[:7]);sys.stdout.buffer.flush();time.sleep(.01)
  sys.stdout.buffer.write(data[7:]+bytes(4));sys.stdout.buffer.flush()
`);
  const speech = new Speech({ engine: 'kokoro', python: 'python3', helper, kokoro: dir, whisper: '', model: '', ffmpeg: '', voice: '' });
  return { speech, close: () => { speech.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('PCM worker reuses its model while keeping fragmented replies and voice changes separate', async () => {
  const f = worker();
  try {
    f.speech.warm();
    const a = await f.speech.speak('first', 'pcm', 'af_heart');
    const b = await f.speech.speak('second', 'pcm', 'bf_emma');
    assert.equal(a.length, 256); assert.equal(b.length, 256);
    assert.equal(a.readUInt32LE(), b.readUInt32LE());
    assert.equal(b.toString('utf8', 4, 11), 'bf_emma');
  } finally { f.close(); }
});

test('a worker crash never returns a truncated reply; the next request starts a new worker', async () => {
  const f = worker();
  try {
    const previous = await f.speech.speak('first', 'pcm');
    await assert.rejects(f.speech.speak('crash', 'pcm'), /Speech stopped/);
    const next = await f.speech.speak('next', 'pcm');
    assert.equal(next.length, 256); assert.notEqual(next.readUInt32LE(), previous.readUInt32LE());
  } finally { f.close(); }
});

test('disconnect interrupts a stalled worker and releases the speech slot', async () => {
  const f = worker();
  try {
    const stream = f.speech.stream('stall', 'pcm');
    stream.resume();
    await new Promise(resolve => setTimeout(resolve, 50));
    await assert.rejects(f.speech.speak('overlap', 'pcm'), /busy/);
    const closed = once(stream, 'close');
    stream.destroy();
    await closed;
    const next = await f.speech.speak('next', 'pcm');
    assert.equal(next.length, 256);
  } finally { f.close(); }
});
