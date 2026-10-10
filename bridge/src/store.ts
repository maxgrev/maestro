import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { UserError, type State, type Target, type Turn } from './types.js';
import { Inbox } from './inbox.js';

type Row = { id: string; fingerprint: string; target: string; state: State; text: string; reply: string; output: string; error: string; created: number; updated: number };
const decode = ({ fingerprint: _fingerprint, ...row }: Row): Turn => ({ ...row, target: JSON.parse(row.target) as Target });

export class Store {
  private readonly changes = new EventEmitter();
  readonly db: DatabaseSync;
  readonly inbox: Inbox;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, target TEXT NOT NULL,
        state TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', reply TEXT NOT NULL DEFAULT '',
        output TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL, updated INTEGER NOT NULL
      );`);
    this.inbox = new Inbox(this.db);
    if (!this.inbox.cursor('history-imported')) {
      for (const turn of this.list().reverse()) if (turn.reply && ['done', 'needs_attention'].includes(turn.state)) {
        this.inbox.add({ key: `turn:${turn.id}:${turn.state}`, target: turn.target, turn: turn.id,
          reply: turn.reply, attention: turn.state === 'needs_attention', created: turn.updated, read: true });
      }
      this.inbox.saveCursor('history-imported', true);
    }
  }
  recover() {
    const rows = this.db.prepare("SELECT * FROM turns WHERE state IN ('dispatching','working','queued','transcribing')").all() as Row[];
    for (const row of rows) {
      const sent = ['dispatching', 'working'].includes(row.state);
      this.write(decode(row), { state: sent ? 'uncertain' : 'failed', error: sent
        ? 'Bridge restarted. Check the agent before sending again.' : 'Bridge restarted before submission. Record a new request.' });
    }
  }
  expireCallbacks(now = Date.now()) {
    const rows = this.db.prepare(`SELECT * FROM turns WHERE state='working'
      AND json_extract(target, '$.provider')='grok' AND updated<=?`).all(now - 120_000) as Row[];
    for (const row of rows) this.write(decode(row), { state: 'uncertain',
      error: 'Grok received this request, but its reply is delayed. Keep Grok Bot open on your Mac and check its computer connection. A late reply will appear here; do not resend the task.' });
    const dots = this.db.prepare(`SELECT * FROM turns WHERE state='working'
      AND json_extract(target, '$.provider')='dot' AND updated<=?`).all(now - 600_000) as Row[];
    for (const row of dots) this.write(decode(row), { state: 'uncertain',
      error: 'Dot has not replied yet. Check your Dot before sending again. A late reply will still appear here.' });
  }
  get(id: string): Turn | undefined {
    this.expireCallbacks();
    const row = this.db.prepare('SELECT * FROM turns WHERE id=?').get(id) as Row | undefined;
    return row && decode(row);
  }
  waitForReply(id: string, milliseconds: number, signal?: AbortSignal): Promise<Turn | undefined> {
    const current = this.get(id);
    const pending = (turn?: Turn) => turn && ['queued', 'transcribing', 'dispatching', 'working'].includes(turn.state);
    if (!pending(current) || milliseconds <= 0 || signal?.aborted) return Promise.resolve(current);
    return new Promise(resolve => {
      const finish = () => {
        clearTimeout(timer);
        this.changes.off(id, changed);
        this.changes.off('closing', finish);
        signal?.removeEventListener('abort', finish);
        resolve(this.get(id));
      };
      const changed = (turn: Turn) => { if (!pending(turn)) finish(); };
      const timer = setTimeout(finish, milliseconds);
      this.changes.on(id, changed);
      this.changes.on('closing', finish);
      signal?.addEventListener('abort', finish, { once: true });
    });
  }
  list(): Turn[] { this.expireCallbacks(); return (this.db.prepare('SELECT * FROM turns ORDER BY created DESC LIMIT 50').all() as Row[]).map(decode); }
  conversationHistory(targetId: string) {
    // Query this conversation directly; activity in other agents must not erase its context.
    const rows = this.db.prepare(`SELECT id, text, reply, state FROM turns
      WHERE json_extract(target, '$.id')=? AND state IN ('done','needs_attention') AND reply<>''
      ORDER BY created DESC, rowid DESC LIMIT 12`).all(targetId) as Pick<Row, 'id' | 'text' | 'reply' | 'state'>[];
    const history = [];
    let remaining = 24_000;
    for (const row of rows) {
      const size = row.text.length + row.reply.length;
      if (size > remaining) break;
      remaining -= size;
      history.push({ request_id: row.id, message: row.text, reply: row.reply, needs_attention: row.state === 'needs_attention' });
    }
    return history.reverse();
  }
  fingerprint(targetId: string, body: string | Buffer): string {
    return createHash('sha256').update(targetId).update('\0').update(body).digest('hex');
  }
  existing(id: string, fingerprint: string): Turn | undefined {
    const row = this.db.prepare('SELECT * FROM turns WHERE id=?').get(id) as Row | undefined;
    if (!row) return;
    if (row.fingerprint !== fingerprint) throw new UserError('This request ID was already used for different content.', 409);
    return decode(row);
  }
  create(id: string, fingerprint: string, target: Target, text: string): Turn {
    this.expireCallbacks();
    // No await between checking and insertion: one bridge process owns this database.
    if (this.db.prepare("SELECT 1 FROM turns WHERE json_extract(target, '$.id')=? AND state IN ('queued','transcribing','dispatching','working') LIMIT 1").get(target.id)) {
      throw new UserError('This conversation already has a request in progress.', 409);
    }
    const now = Date.now();
    this.db.prepare("INSERT INTO turns(id,fingerprint,target,state,text,created,updated) VALUES(?,?,?,'queued',?,?,?)")
      .run(id, fingerprint, JSON.stringify(target), text, now, now);
    return this.get(id)!;
  }
  update(id: string, changes: Partial<Pick<Turn, 'state' | 'text' | 'reply' | 'output' | 'error' | 'target'>> & { sourceKey?: string }) {
    const current = this.get(id);
    if (!current) throw new UserError('Request not found.', 404);
    return this.write(current, changes);
  }
  private write(current: Turn, changes: Partial<Turn> & { sourceKey?: string }): Turn {
    const next = { ...current, ...changes, updated: Date.now() };
    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE turns SET state=?,text=?,reply=?,output=?,error=?,target=?,updated=? WHERE id=?')
        .run(next.state, next.text, next.reply, next.output, next.error, JSON.stringify(next.target), next.updated, next.id);
      if (['done', 'needs_attention', 'failed', 'uncertain'].includes(next.state)) this.inbox.add({
        key: changes.sourceKey ?? `turn:${next.id}:${next.state}`, target: next.target, turn: next.id,
        reply: next.reply || next.error, attention: next.state !== 'done',
      });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    const { sourceKey: _key, ...turn } = next;
    this.changes.emit(turn.id, turn);
    return turn;
  }
  close() { this.changes.emit('closing'); this.db.close(); }
}
