import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

interface Item { type: string; text?: string; phase?: string; content?: { type: string; text?: string }[] }
export interface CodexTurn { id?: string; status: string; startedAt?: number; items: Item[] }

/** Select only a completed turn with our exact input and submission time. */
export function matchingReply(turns: CodexTurn[], input: string, since: number, before = new Set<string>()): string[] {
  return turns.filter(turn => turn.status === 'completed' && turn.startedAt != null && turn.startedAt >= Math.floor(since / 1000)
    && (!turn.id || !before.has(turn.id))
    && turn.items.some(item => item.type === 'userMessage'
      && item.content?.filter(c => c.type === 'text').map(c => c.text).join('\n').trim() === input.trim()))
    .flatMap(turn => {
      const final = turn.items.filter(i => i.type === 'agentMessage' && i.phase === 'final_answer' && i.text);
      return final.length ? [final.map(i => i.text).join('\n\n')] : [];
    });
}

/**
 * Read-only app-server client. It never starts/resumes a thread or answers an
 * approval. Ambiguous matches fall back to the terminal view.
 */
export async function readCodexTurns(binary: string, threadId: string): Promise<CodexTurn[]> {
  const child = spawn(binary, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = createInterface({ input: child.stdout });
  let id = 0, received = 0, closed = false;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const fail = () => { closed = true; for (const p of pending.values()) p.reject(new Error('Codex reply reader closed.')); pending.clear(); };
  child.on('error', fail); child.on('exit', fail);
  child.stdin.on('error', fail);
  lines.on('line', line => {
    received += line.length;
    if (received > 4_000_000) { fail(); child.kill(); return; }
    try {
      const message = JSON.parse(line), p = pending.get(message.id);
      if (p) {
        pending.delete(message.id);
        if (message.error) p.reject(new Error('Codex read API rejected the request.')); else p.resolve(message.result);
      } else if (message.method && message.id !== undefined) {
        // No action is authorized by this read-only client.
        child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Read-only client' } }) + '\n');
      }
    } catch { fail(); child.kill(); }
  });
  const timeout = setTimeout(() => { fail(); child.kill(); }, 10_000);
  const call = <T>(method: string, params: unknown) => new Promise<T>((resolve, reject) => {
    if (closed) { reject(new Error('Codex reply reader closed.')); return; }
    const request = ++id; pending.set(request, { resolve: v => resolve(v as T), reject });
    child.stdin.write(JSON.stringify({ id: request, method, params }) + '\n');
  });
  try {
    await call('initialize', { clientInfo: { name: 'maestro_reply_reader', version: '0.1.0' } });
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    // Herdr identifies the conversation. Listing all project chats is slow and
    // cannot bind a reply to the selected terminal when prompts are repeated.
    const result = await call<{ data: CodexTurn[] }>('thread/turns/list', {
      threadId, limit: 20, itemsView: 'full', sortDirection: 'desc',
    });
    return result.data;
  }
  finally {
    clearTimeout(timeout); fail(); lines.close(); child.stdin.end(); child.kill();
  }
}
