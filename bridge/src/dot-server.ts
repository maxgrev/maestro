import express from 'express';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { Dot, dotTools, dotEvents } from './dot.js';
import { DOT_SCOPE } from './dot-auth.js';
import { UserError } from './types.js';

const VERSION = '2026-07-28';
const publicPaths = new Set(['/dot/mcp', '/authorize', '/token', '/register', '/revoke',
  '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource/dot/mcp']);
const rpc = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number().int()]), method: z.string(), params: z.record(z.string(), z.unknown()).optional() });
const toolRequest = z.object({ name: z.string(), arguments: z.unknown().optional() });
const valueResult = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
const toolResult = (dot: Dot, name: string, args: unknown) => {
  try { return valueResult(dot.call(name, args ?? {})); }
  catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof UserError ? error.message : 'Invalid Dot tool arguments.' }] }; }
};

export class DotServer {
  private oauth?: ReturnType<typeof express>;
  private base?: string;
  constructor(private dot: Dot) {}
  publicPath(path: string) { return publicPaths.has(path); }
  async authorize(req: FastifyRequest, reply: FastifyReply) {
    if (!this.dot.auth.enabled()) throw new UserError('Dot is not connected.', 404);
    const resource = this.dot.auth.resource(), origin = new URL(resource).origin;
    if (req.headers.origin && ![origin, 'https://chatgpt.com'].includes(req.headers.origin)) throw new UserError('Invalid origin.', 403);
    if (req.url.split('?')[0] === '/dot/mcp') {
      try {
        const header = req.headers.authorization;
        if (!header?.startsWith('Bearer ')) throw new Error();
        await this.dot.auth.verifyAccessToken(header.slice(7));
      } catch {
        reply.header('WWW-Authenticate', `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/dot/mcp", scope="${DOT_SCOPE}"`);
        throw new UserError('Connect Maestro to your Dot in ChatGPT.', 401);
      }
      return;
    }
    if (!this.oauth || this.base !== origin) {
      this.base = origin;
      this.oauth = express(); this.oauth.disable('x-powered-by');
      this.oauth.use(mcpAuthRouter({ provider: this.dot.auth, issuerUrl: new URL(origin), resourceServerUrl: new URL(resource),
        resourceName: 'Maestro Dot messages', scopesSupported: [DOT_SCOPE], clientRegistrationOptions: { clientSecretExpirySeconds: 0 } }));
      this.oauth.use((_req, res) => { res.status(404).end(); });
    }
    reply.hijack();
    this.oauth(req.raw, reply.raw);
  }
  register(app: FastifyInstance) {
    app.post('/dot/mcp', async (req, reply) => {
      const version = req.headers['mcp-protocol-version'];
      if (version === VERSION || (req.body as { method?: string })?.method === 'server/discover' ||
        (req.body as { params?: { _meta?: object } })?.params?._meta) return this.modern(req, reply);
      // SDK 1.x owns legacy initialization and tools. The isolated modern handler
      // below covers MCP 2.0 + Events until those ship in the stable SDK.
      const server = new Server({ name: 'Maestro', version: '0.2.0' }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: dotTools }));
      server.setRequestHandler(CallToolRequestSchema, async r => toolResult(this.dot, r.params.name, r.params.arguments));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      reply.hijack();
      reply.raw.once('close', () => { void transport.close(); void server.close(); });
      await transport.handleRequest(req.raw, reply.raw, req.body);
    });
    for (const method of ['get', 'delete'] as const) app[method]('/dot/mcp', async (_req, reply) => reply.code(405).header('Allow', 'POST').send());
  }
  private async modern(req: FastifyRequest, reply: FastifyReply) {
    const parsed = rpc.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid request.' } });
    const { id, method, params = {} } = parsed.data;
    const fail = (code: number, message: string, status = 400, data?: unknown) => reply.code(status).send({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
    if (req.headers['mcp-protocol-version'] !== VERSION) return fail(-32022, 'Unsupported protocol version.', 400,
      { supported: [VERSION], requested: req.headers['mcp-protocol-version'] ?? '' });
    const meta = params._meta as Record<string, unknown> | undefined;
    if (req.headers['mcp-method'] !== method || meta?.['io.modelcontextprotocol/protocolVersion'] !== VERSION ||
      (method === 'tools/call' && req.headers['mcp-name'] !== params.name)) return fail(-32020, 'MCP headers must match the request.');
    const info = z.object({ name: z.string(), version: z.string() }).safeParse(meta['io.modelcontextprotocol/clientInfo']);
    if (!info.success || !z.record(z.string(), z.unknown()).safeParse(meta['io.modelcontextprotocol/clientCapabilities']).success) return fail(-32602, 'Missing MCP client metadata.');
    const client = (await this.dot.auth.verifyAccessToken(req.headers.authorization!.slice(7))).clientId;
    let result: object;
    try {
      switch (method) {
        case 'server/discover': result = { supportedVersions: [VERSION], capabilities: { tools: {}, events: {} },
          serverInfo: { name: 'Maestro', version: '0.2.0' }, instructions: 'Maestro is the owner’s voice remote. Reply to messages using their request_id. Only Dot messages are accessible.' }; break;
        case 'tools/list': result = { tools: dotTools }; break;
        case 'tools/call': { const p = toolRequest.parse(params); result = toolResult(this.dot, p.name, p.arguments); break; }
        case 'events/list': result = { events: dotEvents }; break;
        case 'events/subscribe': result = await this.dot.subscribe(client, params); break;
        case 'events/unsubscribe': result = this.dot.unsubscribe(client, params); break;
        case 'ping': result = {}; break;
        default: return fail(-32601, 'Method not found.', 404);
      }
    } catch (error) {
      if (error instanceof z.ZodError) return fail(-32602, 'Invalid request fields.');
      return fail(method === 'events/subscribe' ? -32015 : -32602, error instanceof UserError ? error.message : 'Dot connection could not complete this step.', 200,
        method === 'events/subscribe' ? { reason: 'challenge_failed' } : undefined);
    }
    return { jsonrpc: '2.0', id, result: { resultType: 'complete', ...result } };
  }
}
