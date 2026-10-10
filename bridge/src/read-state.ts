import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { Inbox } from './inbox.js';

// Codex's versioned desktop state exposes unread membership, not read times.
// Only an observed unread -> read transition clears known replies. Absence at
// startup, a missing file, or a different account is never proof of a read.
const stateSchema = z.object({
  version: z.literal(1),
  unreadByIdentity: z.record(z.string(), z.record(z.string(), z.array(z.string().uuid()))),
});
type Snapshot = { at: number; ids: string[] };

export function applyCodexReads(inbox: Inbox, value: unknown, now = Date.now()) {
  const parsed = stateSchema.safeParse(value);
  if (!parsed.success) return;
  for (const [identity, hosts] of Object.entries(parsed.data.unreadByIdentity)) {
    for (const [host, ids] of Object.entries(hosts)) {
      if (!host.startsWith('local:')) continue; // This bridge reads local threads only.
      const key = `codex-read-state:${identity}:${host}`;
      const before = inbox.cursor<Snapshot>(key);
      const unread = new Set(ids);
      if (before) for (const id of before.ids) {
        if (!unread.has(id)) inbox.readThrough(`codex:${id}`, before.at);
      }
      inbox.saveCursor(key, { at: now, ids });
    }
  }
}

export async function syncCodexReads(inbox: Inbox) {
  try {
    const file = join(process.env.CODEX_HOME || join(homedir(), '.codex'), '.codex-global-state.json');
    const state = JSON.parse(await readFile(file, 'utf8'));
    applyCodexReads(inbox, state['electron-thread-read-state-v1']);
  } catch { /* Unsupported or mid-write state must leave receipts unread. */ }
}
