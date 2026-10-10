import { execFile } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { localDir, type Config } from './config.js';
import { UserError } from './types.js';

const hostName = z.string().regex(/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/);
const savedSchema = z.object({ url: z.string().url().refine(s => {
  const u = new URL(s);
  return u.protocol === 'https:' && !u.port && !u.username && !u.password && !u.search && !u.hash && u.pathname === '/' && hostName.safeParse(u.hostname).success;
}) }).strict();
type CommandResult = { ok: boolean; stdout: string; stderr: string };
export type TailscaleRunner = (args: string[]) => Promise<CommandResult>;
export function tailscaleBinary() {
  return ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale'].find(existsSync);
}
const runTailscale: TailscaleRunner = args => new Promise(resolve => {
  const binary = tailscaleBinary();
  if (!binary) return resolve({ ok: false, stdout: '', stderr: '' });
  execFile(binary, args, { timeout: 12_000, maxBuffer: 512_000 }, (error, stdout, stderr) => resolve({ ok: !error, stdout, stderr }));
});
const serveSchema = z.object({
  TCP: z.record(z.string(), z.object({ HTTPS: z.boolean().optional() }).passthrough()).optional(),
  Web: z.record(z.string(), z.object({ Handlers: z.record(z.string(), z.object({ Proxy: z.string().optional() }).passthrough()) })).optional(),
  AllowFunnel: z.record(z.string(), z.boolean()).optional(),
  Foreground: z.record(z.string(), z.unknown()).optional(),
});
type Serve = z.infer<typeof serveSchema>;
export type RemoteState = { installed: boolean; connected: boolean; enabled: boolean; available: boolean; url?: string; approvalUrl?: string; message: string };

