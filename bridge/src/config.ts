import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const httpsUrl = z.string().url().refine(s => new URL(s).protocol === 'https:', 'Use HTTPS');
export const configSchema = z.object({
  deviceToken: z.string().min(32),
  host: z.string().default('0.0.0.0'),
  port: z.number().int().min(1024).max(65535).default(4211),
  localPort: z.number().int().min(1024).max(65535).default(4210),
  herdr: z.object({ binary: z.string(), session: z.string().regex(/^[a-zA-Z0-9_-]+$/), configPath: z.string().optional() }),
  projects: z.array(z.object({ id: z.string().regex(/^[a-z0-9_-]+$/), name: z.string().min(1).max(60), path: z.string().refine(s => s.startsWith('/')), trusted: z.boolean().optional() })).default([]),
  agents: z.array(z.enum(['codex', 'claude', 'pi'])).default(['codex', 'claude', 'pi']),
  codexBinary: z.string().optional(),
  speech: z.object({ whisper: z.string(), model: z.string(), ffmpeg: z.string().default('ffmpeg'), lame: z.string().optional(), voice: z.string().default('Samantha'),
    engine: z.enum(['kokoro', 'macos']).optional(), neuralVoice: z.enum(['af_heart', 'af_bella', 'am_michael', 'bf_emma']).optional(),
    python: z.string().optional(), kokoro: z.string().optional(), helper: z.string().optional(),
  }),
  grok: z.object({ name: z.string().min(1).max(60).default('Grok Bot'), webhook: httpsUrl, key: z.string().min(1), replyKey: z.string().min(32) }).optional(),
}).strict();
export type Config = z.infer<typeof configSchema>;
export const localDir = resolve(process.env.MAESTRO_DATA ?? '.local');
export function readConfig(): Config {
  return configSchema.parse(JSON.parse(readFileSync(resolve(localDir, 'config.json'), 'utf8')));
}
