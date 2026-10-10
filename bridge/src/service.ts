import { z } from 'zod';
import type { Config } from './config.js';
import type { Herdr } from './herdr.js';
import type { SpeechEngine } from './speech.js';
import { Store } from './store.js';
import { UserError, type Target } from './types.js';

export const requestId = z.string().uuid();
export class Service {
  observer?: { warnings: Set<string> };
  private tasks = new Set<Promise<void>>();
  private accepting = true;
  constructor(readonly config: Config, readonly store: Store, readonly herdr: Herdr, readonly speech: SpeechEngine, private fetcher = fetch) {}
  private grokTarget(): Target | undefined {
    return this.config.grok ? { id: 'grok', name: this.config.grok.name, provider: 'grok', detail: '', status: 'ready', available: true, character: 'grok' } : undefined;
  }
  async targets(): Promise<{ targets: Target[]; warnings: string[] }> {
    this.store.expireGrok();
    const targets: Target[] = [], warnings: string[] = [];
    try { targets.push(...await this.herdr.targets()); } catch { warnings.push('Herdr is offline. Start the configured Herdr session.'); }
    const grok = this.grokTarget();
    if (grok) targets.unshift(grok);
    else warnings.push('Grok Bot needs a webhook and reply helper.');
    for (const target of this.store.inbox.targets()) if (target.id !== 'muse' && !targets.some(t => t.id === target.id)) {
      targets.push({ ...target, provider: 'herdr', character: target.character as Target['character'], detail: target.detail ?? '', status: 'Saved replies', available: false });
    }
    return { targets, warnings };
  }
  async submit(id: string, targetId: string, body: string | Buffer) {
    requestId.parse(id);
    const fingerprint = this.store.fingerprint(targetId, body);
    const old = this.store.existing(id, fingerprint);
    if (old) return old;
    if (!this.accepting) throw new UserError('Bridge is shutting down.', 503);
    if (typeof body === 'string') {
      if (!body.trim() || body.length > 8000) throw new UserError('Enter a message of 1–8000 characters.');
    } else if (body.length % 2 || body.length < 9600 || body.length > 640000) {
      throw new UserError('Record between 0.3 and 20 seconds of 16 kHz mono PCM16 audio.');
    }
    // A Grok request does not depend on local coding-session discovery.
    const targets = targetId === 'grok' ? [this.grokTarget()] : (await this.targets()).targets;
    // Discovery awaited: another request may have reserved this ID in the meantime.
    const duplicate = this.store.existing(id, fingerprint);
    if (duplicate) return duplicate;
    const target = targets.find(t => t?.id === targetId);
    if (!target) throw new UserError('This agent is unavailable. Refresh the list.', 409);
    if (!target.available) throw new UserError('The agent is busy or needs your attention.', 409);
    const turn = this.store.create(id, fingerprint, target, typeof body === 'string' ? body.trim() : '');
    const task = this.run(id, typeof body === 'string' ? undefined : body).finally(() => this.tasks.delete(task));
    this.tasks.add(task);
    return turn;
  }
  private async run(id: string, audio?: Buffer) {
    try {
      this.speech.warm?.();
      if (audio) {
        this.store.update(id, { state: 'transcribing' });
        const text = await this.speech.transcribe(audio);
        this.store.update(id, { text });
      }
      let turn = this.store.get(id)!;
      if (turn.target.provider === 'herdr' && !turn.target.kind) await this.herdr.validate(turn.target);
      // Persist BEFORE any operation that may launch work. Crashes from here are uncertain.
      this.store.update(id, { state: 'dispatching' });
      if (turn.target.provider === 'herdr') {
        const target = await this.herdr.prepare(turn.target, id);
        turn = this.store.update(id, { target, state: 'working' });
        const result = await this.herdr.prompt(target, turn.text);
        this.store.update(id, result);
      } else {
        const grok = this.config.grok;
        if (!grok) throw new UserError('Grok Bot is not configured.');
        const response = await this.fetcher(grok.webhook, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
          headers: { Authorization: `Bearer ${grok.key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ request_id: id, message: turn.text, history: this.store.conversationHistory(turn.target.id) }),
        });
        if (response.status !== 200) throw new Error(`Grok Bot did not confirm the request (HTTP ${response.status}). Check Bot before sending again.`);
        // A fast callback may finish before the webhook response arrives.
        if (this.store.get(id)?.state === 'dispatching') this.store.update(id, { state: 'working' });
      }
    } catch (error) {
      const turn = this.store.get(id)!;
      if (turn.state === 'done' || turn.state === 'needs_attention') return;
      const uncertain = ['dispatching', 'working'].includes(turn.state) && !(error instanceof UserError);
      this.store.update(id, { state: uncertain ? 'uncertain' : 'failed', error: error instanceof Error ? error.message : 'Request failed.' });
    }
  }
  reply(id: string, text: string, needsAttention: boolean) {
    const turn = this.store.get(id);
    if (!turn || turn.target.provider !== 'grok') throw new UserError('Grok request not found.', 404);
    const state = needsAttention ? 'needs_attention' : 'done';
    if (turn.state === state && turn.reply === text) return turn;
    if (!['dispatching', 'working', 'uncertain'].includes(turn.state)) throw new UserError('This request already has a result or has not been sent.', 409);
    return this.store.update(id, { state, reply: text, error: '' });
  }
  async drain() { this.accepting = false; await Promise.allSettled(this.tasks); }
}