export class RemoteAccess {
  private busy = false;
  private approvalUrl?: string;
  constructor(private config: Config, private data = localDir, private run: TailscaleRunner = runTailscale,
    private installed = () => !!tailscaleBinary(), private request: typeof fetch = fetch) {}
  saved() {
    const path = resolve(this.data, 'remote.json');
    if (!existsSync(path)) return undefined;
    const value = savedSchema.partial().parse(JSON.parse(readFileSync(path, 'utf8')));
    return value.url ? { url: value.url } : undefined;
  }
  private save(url?: string) {
    // A separate file lets an unavailable tunnel retain its address across restarts.
    const path = resolve(this.data, 'remote.json');
    if (!url) { writeFileSync(path + '.tmp', '{}\n', { mode: 0o600 }); }
    else writeFileSync(path + '.tmp', JSON.stringify(savedSchema.parse({ url })) + '\n', { mode: 0o600 });
    renameSync(path + '.tmp', path);
  }
  private target() { return `http://127.0.0.1:${this.config.remotePort}`; }
  private async inspect() {
    const result = await this.run(['status', '--json']);
    if (!result.ok) throw new UserError('Open Tailscale and finish signing in on this Mac.', 503);
    const status = z.object({ BackendState: z.string(), Self: z.object({ DNSName: z.string() }).nullable().optional() }).parse(JSON.parse(result.stdout));
    if (status.BackendState !== 'Running') throw new UserError('Connect this Mac in Tailscale, then check again.', 503);
    const host = hostName.parse(status.Self?.DNSName.replace(/\.$/, ''));
    const serve = await this.run(['funnel', 'status', '--json']);
    if (!serve.ok) throw new UserError('Could not check Tailscale sharing. Open Tailscale and try again.', 503);
    return { host, serve: serveSchema.parse(JSON.parse(serve.stdout || '{}')) };
  }
  private owned(serve: Serve, host: string) {
    const web = serve.Web?.[`${host}:443`];
    const handler = web?.Handlers['/'];
    return !!handler && Object.keys(handler).length === 1 && handler.Proxy === this.target()
      && Object.keys(web!.Handlers).length === 1 && serve.TCP?.['443']?.HTTPS === true
      && Object.keys(serve.TCP['443']).length === 1;
  }
  private conflict(serve: Serve, host: string) {
    // Do not replace another app's sharing, including foreground sessions.
    return Object.keys(serve.Foreground ?? {}).length > 0
      || Object.keys(serve.Web ?? {}).some(key => key.endsWith(':443') && key !== `${host}:443`)
      || (!!serve.TCP?.['443'] || !!serve.Web?.[`${host}:443`]) && !this.owned(serve, host);
  }
  async state(): Promise<RemoteState> {
    const saved = this.saved(), installed = this.installed();
    const base = { installed, connected: false, enabled: !!saved, available: false, url: saved?.url, approvalUrl: this.approvalUrl };
    if (!installed) return { ...base, message: 'Install Tailscale, then sign in. Maestro will handle the connection.' };
    try {
      const { host, serve } = await this.inspect();
      const available = this.owned(serve, host) && serve.AllowFunnel?.[`${host}:443`] === true;
      return { ...base, connected: true, available, message: available && saved?.url === `https://${host}`
        ? 'Remote access is on. Save it to your StopWatch below.'
        : this.conflict(serve, host) ? 'Tailscale is sharing another service on port 443. Keep that service or free the port in Tailscale first.'
        : 'Tailscale is connected. Enable remote access to link your StopWatch.' };
    } catch (error) { return { ...base, message: error instanceof UserError ? error.message : 'Could not read Tailscale status. Update Tailscale and try again.' }; }
  }
  async change(action: 'enable' | 'disable'): Promise<RemoteState> {
    if (this.busy) throw new UserError('A remote access step is already running.', 409);
    this.busy = true;
    try {
      const { host, serve } = await this.inspect();
      if (this.conflict(serve, host)) throw new UserError('Port 443 belongs to another Tailscale service. Maestro did not change it.', 409);
      if (action === 'disable') {
        if (this.owned(serve, host)) {
          const result = await this.run(['funnel', '--https=443', 'off']);
          if (!result.ok) throw new UserError('Could not turn remote access off. Check Tailscale and retry.', 503);
        }
        this.save(); this.approvalUrl = undefined;
        return { ...await this.state(), message: 'Remote access is off. Save to StopWatch to restore its home connection.' };
      }
      if (!this.owned(serve, host) || !serve.AllowFunnel?.[`${host}:443`]) {
        const result = await this.run(['funnel', '--bg', '--https=443', this.target()]);
        // Tailscale asks its owner to approve HTTPS/Funnel through this official URL.
        const approval = (result.stdout + '\n' + result.stderr).match(/https:\/\/login\.tailscale\.com\/f\/[a-zA-Z0-9/?=&_-]+/);
        if (approval) {
          this.approvalUrl = approval[0];
          return { ...await this.state(), approvalUrl: this.approvalUrl, message: 'Approve the connection in Tailscale, then choose Enable remote access again.' };
        }
        if (!result.ok) throw new UserError('Tailscale could not enable sharing. Open Tailscale and try again.', 503);
      }
      const current = await this.inspect();
      if (current.host !== host || !this.owned(current.serve, host) || !current.serve.AllowFunnel?.[`${host}:443`]) throw new UserError('Tailscale has not enabled the Maestro connection yet.', 503);
      const url = `https://${host}`;
      await this.verify(url);
      this.save(url); this.approvalUrl = undefined;
      return this.state();
    } finally { this.busy = false; }
  }
  private async verify(url: string) {
    const get = (path: string, authenticated: boolean) => this.request(url + path, {
      redirect: 'error', signal: AbortSignal.timeout(12_000),
      headers: authenticated ? { Authorization: `Bearer ${this.config.deviceToken}` } : {},
    });
    try {
      const anonymous = await get('/api/health', false);
      await anonymous.body?.cancel();
      if (anonymous.status !== 401) throw new Error('Authentication missing');
      const health = await get('/api/health', true);
      if (!health.ok || (await health.json() as { name?: string }).name !== 'Maestro') throw new Error('Wrong service');
      const setup = await get('/api/setup', true);
      await setup.body?.cancel();
      if (setup.status !== 404) throw new Error('Setup exposed');
    } catch {
      throw new UserError('The public connection is not ready. Tailscale DNS can take a few minutes. Wait, then enable again; the StopWatch address has not changed.', 503);
    }
  }
}
