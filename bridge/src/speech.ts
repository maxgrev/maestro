import { execFile } from 'node:child_process';
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
export interface SpeechEngine { transcribe(pcm: Buffer): Promise<string>; speak(text: string, format: 'pcm' | 'mp3'): Promise<Buffer> }
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
  constructor(private config: Config['speech']) {}
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active) throw new UserError('Speech is busy. Please try again shortly.', 503);
    this.active = true;
    try { return await fn(); } finally { this.active = false; }
  }
  async transcribe(pcm: Buffer): Promise<string> {
    return this.exclusive(async () => {
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
  async speak(text: string, format: 'pcm' | 'mp3'): Promise<Buffer> {
    return this.exclusive(async () => {
      const dir = await mkdtemp(join(tmpdir(), 'maestro-tts-'));
      try {
        await writeFile(join(dir, 'reply.txt'), text.slice(0, 1800), { mode: 0o600 });
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
