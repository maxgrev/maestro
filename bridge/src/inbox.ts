import type { DatabaseSync } from 'node:sqlite';

export interface InboxTarget {
  id: string; name: string; character?: string; detail?: string;
  session?: string; cwd?: string; sessionPath?: string;
}
export interface InboxReply {
  key: string; target: InboxTarget; reply: string; attention?: boolean; turn?: string;
  created?: number; read?: boolean; text?: string;
}
type Row = { id: number; source: string; target: string; reply: string; attention: number; turn: string; created: number; read: number; alerted: number; text: string; conversation: string };
const decode = ({ text: _text, conversation: _conversation, ...row }: Row) => ({ ...row, target: JSON.parse(row.target) as InboxTarget, attention: !!row.attention, read: !!row.read });

export function conversationId(target: Pick<InboxTarget, 'id' | 'session'>, source = '') {
  return target.session || source.match(/^(?:codex|claude|pi):[^:]+(?=:)/)?.[0] || target.id;
}

/** One durable receipt per provider message. Reading and alerting are independent. */
export class Inbox {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS inbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL UNIQUE, target TEXT NOT NULL,
      reply TEXT NOT NULL, attention INTEGER NOT NULL DEFAULT 0, turn TEXT NOT NULL DEFAULT '',
      created INTEGER NOT NULL, read INTEGER NOT NULL DEFAULT 0, alerted INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS inbox_unread ON inbox(read,id);
    CREATE TABLE IF NOT EXISTS inbox_cursors (source TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    const columns = new Set((db.prepare('PRAGMA table_info(inbox)').all() as { name: string }[]).map(column => column.name));
    if (!columns.has('conversation')) {
      db.exec('BEGIN');
      try {
        db.exec("ALTER TABLE inbox ADD COLUMN conversation TEXT NOT NULL DEFAULT ''; ALTER TABLE inbox ADD COLUMN text TEXT NOT NULL DEFAULT '';");
        const update = db.prepare('UPDATE inbox SET conversation=? WHERE id=?');
        for (const row of db.prepare('SELECT id,source,target FROM inbox').all() as Pick<Row, 'id' | 'source' | 'target'>[]) {
          update.run(conversationId(JSON.parse(row.target) as InboxTarget, row.source), row.id);
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    db.exec('CREATE INDEX IF NOT EXISTS inbox_conversation ON inbox(conversation,created,id); CREATE INDEX IF NOT EXISTS inbox_turn ON inbox(turn);');
  }
  add(item: InboxReply) {
    if (!item.reply.trim()) return;
    const separator = item.key.lastIndexOf(':');
    const source = separator < 0 ? item.key : item.key.slice(0, separator);
    const through = this.cursor<number>(`read:${source}`) ?? 0;
    const read = !!item.read || (item.created != null && item.created <= through);
    this.db.prepare(`INSERT INTO inbox(source,target,reply,attention,turn,created,read,alerted,conversation,text)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source) DO UPDATE SET
      read=max(inbox.read,excluded.read), alerted=max(inbox.alerted,excluded.alerted),
      turn=CASE WHEN excluded.turn<>'' THEN excluded.turn ELSE inbox.turn END,
      text=CASE WHEN excluded.text<>'' THEN excluded.text ELSE inbox.text END,
      created=CASE WHEN ? THEN excluded.created ELSE inbox.created END,
      conversation=CASE WHEN excluded.conversation LIKE 'herdr:%' AND inbox.conversation NOT LIKE 'herdr:%' THEN inbox.conversation ELSE excluded.conversation END,
      target=CASE WHEN excluded.turn<>'' OR inbox.turn='' THEN excluded.target ELSE inbox.target END`)
      .run(item.key, JSON.stringify(item.target), item.reply, Number(!!item.attention), item.turn ?? '',
        item.created ?? Date.now(), Number(read), Number(read), conversationId(item.target, item.key), item.text ?? '', Number(item.created != null));
    return this.db.prepare('SELECT id FROM inbox WHERE source=?').get(item.key) as { id: number };
  }
  get(id: number) {
    const row = this.db.prepare('SELECT * FROM inbox WHERE id=?').get(id) as Row | undefined;
    return row && decode(row);
  }
  bySource(key: string) {
    const row = this.db.prepare('SELECT * FROM inbox WHERE source=?').get(key) as Row | undefined;
    return row && decode(row);
  }
  page(before = Number.MAX_SAFE_INTEGER, target = '', limit = 20) {
    const rows = (this.db.prepare(`SELECT * FROM inbox WHERE id<? AND (?='' OR json_extract(target,'$.id')=?) ORDER BY id DESC LIMIT ?`)
      .all(before, target, target, limit + 1) as Row[]);
    const more = rows.length > limit; rows.length = Math.min(rows.length, limit);
    return { items: rows.map(row => ({ ...decode(row), reply: row.reply.slice(0, 120) })),
      next: more ? rows.at(-1)!.id : null };
  }
  status() {
    const counts = this.db.prepare(`SELECT json_extract(target,'$.id') AS target, count(*) AS unread,
      max(attention) AS attention FROM inbox WHERE read=0 GROUP BY json_extract(target,'$.id')`).all();
    const alerts = this.db.prepare('SELECT id,turn FROM inbox WHERE read=0 AND alerted=0 ORDER BY id LIMIT 64').all();
    const latest = this.db.prepare('SELECT coalesce(max(id),0) AS id FROM inbox').get() as { id: number };
    return { counts, alerts, latest: latest.id };
  }
  targets(): InboxTarget[] {
    return (this.db.prepare(`SELECT target,conversation FROM (
      SELECT target,conversation,created,id,row_number() OVER (PARTITION BY conversation ORDER BY created DESC,id DESC) AS position FROM inbox
    ) WHERE position=1 ORDER BY created DESC,id DESC LIMIT 32`).all() as { target: string; conversation: string }[])
      .map(row => ({ ...JSON.parse(row.target), session: row.conversation }));
  }
  conversationTarget(id: string): InboxTarget | undefined {
    const row = this.db.prepare('SELECT target FROM inbox WHERE conversation=? ORDER BY created DESC,id DESC LIMIT 1').get(id) as {target: string}|undefined;
    return row && { ...JSON.parse(row.target),session: id };
  }
  bindSession(id: string,target: InboxTarget) {
    this.db.prepare(`UPDATE inbox SET target=json_patch(target,?) WHERE conversation=? AND json_extract(target,'$.id')<>?`)
      .run(JSON.stringify({id:target.id,session:id,...(target.cwd?{cwd:target.cwd}:{}),...(target.sessionPath?{sessionPath:target.sessionPath}:{})}),id,target.id);
  }
  acknowledge(ids: number[], kind: 'read' | 'alert') {
    const statement = this.db.prepare(kind === 'read' ? 'UPDATE inbox SET read=1,alerted=1 WHERE id=?' : 'UPDATE inbox SET alerted=1 WHERE id=?');
    // Explicit IDs prevent a reply arriving during an acknowledgment from being cleared.
    this.db.exec('BEGIN');
    try { for (const id of ids) statement.run(id); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  readSources(keys: string[]) {
    const update = this.db.prepare('UPDATE inbox SET read=1,alerted=1 WHERE source=? AND read=0');
    for (const key of keys) update.run(key);
  }
  describeSource(source: string, target: InboxTarget) {
    const prefix = source + ':';
    this.db.prepare(`UPDATE inbox SET target=json_set(target,'$.name',?,'$.detail',?)
      WHERE substr(source,1,?)=? AND (json_extract(target,'$.name')<>? OR coalesce(json_extract(target,'$.detail'),'')<>?)`)
      .run(target.name, target.detail ?? '', prefix.length, prefix, target.name, target.detail ?? '');
    if (target.cwd) this.db.prepare(`UPDATE inbox SET target=json_patch(target,?) WHERE substr(source,1,?)=?`)
      .run(JSON.stringify({ session: source, cwd: target.cwd, ...(target.sessionPath ? { sessionPath: target.sessionPath } : {}) }), prefix.length, prefix);
  }
  readThrough(source: string, through: number) {
    if (!Number.isFinite(through) || through <= 0) return;
    through = Math.max(through, this.cursor<number>(`read:${source}`) ?? 0);
    this.saveCursor(`read:${source}`, through);
    const prefix = source + ':';
    this.db.prepare('UPDATE inbox SET read=1,alerted=1 WHERE substr(source,1,?)=? AND created<=? AND read=0')
      .run(prefix.length, prefix, through);
  }
  readTurn(turn: string) { this.db.prepare('UPDATE inbox SET read=1,alerted=1 WHERE turn=?').run(turn); }
  cursor<T>(source: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM inbox_cursors WHERE source=?').get(source) as { value: string } | undefined;
    return row && JSON.parse(row.value) as T;
  }
  saveCursor(source: string, value: unknown) {
    this.db.prepare('INSERT INTO inbox_cursors VALUES(?,?) ON CONFLICT(source) DO UPDATE SET value=excluded.value').run(source, JSON.stringify(value));
  }
}
