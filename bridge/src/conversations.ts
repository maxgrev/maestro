import { conversationId, type InboxTarget } from './inbox.js';
import type { Store } from './store.js';
import { UserError, type State, type Target } from './types.js';

export type Conversation = {
  id: string; title: string; agent: string; character?: string; preview: string;
  updated: number; unread: number; attention: boolean; target?: Target;
  connection: 'ready' | 'busy' | 'attention' | 'connect' | 'setup' | 'watch';
};
type Summary = { id: string; target: string; preview: string; updated: number; unread: number; attention: number; state: string };
type Entry = { id: string; text: string; reply: string; output: string; error: string; state: State; created: number; updated: number; receipts: string };

// Native session IDs survive pane reconnects. Receipts also bind older Maestro
// turns, whose saved target predates native session metadata, to that session.
const turnConversation = `coalesce(json_extract(t.target,'$.session'),
  (SELECT conversation FROM inbox WHERE turn=t.id ORDER BY conversation LIKE 'herdr:%',id DESC LIMIT 1),json_extract(t.target,'$.id'))`;

export class Conversations {
  constructor(private store: Store) {}

  list(targets: Target[]): Conversation[] {
    this.store.expireCallbacks();
    const rows = this.store.db.prepare(`WITH activity AS (
      SELECT conversation AS id,target,substr(reply,1,180) AS preview,created AS updated,1-read AS unread,
        attention*(1-read) AS attention,'' AS state,0 AS priority FROM inbox
      UNION ALL
      SELECT ${turnConversation},target,substr(coalesce(nullif(reply,''),nullif(error,''),text),1,180),updated,
        0,0,state,1 FROM turns t
    ), ranked AS (
      SELECT *,row_number() OVER(PARTITION BY id ORDER BY updated DESC,priority DESC) AS position,
        sum(unread) OVER(PARTITION BY id) AS unreadTotal,max(attention) OVER(PARTITION BY id) AS needsAttention FROM activity
    ) SELECT id,target,preview,updated,unreadTotal AS unread,needsAttention AS attention,state FROM ranked WHERE position=1`).all() as Summary[];
    const result = new Map<string, Conversation>();
    const busyIds = new Set((this.store.db.prepare(`SELECT DISTINCT ${turnConversation} AS id FROM turns t
      WHERE state IN ('queued','transcribing','dispatching','working')`).all() as {id: string}[]).map(row => row.id));
    for (const row of this.store.db.prepare("SELECT source,value FROM inbox_cursors WHERE source LIKE 'activity:%'").all() as {source:string;value:string}[]) {
      const activity=JSON.parse(row.value) as {busy:boolean;at:number};
      if (activity.busy&&Date.now()-activity.at<30_000) busyIds.add(row.source.slice('activity:'.length));
    }
    for (const row of rows) {
      const target = JSON.parse(row.target) as InboxTarget;
      result.set(row.id, { id: row.id, title: target.detail || target.name, agent: target.name, character: target.character,
        preview: row.preview, updated: row.updated, unread: row.unread, attention: !!row.attention,
        connection: row.id === 'muse' ? 'watch' : busyIds.has(row.id) ? 'busy' : 'connect' });
    }
    for (const target of targets) {
      const id = conversationId(target);
      const saved = result.get(id);
      const current = saved ?? { id, title: target.detail || target.name, agent: target.name, character: target.character,
        preview: '', updated: 0, unread: 0, attention: false, connection: 'connect' as const };
      const connection = busyIds.has(id) || ['working','running'].includes(target.status) ? 'busy'
        : target.available ? 'ready' : ['blocked','needs_attention'].includes(target.status) ? 'attention'
        : target.status === 'Saved replies' ? 'connect' : 'setup';
      result.set(id, { ...current, title: saved && saved.title!==saved.agent ? saved.title : target.detail || current.title, agent: target.name, character: target.character,
        target, connection });
    }
    return [...result.values()].sort((a,b) => b.updated-a.updated || a.title.localeCompare(b.title));
  }

  history(id: string, cursor?: string, limit = 30) {
    this.store.expireCallbacks();
    let before = { created: Number.MAX_SAFE_INTEGER, id: '\uffff' };
    if (cursor) {
      try {
        const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || !('created' in parsed) || !Number.isSafeInteger(parsed.created)
          || !('id' in parsed) || typeof parsed.id !== 'string') throw new Error();
        before = parsed as typeof before;
      } catch { throw new UserError('The history page is invalid. Refresh the conversation.'); }
    }
    const rows = this.store.db.prepare(`WITH entries AS (
      SELECT 'turn:'||t.id AS id,t.text,t.reply,t.output,t.error,t.state,t.created,t.updated,
        (SELECT json_group_array(id) FROM inbox WHERE turn=t.id AND read=0) AS receipts FROM turns t WHERE ${turnConversation}=?
      UNION ALL
      SELECT 'reply:'||i.id,i.text,i.reply,'','',CASE WHEN attention=1 THEN 'needs_attention' ELSE 'done' END,created,created,
        CASE WHEN read=0 THEN json_array(i.id) ELSE '[]' END FROM inbox i WHERE conversation=?
          AND (turn='' OR NOT EXISTS(SELECT 1 FROM turns WHERE id=i.turn))
    ) SELECT * FROM entries WHERE created<? OR (created=? AND id<?) ORDER BY created DESC,id DESC LIMIT ?`)
      .all(id,id,before.created,before.created,before.id,limit+1) as Entry[];
    const more = rows.length > limit;
    rows.length = Math.min(rows.length,limit);
    const oldest = rows.at(-1);
    return { entries: rows.reverse().map(({ receipts,...row }) => ({ ...row,
      text: row.id.startsWith('reply:') ? historyPrompt(row.text) : row.text,receipts: JSON.parse(receipts) as number[] })),
      next: more && oldest ? Buffer.from(JSON.stringify({ created: oldest.created,id: oldest.id })).toString('base64url') : null };
  }
}

// Claude's transcript includes synthetic user messages for task completions and
// compaction. Keep the ensuing answers, without presenting that metadata as a prompt.
export function historyPrompt(text: string) {
  const clean = text.replace(/^(?:\s*<system-reminder>[\s\S]*?<\/system-reminder>\s*)+/,'').trim();
  return /^(?:<task-notification>|This session is being continued from a previous conversation that ran out of context\.)/.test(clean) ? '' : clean;
}
