import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { UserError, type State, type Target, type Turn } from './types.js';

type Row = { id: string; fingerprint: string; target: string; state: State; text: string; reply: string; output: string; error: string; created: number; updated: number };
const decode = ({ fingerprint: _fingerprint, ...row }: Row): Turn => ({ ...row, target: JSON.parse(row.target) as Target });

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, target TEXT NOT NULL,
        state TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', reply TEXT NOT NULL DEFAULT '',
        output TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL, updated INTEGER NOT NULL
      );`);
  }
  recover() {
    this.db.prepare("UPDATE turns SET state='uncertain', error='Bridge restarted. Check the agent before sending again.', updated=? WHERE state IN ('dispatching','working')").run(Date.now());
    this.db.prepare("UPDATE turns SET state='failed', error='Bridge restarted before submission. Record a new request.', updated=? WHERE state IN ('queued','transcribing')").run(Date.now());
  }
  expireGrok(now = Date.now()) {
    // The webhook only acknowledges receipt. A lost Mac callback must not leave
    // the conversation reserved forever. Late authenticated replies still win.
    this.db.prepare(`UPDATE turns SET state='uncertain', error=?, updated=?
      WHERE state='working' AND json_extract(target, '$.provider')='grok' AND updated<=?`)
      .run('Grok received this request, but its reply is delayed. Keep Grok Bot open on your Mac and check its computer connection. A late reply will appear here; do not resend the task.', now, now - 120_000);
  }
  get(id: string): Turn | undefined {
    this.expireGrok();
    const row = this.db.prepare('SELECT * FROM turns WHERE id=?').get(id) as Row | undefined;
    return row && decode(row);
  }
  list(): Turn[] { this.expireGrok(); return (this.db.prepare('SELECT * FROM turns ORDER BY created DESC LIMIT 50').all() as Row[]).map(decode); }
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
    this.expireGrok();
    // No await between checking and insertion: one bridge process owns this database.
    if (this.db.prepare("SELECT 1 FROM turns WHERE json_extract(target, '$.id')=? AND state IN ('queued','transcribing','dispatching','working') LIMIT 1").get(target.id)) {
      throw new UserError('This conversation already has a request in progress.', 409);
    }
    const now = Date.now();
    this.db.prepare("INSERT INTO turns(id,fingerprint,target,state,text,created,updated) VALUES(?,?,?,'queued',?,?,?)")
      .run(id, fingerprint, JSON.stringify(target), text, now, now);
    return this.get(id)!;
  }
  update(id: string, changes: Partial<Pick<Turn, 'state' | 'text' | 'reply' | 'output' | 'error' | 'target'>>) {
    const current = this.get(id);
    if (!current) throw new UserError('Request not found.', 404);
    const next = { ...current, ...changes };
    this.db.prepare('UPDATE turns SET state=?,text=?,reply=?,output=?,error=?,target=?,updated=? WHERE id=?')
      .run(next.state, next.text, next.reply, next.output, next.error, JSON.stringify(next.target), Date.now(), id);
    return this.get(id)!;
  }
  close() { this.db.close(); }
}
