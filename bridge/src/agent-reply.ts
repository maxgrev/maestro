import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { matchingReply, readCodexTurns, readCodexFinal, withCodexReader } from './codex-reply.js';
import { UserError } from './types.js';
import type { Agent, HerdrCall } from './herdr.js';

const exec = promisify(execFile);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Message = { id?: string; role?: string; content?: unknown; stop_reason?: string | null; stopReason?: string };
export type ReplyMessage = { id: string; role: string; message: Message };

export function textContent(content: unknown): string {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter(c => c?.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n') : '';
}

/** Only a new, complete answer following this exact input on the active branch. */
export function finalReply(messages: ReplyMessage[], before: Set<string>, input: string): string | undefined {
  const fresh = messages.filter(m => !before.has(m.id));
  const users = fresh.filter(m => m.role === 'user' && textContent(m.message.content).trim());
  if (users.length !== 1 || textContent(users[0]!.message.content).trim() !== input.trim()) return;
  const after = fresh.slice(fresh.indexOf(users[0]!) + 1);
  const last = after.at(-1);
  if (last?.role !== 'assistant' || !['end_turn', 'stop'].includes(last.message.stop_reason ?? last.message.stopReason ?? '')) return;
  // Claude stores one entry per streamed content block, sharing the model's
  // message ID. Collect the final generation, excluding earlier tool calls.
  const parts = last.message.id ? after.filter(m => m.role === 'assistant' && m.message.id === last.message.id) : [last];
  return parts.map(m => textContent(m.message.content).trim()).filter(Boolean).join('\n\n') || undefined;
}

interface PiEntry { type: string; id: string; parentId?: string | null; message?: Message; version?: number; cwd?: string }
export function piMessages(entries: PiEntry[]): ReplyMessage[] {
  if (entries[0]?.type !== 'session' || entries[0].version !== 3) throw new Error('Unsupported Pi session format.');
  const nodes = new Map(entries.slice(1).map(e => [e.id, e]));
  const chain: PiEntry[] = [], seen = new Set<string>();
  let entry = entries.at(-1);
  while (entry && entry.type !== 'session') {
    if (seen.has(entry.id)) throw new Error('Invalid Pi session branch.');
    seen.add(entry.id); chain.unshift(entry);
    if (entry.parentId && !nodes.has(entry.parentId)) throw new Error('Incomplete Pi session branch.');
    entry = entry.parentId ? nodes.get(entry.parentId) : undefined;
  }
  return chain.filter(e => e.type === 'message' && e.message).map(e => ({ id: e.id, role: e.message!.role ?? '', message: e.message! }));
}

async function nativeSession(agent: Agent, call: HerdrCall): Promise<string> {
  const session = agent.agent_session;
  if (session && typeof session === 'object' && 'value' in session && typeof session.value === 'string') return session.value;
  // Sessions opened before Herdr's hook was installed still own their exact
  // rollout file. Inspect only that pane's processes, never search other chats.
  if (agent.agent === 'codex' && process.platform === 'darwin') {
    const result = await call(['pane', 'process-info', '--pane', agent.pane_id]);
    const files = new Set<string>();
    for (const proc of result.process_info?.foreground_processes ?? []) {
      if (!/^codex(?:\.real)?$/.test(proc.name) || !Number.isSafeInteger(proc.pid)) continue;
      const { stdout } = await exec('/usr/sbin/lsof', ['-p', String(proc.pid), '-Fn'], { timeout: 3000, maxBuffer: 512_000 }).catch(() => ({ stdout: '' }));
      for (const line of stdout.split('\n')) if (/^n.*\/rollout-.*\.jsonl$/.test(line)) files.add(line.slice(1));
    }
    if (files.size === 1) {
      const id = basename([...files][0]!).match(/([0-9a-f-]{36})\.jsonl$/i)?.[1];
      if (id && uuid.test(id)) return id;
    }
  }
  throw new UserError('Reconnect this agent in Maestro so its conversation can be identified. No message was sent.', 409);
}

export type ReplyCapture = ((input: string, since: number) => Promise<string | undefined>) & { sourceKey?: string };
export function messageReplyKey(provider: string, session: string, message: ReplyMessage) {
  return `${provider}:${basename(session, '.jsonl')}:${message.message.id ?? message.id}`;
}
export function completedMessages(messages: ReplyMessage[]) {
  const records = new Map<string, { message: ReplyMessage; text: string; reply: string }>();
  let input = '';
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === 'user' && textContent(m.message.content).trim()) input = textContent(m.message.content).trim();
    if (m.role !== 'assistant' || !['end_turn', 'stop'].includes(m.message.stop_reason ?? m.message.stopReason ?? '')) continue;
    const parts = m.message.id ? messages.slice(0, i + 1).filter(x => x.role === 'assistant' && x.message.id === m.message.id) : [m];
    const reply = parts.map(x => textContent(x.message.content).trim()).filter(Boolean).join('\n\n');
    if (reply) records.set(m.message.id ?? m.id, { message: m, text: input, reply });
  }
  return [...records.values()];
}
export async function captureReply(agent: Agent, call: HerdrCall, codex?: string, newCodexSession = false): Promise<ReplyCapture> {
  // Codex creates its first native thread only when the first prompt arrives.
  // This path is allowed solely for a fresh pane Maestro just launched, whose
  // history is known to be empty. Existing chats must bind before dispatch.
  if (newCodexSession && agent.agent === 'codex' && !agent.agent_session) {
    if (!codex) throw new UserError('Codex is unavailable.', 503);
    const reader: ReplyCapture = async (input, since) => {
      const current = (await call(['agent', 'get', agent.pane_id])).agent;
      if (!current || current.terminal_id !== agent.terminal_id || current.agent !== 'codex') throw new Error('Codex session changed.');
      const session = await nativeSession(current, call);
      if (!uuid.test(session)) throw new Error('Invalid Codex session.');
      const turns = (await readCodexTurns(codex, session)).filter(t => matchingReply([t], input, since).length);
      if (turns.length !== 1) return;
      reader.sourceKey = `codex:${session}:${turns[0]!.id}`;
      return withCodexReader(codex, call => readCodexFinal(call, session, turns[0]!.id!));
    };
    return reader;
  }
  const session = await nativeSession(agent, call);
  if (agent.agent === 'codex') {
    if (!codex || !uuid.test(session)) throw new UserError('Codex session is unavailable. Reconnect it in Maestro.', 409);
    const before = new Set((await readCodexTurns(codex, session)).flatMap(t => t.id ? [t.id] : []));
    const reader: ReplyCapture = async (input, since) => {
      const turns = (await readCodexTurns(codex, session)).filter(t => matchingReply([t], input, since, before).length);
      if (turns.length !== 1) return;
      reader.sourceKey = `codex:${session}:${turns[0]!.id}`;
      return withCodexReader(codex, call => readCodexFinal(call, session, turns[0]!.id!));
    };
    return reader;
  }
  let read: () => Promise<ReplyMessage[]>;
  if (agent.agent === 'claude') {
    const id = basename(session, '.jsonl');
    if (!uuid.test(id) || !agent.cwd) throw new UserError('Claude’s session is unavailable. Reconnect it in Maestro.', 409);
    const dir = agent.cwd;
    read = async () => (await getSessionMessages(id, { dir })).filter(m => !m.parent_tool_use_id && !m.parent_agent_id)
      .map(m => ({ id: m.uuid, role: m.type, message: m.message as Message }));
  } else if (agent.agent === 'pi' && isAbsolute(session) && session.endsWith('.jsonl')) {
    read = async () => {
      // Pi deliberately creates its session file only on the first assistant
      // response. Its SessionStart hook already supplies the reserved path.
      const info = await stat(session).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return; throw error; });
      if (!info || !info.size) return [];
      if (info.size > 32_000_000) throw new Error('Pi session is too large to read.');
      const text = await readFile(session, 'utf8');
      // Ignore only the unfinished final line while the agent flushes its file.
      return piMessages(text.slice(0, text.lastIndexOf('\n')).split('\n').filter(Boolean).map(line => JSON.parse(line)));
    };
  } else throw new UserError('This agent has no supported reply reader.', 409);
  const before = new Set((await read()).map(m => m.id));
  const reader: ReplyCapture = async input => {
    const messages = await read(), reply = finalReply(messages, before, input);
    if (reply) reader.sourceKey = messageReplyKey(agent.agent!, session, messages.at(-1)!);
    return reply;
  };
  return reader;
}
