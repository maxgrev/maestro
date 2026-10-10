import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import ipaddr from 'ipaddr.js';

export function callbackUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash ||
    !['openai.com', 'chatgpt.com'].some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain))) {
    throw new Error('Use the HTTPS callback supplied by ChatGPT.');
  }
  return url;
}
export function publicAddress(address: string) {
  return ipaddr.isValid(address) && ipaddr.process(address).range() === 'unicast';
}
export type WebhookPost = (url: string, body: string, headers: Record<string, string>) => Promise<{ status: number; body: string }>;

// Resolve again for each request and pin the checked address to the TLS socket.
// Node verifies the original hostname. Redirects are returned, never followed.
export const postWebhook: WebhookPost = async (value, body, headers) => {
  const url = callbackUrl(value);
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error('Callback resolved to a non-public address.');
  const address = addresses[0]!;
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      signal: AbortSignal.timeout(10_000),
      lookup: (_hostname, options, done) => options.all ? done(null, [address]) : done(null, address.address, address.family),
    }, async res => {
      try {
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of res) { bytes += chunk.length; if (bytes > 8192) throw new Error('Callback response too large.'); chunks.push(chunk); }
        resolve({ status: res.statusCode ?? 500, body: Buffer.concat(chunks).toString('utf8') });
      } catch (error) { res.destroy(); reject(error); }
    });
    req.on('error', reject); req.end(body);
  });
};
