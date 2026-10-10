import { readFile, readdir, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { getSessionMessages, listSessions } from '@anthropic-ai/claude-agent-sdk';
import { completedMessages, messageReplyKey, piMessages, type ReplyMessage } from './agent-reply.js';
import { withCodexReader, readCodexFinal, type CodexThread, type CodexTurn } from './codex-reply.js';
import { agentBinary } from './agent-setup.js';
import type { Config } from './config.js';
import type { Inbox, InboxTarget } from './inbox.js';
import type { Herdr, Agent } from './herdr.js';

type Cursor = { stamp: number; keys: string[] };
type Found = { key: string; reply: string; at?: number };

/** Keep final answers only. Never submit a prompt, resume a session, or grant approval. */
export class Observer {
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private stopped = false;
  private epoch: number;
  readonly warnings = new Set<string>();
  constructor(private config: Config, private inbox: Inbox, private herdr: Herdr) {
    this.epoch = inbox.cursor<number>('started') ?? Date.now();
    inbox.saveCursor('started', this.epoch);
  }
  start() {
    const tick = () => {
      this.running = this.scan().catch(() => { this.warnings.add('Inbox'); }).finally(() => {
        if (!this.stopped) this.timer = setTimeout(tick, 5000);
      });
    };
    tick();
  }
  async stop() { this.stopped = true; clearTimeout(this.timer); await this.running; }
  accept(source: string, stamp: number, target: InboxTarget, found: Found[]) {
    const cursor = this.inbox.cursor<Cursor>(source);
    const seen = new Set(cursor?.keys ?? []);
    for (const item of found) {
      // First scan baselines history. Explicit provider completion timestamps
      // also catch a turn that finished while Maestro was stopped.
      if (!seen.has(item.key) && (item.at != null ? item.at >= this.epoch : !!cursor)) {
        this.inbox.add({ key: item.key, target, reply: item.reply, created: item.at });
      }
    }
    this.inbox.saveCursor(source, { stamp, keys: [...new Set([...seen, ...found.map(i => i.key)])].slice(-2000) });
  }
  private async scan() {
    let sessions: { agent: Agent; target: InboxTarget }[] = [];
    try { sessions = await this.herdr.sessions(); this.warnings.delete('Herdr'); } catch { this.warnings.add('Herdr'); }
    const targetFor = (provider: string, session: string, fallback: InboxTarget) => sessions.find(s =>
      s.agent.agent === provider && s.agent.agent_session && typeof s.agent.agent_session === 'object'
      && 'value' in s.agent.agent_session && basename(String(s.agent.agent_session.value), '.jsonl') === basename(session, '.jsonl'))?.target ?? fallback;
    const work: [string, () => Promise<void>][] = [
      ['Codex', () => this.codex(targetFor)], ['Claude', () => this.claude(targetFor)], ['Pi', () => this.pi(targetFor)],
    ];
    await Promise.all(work.map(async ([name, run]) => {
      try { this.warnings.delete(name); await run(); } catch { this.warnings.add(name); }
    }));
    for (const { agent, target } of sessions) {
      const key = `status:${target.id}`, previous = this.inbox.cursor<string>(key);
      if (agent.agent_status === 'blocked' && previous != null && previous !== 'blocked') this.inbox.add({
        key: `${key}:${Date.now()}`, target, attention: true, reply: `${target.name} needs your attention. Open the agent on your Mac.`,
      });
      this.inbox.saveCursor(key, agent.agent_status);
    }
  }
  private async codex(targetFor: (p: string, s: string, t: InboxTarget) => InboxTarget) {
    const binary = this.config.codexBinary ?? agentBinary('codex');
    if (!binary) return;
    const threads = await withCodexReader(binary, async call => {
      const result: CodexThread[] = [];
      let cursor: string | undefined;
      do {
        const page = await call<{ data: CodexThread[]; nextCursor?: string }>('thread/list', {
          cursor, limit: 50, sortKey: 'updated_at', sortDirection: 'desc', archived: false, useStateDbOnly: true,
          sourceKinds: ['cli', 'vscode', 'exec', 'appServer'],
        });
        result.push(...page.data.filter(t => t.updatedAt * 1000 >= this.epoch));
        if (page.data.some(t => t.updatedAt * 1000 < this.epoch)) break;
        cursor = page.nextCursor;
      } while (cursor && !this.stopped);
      return result;
    });
    for (const thread of threads) {
      if (this.stopped) break;
      const source = `codex:${thread.id}`, stamp = thread.updatedAt;
      if (this.inbox.cursor<Cursor>(source)?.stamp === stamp && Date.now() - stamp * 1000 > 60_000) continue;
      try {
        const found = await withCodexReader(binary, async call => {
          const found: Found[] = [];
          let cursor: string | undefined;
          do {
            const page = await call<{ data: CodexTurn[]; nextCursor?: string }>('thread/turns/list', {
              threadId: thread.id, cursor, limit: 20, itemsView: 'notLoaded', sortDirection: 'desc',
            });
            for (const t of page.data) {
              if (!t.id || t.status !== 'completed') continue;
              if (t.completedAt != null && t.completedAt * 1000 < this.epoch) return found.reverse();
              if (this.inbox.cursor<Cursor>(source)?.keys.includes(`${source}:${t.id}`)) continue;
              const reply = await readCodexFinal(call, thread.id, t.id);
              if (reply) found.push({ key: `${source}:${t.id}`, reply, at: t.completedAt == null ? undefined : t.completedAt * 1000 });
            }
            cursor = page.nextCursor;
          } while (cursor && !this.stopped);
          return found.reverse();
        });
        this.accept(source, stamp, targetFor('codex', thread.id, {
          id: source, name: `Codex / ${thread.name || thread.preview.slice(0, 70) || 'Conversation'}`, detail: thread.cwd, character: 'codex',
        }), found);
      } catch { this.warnings.add('Codex'); }
    }
  }

  private async claude(targetFor: (p: string, s: string, t: InboxTarget) => InboxTarget) {
    const root = join(homedir(), '.claude/projects');
    const directories = await readdir(root, { withFileTypes: true }).catch(() => []);
    let offset = 0;
    for (;;) {
      const sessions = await listSessions({ limit: 50, offset });
      for (const session of sessions) {
        if (session.lastModified < this.epoch) continue;
        const source = `claude:${session.sessionId}`;
        if (this.inbox.cursor<Cursor>(source)?.stamp === session.lastModified) continue;
        try {
        const messages = (await getSessionMessages(session.sessionId, { dir: session.cwd }))
          .filter(m => !m.parent_tool_use_id && !m.parent_agent_id)
          .map(m => ({ id: m.uuid, role: m.type, message: m.message })) as ReplyMessage[];
        // The official reader selects the active branch. Use transcript rows
        // only for timestamps, which its public message type does not retain.
        let times = new Map<string, number>();
        for (const dir of directories) {
          if (!dir.isDirectory()) continue;
          const path = join(root, dir.name, session.sessionId + '.jsonl');
          const info = await stat(path).catch(() => undefined);
          if (!info || info.size > 32_000_000) continue;
          const rows = await jsonLines(path);
          times = new Map(rows.filter(r => r.uuid && r.timestamp).map(r => [r.uuid, Date.parse(r.timestamp)]));
          break;
        }
        this.accept(source, session.lastModified, targetFor('claude', session.sessionId, {
          id: source, name: `Claude Code / ${session.customTitle || session.summary || 'Conversation'}`, detail: session.cwd, character: 'claude',
        }), completedMessages(messages).map(r => ({ key: messageReplyKey('claude', session.sessionId, r.message), reply: r.reply, at: times.get(r.message.id) })));
        } catch { this.warnings.add('Claude'); }
      }
      if (sessions.length < 50) break;
      offset += sessions.length;
    }
  }
  private async pi(targetFor: (p: string, s: string, t: InboxTarget) => InboxTarget) {
    const root = join(homedir(), '.pi/agent/sessions');
    const files = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
      try {
      const path = join(file.parentPath, file.name), info = await stat(path);
      const source = `pi:${basename(path, '.jsonl')}`;
      if (info.mtimeMs < this.epoch || info.size > 32_000_000 || this.inbox.cursor<Cursor>(source)?.stamp === info.mtimeMs) continue;
      const rows = await jsonLines(path), messages = piMessages(rows);
      const times = new Map(rows.filter(r => r.id && r.timestamp).map(r => [r.id, Date.parse(r.timestamp)]));
      this.accept(source, info.mtimeMs, targetFor('pi', path, {
        id: source, name: `Pi / ${rows[0]?.cwd ? basename(rows[0].cwd) : 'Conversation'}`, detail: rows[0]?.cwd, character: 'pi',
      }), completedMessages(messages).map(r => ({ key: messageReplyKey('pi', path, r.message), reply: r.reply, at: times.get(r.message.id) })));
      } catch { this.warnings.add('Pi'); }
    }
  }
}

async function jsonLines(path: string): Promise<any[]> {
  const text = await readFile(path, 'utf8');
  return text.slice(0, text.lastIndexOf('\n')).split('\n').filter(Boolean).map(line => JSON.parse(line));
}
