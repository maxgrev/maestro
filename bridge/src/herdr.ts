import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { dirname, delimiter } from 'node:path';
import { captureReply } from './agent-reply.js';
import type { Config } from './config.js';
import { UserError, type Target } from './types.js';
import { agentBinary, agentReadiness, connectAgent } from './agent-setup.js';
const exec = promisify(execFile);

export interface Agent {
  terminal_id: string; pane_id: string; agent: string | null; name?: string; title?: string;
  terminal_title_stripped?: string;
  agent_status: string; agent_session?: unknown; cwd?: string;
}
interface Result { agents?: Agent[]; agent?: Agent; root_pane?: { pane_id: string }; text?: string; read?: { text: string };
  process_info?: { foreground_processes?: { pid: number; name: string }[] } }
export type HerdrCall = (args: string[], timeout?: number) => Promise<Result>;
export const identity = (a: Agent) => createHash('sha256').update(JSON.stringify([a.terminal_id, a.agent, a.agent_session ?? null])).digest('hex');

export class Herdr {
  readonly call: HerdrCall;
  private newCodexSessions = new Set<string>();
  constructor(private config: Config, call?: HerdrCall) {
    this.call = call ?? (async (args, timeout = 12_000) => {
      try {
        const { stdout } = await exec(config.herdr.binary, ['--session', config.herdr.session, ...args], {
          timeout, maxBuffer: 1024 * 1024,
          env: { ...process.env, ...(config.herdr.configPath ? { HERDR_CONFIG_PATH: config.herdr.configPath } : {}) },
        });
        if (args[0] === 'agent' && args[1] === 'read') return { text: stdout.slice(-16000) };
        const response = JSON.parse(stdout);
        if (response.error) throw new Error(response.error.message);
        return response.result;
      } catch (error) {
        // Do not expose stderr: it can contain terminal content or a submitted prompt.
        throw new Error(error instanceof Error && error.message.startsWith('Unexpected') ? 'Herdr returned an unreadable response.' : 'Herdr did not confirm the operation. Check its session.');
      }
    });
  }
  private target(a: Agent): Target {
    const names: Record<string, string> = { codex: 'Codex', claude: 'Claude Code', pi: 'Pi' };
    const terminalTitle = a.terminal_title_stripped?.split(' | ')[0];
    const title = terminalTitle && /[\p{L}\p{N}]/u.test(terminalTitle) ? terminalTitle : this.config.projects.find(p => p.path === a.cwd)?.name || 'Conversation';
    const name = a.name?.startsWith('m-') ? `${names[a.agent ?? ''] ?? a.agent} / ${title}` : a.name || a.title || a.agent || 'Agent';
    return { id: `herdr:${a.pane_id}:${identity(a)}`, name, provider: 'herdr', detail: a.cwd || '', status: a.agent_status,
      available: ['idle', 'done'].includes(a.agent_status), pane: a.pane_id, identity: identity(a),
      character: ['codex', 'claude', 'pi'].includes(a.agent ?? '') ? a.agent as Target['character'] : undefined };
  }
  async targets(): Promise<Target[]> {
    const result = await this.call(['agent', 'list']);
    if (!Array.isArray(result.agents)) throw new Error('Herdr agent list has an unsupported shape.');
    const existing = result.agents.filter(a => a.agent).map(a => this.target(a));
    const ready = await Promise.all(this.config.agents.map(agentReadiness));
    const names = { codex: 'Codex', claude: 'Claude Code', pi: 'Pi' };
    const fresh: Target[] = this.config.projects.flatMap(p => this.config.agents.map(kind => ({
      id: `new:${kind}:${p.id}`, name: `New ${names[kind]}`, provider: 'herdr', detail: p.name,
      status: !ready.find(a=>a.kind===kind)?.installed ? 'Install in Maestro' : !ready.find(a=>a.kind===kind)?.signedIn ? 'Sign in on Mac' : kind==='codex'&&!p.trusted ? 'Choose project in Maestro' : 'new',
      available: ready.some(a=>a.kind===kind&&a.installed&&a.signedIn) && (kind!=='codex'||p.trusted===true), kind, project: p.id, character: kind,
    })));
    return [...existing, ...fresh];
  }
  async prepare(target: Target, requestId: string): Promise<Target> {
    if (target.kind) {
      const project = this.config.projects.find(p => p.id === target.project);
      if (!project || !this.config.agents.includes(target.kind as 'codex')) throw new UserError('Unknown saved project or agent.');
      if (target.kind === 'codex' && !project.trusted) throw new UserError('Choose and trust a project folder in Maestro setup first.');
      try { await connectAgent(target.kind as 'codex' | 'claude' | 'pi', this.config.herdr.binary); }
      catch { throw new UserError('Could not connect this agent’s session. Retry agent setup in Maestro.', 503); }
      // A running Herdr server may predate app-installed agents. Give each new
      // pane the current app PATH without restarting anyone's existing session.
      const binary = agentBinary(target.kind as 'codex' | 'claude' | 'pi');
      const path = [binary ? dirname(binary) : '', process.env.PATH ?? ''].filter(Boolean).join(delimiter);
      const created = await this.call(['workspace', 'create', '--cwd', project.path, '--label', `Maestro ${target.kind}`, '--env', `PATH=${path}`, '--no-focus']);
      if (!created.root_pane?.pane_id) throw new Error('Herdr did not return the new pane.');
      // App-bundled Codex can differ from the global daemon. Keep this session self-contained.
      // The user explicitly trusts this saved folder in setup. This scopes the
      // provider's folder trust to that path; tool approval rules stay intact.
      // Use a TOML inline table: Codex's -c dotted-key parser splits dots inside
      // quoted paths and retains their quotes (upstream issue #34261).
      const args = target.kind === 'codex' ? ['--', '--no-daemon', '--config', `projects={${JSON.stringify(project.path)}={trust_level="trusted"}}`] : [];
      const started = await this.call(['agent', 'start', `m-${requestId.slice(0, 12)}`, '--kind', target.kind, '--pane', created.root_pane.pane_id, '--timeout', '30000', ...args], 35_000);
      if (!started.agent) throw new Error('Herdr did not confirm the new agent.');
      // The provider's SessionStart hook may arrive just after its first screen.
      let agent = started.agent;
      for (let n = 0; !agent.agent_session && n < 10; n++) {
        await new Promise(r => setTimeout(r, 200));
        agent = (await this.call(['agent', 'get', agent.pane_id])).agent ?? agent;
      }
      if (target.kind === 'codex' && !agent.agent_session) this.newCodexSessions.add(agent.terminal_id);
      return this.target(agent);
    }
    await this.validate(target);
    return target;
  }
  async validate(target: Target) {
    if (!target.pane) throw new UserError('No agent session selected.');
    const result = await this.call(['agent', 'get', target.pane]);
    if (!result.agent || identity(result.agent) !== target.identity) throw new UserError('The selected session changed. Select it again.', 409);
    if (!['idle', 'done'].includes(result.agent.agent_status)) throw new UserError('The agent is busy or needs your attention. Open its app.', 409);
    return result.agent;
  }
  async prompt(target: Target, text: string): Promise<{ state: 'done' | 'needs_attention'; reply: string; output: string; target: Target }> {
    const agent = await this.validate(target);
    const fresh = this.newCodexSessions.delete(agent.terminal_id);
    const reader = await captureReply(agent, this.call, this.config.codexBinary ?? agentBinary('codex'), fresh);
    const started = Date.now();
    const result = await this.call(['agent', 'prompt', target.pane!, text, '--wait', '--timeout', '180000'], 185_000);
    if (!result.agent || (identity(result.agent) !== target.identity
      && !(fresh && result.agent.terminal_id === agent.terminal_id && result.agent.agent === 'codex'))) throw new Error('The session changed while waiting.');
    if (!['done', 'idle', 'blocked'].includes(result.agent.agent_status)) throw new Error('The agent has not confirmed completion. Check its session.');
    const blocked = result.agent.agent_status === 'blocked';
    const read: Result = await this.call(['agent', 'read', target.pane!, '--source', 'recent-unwrapped', '--lines', '100']).catch(() => ({ text: '' }));
    // Terminal output is displayed verbatim, not misrepresented as a parsed final answer.
    const output = read.text ?? read.read?.text ?? '';
    let clean: string | undefined;
    // Completion can reach Herdr before the provider flushes its final message.
    for (let attempt = 0; !blocked && !clean && attempt < 4; attempt++) {
      if (attempt) await new Promise(r => setTimeout(r, 400 * 2 ** (attempt - 1)));
      clean = await reader(text, started).catch(() => undefined);
    }
    return { state: blocked || !clean ? 'needs_attention' : 'done', output, target: this.target(result.agent),
      reply: blocked ? `${target.name} needs your attention. Open the agent on your Mac.` : clean ?? 'The agent finished, but its answer could not be read. Open Maestro to check its output. Your request was not sent again.' };
  }
}
