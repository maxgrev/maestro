import { execFile, spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Config } from './config.js';
import { UserError } from './types.js';
const exec = promisify(execFile);

export function wav(pcm: Buffer): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF'); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
export interface SpeechEngine {
  warm?(): void;
  close?(): void;
  transcribe(pcm: Buffer): Promise<string>;
  speak(text: string, format: 'pcm' | 'mp3', voice?: string): Promise<Buffer>;
  stream?(text: string, format: 'pcm' | 'mp3', voice?: string): Readable;
}
export const voices = [
  { id: 'af_heart', name: 'Heart · American', engine: 'kokoro' },
  { id: 'af_bella', name: 'Bella · American', engine: 'kokoro' },
  { id: 'am_michael', name: 'Michael · American', engine: 'kokoro' },
  { id: 'bf_emma', name: 'Emma · British', engine: 'kokoro' },
  { id: 'Samantha', name: 'Samantha · macOS', engine: 'macos' },
];
export function pcmFromWav(bytes: Buffer): Buffer {
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Expected WAV speech.');
  let format = false;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(offset + 4), data = offset + 8;
    if (data + size > bytes.length) throw new Error('Incomplete WAV speech.');
    const id = bytes.toString('ascii', offset, offset + 4);
    if (id === 'fmt ') format = size >= 16 && bytes.readUInt16LE(data) === 1 && bytes.readUInt16LE(data + 2) === 1
      && bytes.readUInt32LE(data + 4) === 16000 && bytes.readUInt16LE(data + 14) === 16;
    if (id === 'data' && format && size % 2 === 0) return bytes.subarray(data, data + size);
    offset = data + size + (size % 2);
  }
  throw new Error('Expected 16 kHz mono PCM16 speech.');
}
export class Speech implements SpeechEngine {
  private active = false;
  private worker?: ReturnType<Speech['startWorker']>;
  constructor(private config: Config['speech']) {}
  // Start loading during transcription/agent work, and reuse the model for PCM
  // replies. Only one synthesis runs at a time; cancellation discards the worker.
  warm() {
    if (this.config.engine !== 'kokoro' || this.worker) return;
    const { python, helper, kokoro } = this.config;
    if (python && helper && kokoro) this.worker = this.startWorker(python, helper, kokoro);
  }
  close() { this.worker?.child.kill(); this.worker = undefined; }
  private startWorker(python: string, helper: string, model: string) {
    const child = spawn(python, ['-u', helper, model, '--persistent'], {
      stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
    const worker = { child, chunks: child.stdout.iterator({ destroyOnReturn: false }), buffered: Buffer.alloc(0) };
    child.stdin.on('error', () => {});
    const forget = () => { if (this.worker === worker) this.worker = undefined; };
    child.once('error', forget); child.once('close', forget);
    return worker;
  }
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active) throw new UserError('Speech is busy. Please try again shortly.', 503);
    this.active = true;
    try { return await fn(); } finally { this.active = false; }
  }
  async transcribe(pcm: Buffer): Promise<string> {
    return this.exclusive(async () => {
      this.warm();
      const dir = await mkdtemp(join(tmpdir(), 'maestro-asr-'));
      try {
        const input = join(dir, 'voice.wav'), out = join(dir, 'transcript');
        await writeFile(input, wav(pcm), { mode: 0o600 });
        await exec(this.config.whisper, ['-m', this.config.model, '-f', input, '-otxt', '-of', out, '-nt', '-l', 'auto'], { timeout: 120_000, maxBuffer: 512_000 });
        const text = (await readFile(`${out}.txt`, 'utf8')).trim();
        if (!text || /^\[.*\]$/.test(text)) throw new UserError('No speech detected. Please record again.');
        return text;
      } catch (e) {
        if (e instanceof UserError) throw e;
        throw new Error('Transcription is unavailable. Check the Maestro app on your Mac.');
      } finally { await rm(dir, { recursive: true, force: true }); }
    });
  }
  stream(text: string, format: 'pcm' | 'mp3', voice?: string): Readable {
    const cancel = new AbortController();
    const stream = Readable.from(this.audio(text, format, voice, cancel.signal));
    const destroy = stream.destroy.bind(stream);
    // Readable.from waits for the iterator before emitting close. Abort first
    // so a disconnected client cannot leave that iterator waiting for audio.
    stream.destroy = error => { cancel.abort(); return destroy(error); };
    return stream;
  }
  async speak(text: string, format: 'pcm' | 'mp3', voice?: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of this.audio(text, format, voice)) chunks.push(chunk);
    return Buffer.concat(chunks);
  }
  private async *audio(text: string, format: 'pcm' | 'mp3', selected?: string, signal?: AbortSignal): AsyncGenerator<Buffer> {
    const engine = selected ? voices.find(v => v.id === selected)?.engine : this.config.engine;
    if (engine !== 'kokoro') { yield await this.legacy(text, format); return; }
    if (this.active) throw new UserError('Speech is busy. Please try again shortly.', 503);
    const { python, helper, kokoro, lame } = this.config;
    if (!python || !helper || !kokoro || (format === 'mp3' && !lame)) throw new Error('Neural speech files are missing. Reinstall Maestro.');
    if (format === 'pcm') { yield* this.pcm(text, selected ?? this.config.neuralVoice ?? 'af_heart', signal); return; }
    this.active = true;
    const child = spawn(python, ['-u', helper, kokoro, lame ?? ''], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    let failure: Error | undefined;
    const timer = setTimeout(() => { failure = new Error('Speech timed out. Your text reply is still available.'); child.kill(); }, 60_000);
    const closed = new Promise<void>(resolve => {
      child.once('error', () => { failure = new Error('Neural speech could not start.'); });
      child.once('close', code => { if (code !== 0) failure ??= new Error('Speech stopped. Your text reply is still available.'); resolve(); });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ text, format, voice: selected ?? this.config.neuralVoice ?? 'af_heart' }));
    try {
      let size = 0;
      for await (const chunk of child.stdout) { timer.refresh(); size += chunk.length; yield chunk as Buffer; }
      await closed;
      if (failure) throw failure;
      if (size < 128) throw new Error('Speech returned no audio.');
    } finally {
      child.kill(); clearTimeout(timer); await closed; this.active = false;
    }
  }
  private async *pcm(text: string, voice: string, signal?: AbortSignal): AsyncGenerator<Buffer> {
    this.active = true;
    const worker = this.worker ??= this.startWorker(this.config.python!, this.config.helper!, this.config.kokoro!);
    let finished = false, size = 0;
    const abort = () => { worker.child.kill(); if (this.worker === worker) this.worker = undefined; };
    const timer = setTimeout(abort, 60_000);
    signal?.addEventListener('abort', abort, { once: true });
    const read = async (length: number) => {
      while (worker.buffered.length < length) {
        const chunk = await worker.chunks.next();
        if (chunk.done) throw new Error('Speech stopped. Your text reply is still available.');
        worker.buffered = Buffer.concat([worker.buffered, chunk.value]);
        timer.refresh();
      }
      const data = worker.buffered.subarray(0, length);
      worker.buffered = worker.buffered.subarray(length);
      return data;
    };
    try {
      signal?.throwIfAborted();
      worker.child.stdin.write(JSON.stringify({ text, voice }) + '\n');
      for (;;) {
        const length = (await read(4)).readUInt32LE();
        if (!length) { finished = true; break; }
        if (length > 1_048_576 || length % 2) throw new Error('Invalid speech audio frame.');
        size += length;
        yield await read(length);
      }
      if (size < 128) throw new Error('Speech returned no audio.');
    } catch (error) {
      if (!signal?.aborted) throw error;
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (!finished) abort();
      this.active = false;
    }
  }
  private async legacy(text: string, format: 'pcm' | 'mp3'): Promise<Buffer> {
    return this.exclusive(async () => {
      const dir = await mkdtemp(join(tmpdir(), 'maestro-tts-'));
      try {
        await writeFile(join(dir, 'reply.txt'), text, { mode: 0o600 });
        if (this.config.lame) {
          await exec('/usr/bin/say', ['-v', this.config.voice, '-f', join(dir, 'reply.txt'), '-o', join(dir, 'reply.wav'), '--file-format=WAVE', '--data-format=LEI16@16000'], { timeout: 60_000 });
          const pcm = pcmFromWav(await readFile(join(dir, 'reply.wav')));
          if (pcm.length < 128) throw new Error('Speech engine returned no audio.');
          if (format === 'pcm') return pcm;
          await exec(this.config.lame, ['--quiet', '-b', '48', '-m', 'm', join(dir, 'reply.wav'), join(dir, 'reply.mp3')], { timeout: 30_000 });
          const mp3 = await readFile(join(dir, 'reply.mp3'));
          if (mp3.length < 128) throw new Error('Speech encoder returned no audio.');
          return mp3;
        }
        await exec('/usr/bin/say', ['-v', this.config.voice, '-f', join(dir, 'reply.txt'), '-o', join(dir, 'reply.aiff')], { timeout: 60_000 });
        const output = join(dir, `reply.${format}`);
        await exec(this.config.ffmpeg, ['-nostdin', '-loglevel', 'error', '-i', join(dir, 'reply.aiff'), '-ac', '1', '-ar', '16000', ...(format === 'pcm' ? ['-f', 's16le'] : ['-codec:a', 'libmp3lame', '-b:a', '48k']), output], { timeout: 30_000 });
        const audio = await readFile(output);
        if (audio.length < 128) throw new Error('Speech engine returned no audio.');
        return audio;
      } catch { throw new Error('Speech playback is unavailable. The text reply is still available.'); }
      finally { await rm(dir, { recursive: true, force: true }); }
    });
  }
}
