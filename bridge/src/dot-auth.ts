import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidClientMetadataError, InvalidGrantError, InvalidRequestError, InvalidScopeError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { UserError } from './types.js';

export const DOT_SCOPE = 'dot:messages';
const secret = () => randomBytes(32).toString('base64url');
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
type Authorization = { client: string; redirect: string; challenge: string; state?: string; resource: string; expires: number };
type Grant = { client: string; resource: string; access: string; accessExpires: number; refresh: string; expires: number };

// A single local owner, with consent in the existing loopback-only setup UI.
// The SDK handles OAuth parsing, client authentication, PKCE and rate limits.
export class DotAuth implements OAuthServerProvider {
  constructor(readonly db: DatabaseSync, private publicUrl: () => string | undefined, private localPort: number) {
    db.exec('CREATE TABLE IF NOT EXISTS dot_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }
  read<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM dot_state WHERE key=?').get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : undefined;
  }
  write(key: string, value: unknown) { this.db.prepare('INSERT OR REPLACE INTO dot_state VALUES (?,?)').run(key, JSON.stringify(value)); }
  remove(key: string) { this.db.prepare('DELETE FROM dot_state WHERE key=?').run(key); }
  resource() {
    const base = this.publicUrl();
    if (!base) throw new UserError('Enable remote access in Wi-Fi settings so your Dot can reach Maestro.', 409);
    return new URL('/dot/mcp', base).href;
  }
  enabled() { return this.read<boolean>('enabled') === true; }
  grant() {
    const grant = this.read<Grant>('grant');
    return grant && grant.expires > Date.now() && grant.resource === this.resource() ? grant : undefined;
  }
  private checkResource(resource?: URL) {
    if (!this.enabled() || resource?.href !== this.resource()) throw new InvalidRequestError('Wrong resource or Dot is disconnected.');
  }
  private checkScopes(scopes?: string[]) {
    if (scopes && scopes.some(s => s !== DOT_SCOPE)) throw new InvalidScopeError('Only Dot messages are available.');
  }
  readonly clientsStore = {
    getClient: (id: string) => this.read<OAuthClientInformationFull>('client:' + id),
    registerClient: (client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>) => {
      // This connection is for ChatGPT. Never redirect authorization to arbitrary sites.
      if (!client.redirect_uris.length || client.redirect_uris.some(uri => {
        const u = new URL(uri);
        return u.origin !== 'https://chatgpt.com' || u.search || u.hash ||
          !(u.pathname === '/connector_platform_oauth_redirect' || /^\/connector\/oauth\/[a-zA-Z0-9_-]+$/.test(u.pathname));
      })) throw new InvalidClientMetadataError('Use the ChatGPT OAuth callback.');
      const count = this.db.prepare("SELECT count(*) AS n FROM dot_state WHERE key LIKE 'client:%'").get() as { n: number };
      if (count.n >= 100) throw new InvalidClientMetadataError('Too many connections. Disconnect Dot in Maestro to reset.');
      const result = { ...client, client_id: randomUUID(), client_id_issued_at: Math.floor(Date.now() / 1000) };
      this.write('client:' + result.client_id, result);
      return result;
    },
  };
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    this.checkResource(params.resource); this.checkScopes(params.scopes);
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge)) throw new InvalidRequestError('Invalid S256 challenge.');
    const ticket = secret();
    this.write('authorization', { ticket, client: client.client_id, redirect: params.redirectUri, challenge: params.codeChallenge,
      state: params.state, resource: this.resource(), expires: Date.now() + 5 * 60_000 });
    res.redirect(`http://localhost:${this.localPort}/dot-setup.html?authorize=${ticket}`);
  }
  pending(ticket: string) {
    const pending = this.read<Authorization & { ticket: string }>('authorization');
    if (!pending || pending.ticket !== ticket || pending.expires <= Date.now()) throw new UserError('This connection request expired. Connect again from ChatGPT.', 410);
    return pending;
  }
  approve(ticket: string) {
    const pending = this.pending(ticket);
    this.checkResource(new URL(pending.resource));
    const code = secret();
    this.write('code', { ...pending, hash: hash(code) }); this.remove('authorization');
    const redirect = new URL(pending.redirect); redirect.searchParams.set('code', code);
    if (pending.state) redirect.searchParams.set('state', pending.state);
    return redirect.href;
  }
  private code(client: OAuthClientInformationFull, value: string) {
    const code = this.read<Authorization & { hash: string }>('code');
    if (!code || code.hash !== hash(value) || code.client !== client.client_id || code.expires <= Date.now()) throw new InvalidGrantError('Authorization expired or already used.');
    return code;
  }
  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string) { return this.code(client, code).challenge; }
  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string, resource?: URL) {
    const authorization = this.code(client, code); this.checkResource(resource);
    if (authorization.redirect !== redirectUri || authorization.resource !== resource?.href) throw new InvalidGrantError('Authorization mismatch.');
    this.remove('code'); this.remove('subscription');
    return this.issue(client.client_id);
  }
  private issue(client: string) {
    const access = secret(), refresh = secret(), now = Date.now();
    this.write('grant', { client, resource: this.resource(), access: hash(access), accessExpires: now + 3600_000,
      refresh: hash(refresh), expires: now + 30 * 86400_000 } satisfies Grant);
    return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 3600, scope: DOT_SCOPE };
  }
  async exchangeRefreshToken(client: OAuthClientInformationFull, token: string, scopes?: string[], resource?: URL) {
    this.checkResource(resource); this.checkScopes(scopes);
    const grant = this.grant();
    if (!grant || grant.client !== client.client_id || grant.refresh !== hash(token)) throw new InvalidGrantError('Reconnect Dot in Maestro.');
    return this.issue(client.client_id);
  }
  async verifyAccessToken(token: string) {
    const grant = this.enabled() && this.publicUrl() ? this.grant() : undefined;
    if (!grant || grant.access !== hash(token) || grant.accessExpires <= Date.now()) throw new InvalidTokenError('Reconnect Dot in Maestro.');
    return { token, clientId: grant.client, scopes: [DOT_SCOPE], expiresAt: Math.floor(grant.accessExpires / 1000), resource: new URL(grant.resource) };
  }
  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest) {
    const grant = this.read<Grant>('grant');
    if (grant?.client === client.client_id && [grant.access, grant.refresh].includes(hash(request.token))) {
      this.remove('grant'); this.remove('subscription');
    }
  }
  disconnect() {
    this.db.prepare("DELETE FROM dot_state WHERE key <> 'name'").run();
  }
}
