import { readFile, readdir, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { getSessionMessages, listSessions } from '@anthropic-ai/claude-agent-sdk';
import { completedMessages, messageReplyKey, piMessages, type ReplyMessage } from './agent-reply.js';
import { withCodexReader, readCodexFinal, type CodexThread, type CodexTurn } from './codex-reply.js';
import { agentBinary } from './agent-setup.js';
import { syncCodexReads } from './read-state.js';
import type { Config } from './config.js';
import type { Inbox, InboxTarget } from './inbox.js';
import type { Herdr, Agent } from './herdr.js';
import { historyPrompt } from './conversations.js';

type Cursor = { stamp: number; keys: string[]; version?: 1 };
type Found = { key: string; reply: string; at?: number; read?: boolean; text?: string };

/** Collect final answers; explicit history reads also load prompts. Never resume a session or grant approval. */
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
    this.inbox.describeSource(source, target);
    const cursor = this.inbox.cursor<Cursor>(source);
    const seen = new Set(cursor?.keys ?? []);
    for (const item of found) {
      // First scan baselines history. Explicit provider completion timestamps
      // also catch a turn that finished while Maestro was stopped.
      if (!seen.has(item.key) && (item.at != null ? item.at >= this.epoch : !!cursor)) {
        this.inbox.add({ key: item.key, target, reply: item.reply, text: item.text, created: item.at, read: item.read });
      }
    }
    this.inbox.readSources(found.filter(item => item.read).map(item => item.key));
    this.inbox.saveCursor(source, { stamp, version: 1, keys: [...new Set([...seen, ...found.map(i => i.key)])].slice(-2000) });
  }
  private async scan() {
    await syncCodexReads(this.inbox);
    let sessions: { agent: Agent; target: InboxTarget }[] = [];
    try { sessions = await this.herdr.sessions(); this.warnings.delete('Herdr'); } catch { this.warnings.add('Herdr'); }
    const targetFor = (provider: string, session: string, fallback: InboxTarget) => {
      const active = sessions.find(s => s.agent.agent === provider && s.agent.agent_session && typeof s.agent.agent_session === 'object'
        && 'value' in s.agent.agent_session && basename(String(s.agent.agent_session.value),'.jsonl')===basename(session,'.jsonl'))?.target;
      return active ? {...fallback,...active,detail:fallback.detail||active.detail} : fallback;
    };
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
      const target = targetFor('codex', thread.id, {
        id: source, session: source, cwd: thread.cwd, name: 'Codex', detail: thread.name || thread.preview.slice(0, 70) || '', character: 'codex',
      });
      this.inbox.describeSource(source, target);
      if (this.inbox.cursor<Cursor>(source)?.stamp === stamp && Date.now() - stamp * 1000 > 60_000
        && !this.inbox.cursor<{busy:boolean}>('activity:'+source)?.busy) continue;
      try {
        const found = await withCodexReader(binary, async call => {
          const found: Found[] = [];
          let cursor: string | undefined;
          do {
            const page = await call<{ data: CodexTurn[]; nextCursor?: string }>('thread/turns/list', {
              threadId: thread.id, cursor, limit: 20, itemsView: 'summary', sortDirection: 'desc',
            });
            if (!cursor) this.inbox.saveCursor('activity:'+source,{busy:page.data.some(turn=>turn.status==='inProgress'),at:Date.now()});
            for (const t of page.data) {
              if (!t.id || t.status !== 'completed') continue;
              if (t.completedAt != null && t.completedAt * 1000 < this.epoch) return found.reverse();
              if (this.inbox.cursor<Cursor>(source)?.keys.includes(`${source}:${t.id}`)) continue;
              const reply = await readCodexFinal(call, thread.id, t.id);
              if (reply) found.push({ key: `${source}:${t.id}`, reply, text: codexInput(t), at: t.completedAt == null ? undefined : t.completedAt * 1000 });
            }
            cursor = page.nextCursor;
          } while (cursor && !this.stopped);
          return found.reverse();
        });
        this.accept(source, stamp, target, found);
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
        const cursor = this.inbox.cursor<Cursor>(source);
        if (cursor?.version === 1 && cursor.stamp === session.lastModified) continue;
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
          times = messageTimes(rows,'uuid');
          break;
        }
        this.accept(source, session.lastModified, targetFor('claude', session.sessionId, {
          id: source, session: source, cwd: session.cwd, name: 'Claude Code', detail: session.customTitle || session.summary || '', character: 'claude',
        }), completedMessages(messages).map(r => ({ key: messageReplyKey('claude', session.sessionId, r.message), reply: r.reply, text: historyPrompt(r.text), read: r.read, at: times.get(r.message.id) })));
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
      const cursor = this.inbox.cursor<Cursor>(source);
      if (info.mtimeMs < this.epoch || info.size > 32_000_000 || (cursor?.version === 1 && cursor.stamp === info.mtimeMs)) continue;
      const rows = await jsonLines(path), messages = piMessages(rows);
      const times = messageTimes(rows,'id');
      this.accept(source, info.mtimeMs, targetFor('pi', path, {
        id: source, session: source, cwd: rows[0]?.cwd, sessionPath: path, name: 'Pi', detail: rows.findLast(r => r.type === 'session_info' && typeof r.name === 'string')?.name ?? '', character: 'pi',
      }), completedMessages(messages).map(r => ({ key: messageReplyKey('pi', path, r.message), reply: r.reply, text: r.text, read: r.read, at: times.get(r.message.id) })));
      } catch { this.warnings.add('Pi'); }
    }
  }

  /** Import one requested history page. Older history never becomes a new alert. */
  async history(id: string, cursor?: string) {
    let target = this.inbox.conversationTarget(id)
      ?? (await this.herdr.sessions()).find(session => session.target.session === id)?.target;
    if (!target || !/^(codex|claude|pi):/.test(id)) return { next: null };
    const [provider,session] = id.split(':') as [string,string];
    const save = (item: Found) => this.inbox.add({ key: item.key,target: target!,reply: item.reply,text: historyPrompt(item.text ?? ''),
      created: item.at,read: this.inbox.bySource(item.key)?.read ?? (item.at == null || item.at < this.epoch) });
    if (provider === 'codex') {
      const binary = this.config.codexBinary ?? agentBinary('codex');
      if (!binary) return { next: null, warning: 'Install Codex in Setup to load earlier messages.' };
      return withCodexReader(binary,async call => {
        if (!target!.cwd) {
          const result = await call<{thread:CodexThread}>('thread/read',{threadId:session,includeTurns:false});
          if (result.thread?.cwd) {
            target={...target!,cwd:result.thread.cwd};this.inbox.describeSource(id,target);
          }
        }
        const page = await call<{data: CodexTurn[];nextCursor?: string}>('thread/turns/list', {
          threadId: session,cursor,limit: 20,itemsView: 'summary',sortDirection: 'desc',
        });
        const busy = page.data.some(turn=>turn.status==='inProgress');
        if (!cursor) this.inbox.saveCursor('activity:'+id,{busy,at:Date.now()});
        for (const turn of [...page.data].reverse()) {
          if (!turn.id || turn.status !== 'completed') continue;
          const reply = turn.items.filter(item => item.type === 'agentMessage' && item.phase === 'final_answer').map(item => item.text).filter(Boolean).join('\n\n')
            || await readCodexFinal(call,session,turn.id);
          if (reply) save({ key: `${id}:${turn.id}`,reply,text: codexInput(turn),at: turn.completedAt == null ? undefined : turn.completedAt*1000 });
        }
        return { next: page.nextCursor ?? null,busy };
      });
    }
    let messages: ReplyMessage[], times = new Map<string,number>();
    if (provider === 'claude') {
      messages = (await getSessionMessages(session,{dir: target.cwd})).filter(message => !message.parent_tool_use_id && !message.parent_agent_id)
        .map(message => ({ id: message.uuid,role: message.type,message: message.message })) as ReplyMessage[];
      const root = join(homedir(),'.claude/projects');
      for (const directory of await readdir(root,{withFileTypes:true}).catch(() => [])) {
        const path = join(root,directory.name,session+'.jsonl');
        const info=await stat(path).catch(()=>undefined);
        if (!directory.isDirectory() || !info || info.size>32_000_000) continue;
        const rows = await jsonLines(path);
        times = messageTimes(rows,'uuid');
        const cwd=rows.find(row=>typeof row.cwd==='string')?.cwd;
        if (cwd) {target={...target,cwd};this.inbox.describeSource(id,target);}
        break;
      }
    } else {
      if (!target.sessionPath) {
        const root=join(homedir(),'.pi/agent/sessions');
        const file=(await readdir(root,{recursive:true,withFileTypes:true}).catch(()=>[]))
          .find(file=>file.isFile()&&basename(file.name,'.jsonl')===session);
        if (file) target={...target,sessionPath:join(file.parentPath,file.name)};
      }
      if (!target.sessionPath) return { next: null, warning: 'Open this Pi session on your Mac to load earlier messages.' };
      const info = await stat(target.sessionPath);
      if (info.size > 32_000_000) throw new Error('Pi history is too large to load.');
      const rows = await jsonLines(target.sessionPath);
      messages = piMessages(rows);
      times = messageTimes(rows,'id');
      target={...target,cwd:rows[0]?.cwd??target.cwd};this.inbox.describeSource(id,target);
    }
    const offset = cursor ? Number(cursor) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid history page.');
    const records = completedMessages(messages), end = Math.max(0,records.length-offset), start = Math.max(0,end-30);
    for (const record of records.slice(start,end)) save({ key: messageReplyKey(provider,session,record.message),reply: record.reply,
      text: record.text,at: times.get(record.message.id) });
    return { next: start ? String(offset+30) : null };
  }
}

function codexInput(turn: CodexTurn) {
  return turn.items.filter(item => item.type === 'userMessage').flatMap(item => item.content ?? [])
    .filter(content => content.type === 'text').map(content => content.text).filter(Boolean).join('\n');
}

async function jsonLines(path: string): Promise<any[]> {
  const text = await readFile(path, 'utf8');
  return text.slice(0, text.lastIndexOf('\n')).split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function messageTimes(rows:any[],field:'id'|'uuid') {
  const result=new Map<string,number>();
  for (const row of rows) {
    const at=Date.parse(row.timestamp);
    if (!Number.isFinite(at)) continue;
    if (typeof row[field]==='string') result.set(row[field],at);
    if (typeof row.message?.id==='string') result.set(row.message.id,at);
  }
  return result;
}
