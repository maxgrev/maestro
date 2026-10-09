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
        throw new Error('Transcription is unavailable. Run npm run doctor.');
      } finally { await rm(dir, { recursive: true, force: true }); }
    });
  }
  async speak(text: string, format: 'pcm' | 'mp3'): Promise<Buffer> {
    return this.exclusive(async () => {
      const dir = await mkdtemp(join(tmpdir(), 'maestro-tts-'));
      try {
        await writeFile(join(dir, 'reply.txt'), text.slice(0, 1800), { mode: 0o600 });
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
