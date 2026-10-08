/**
 * Local web server for the claimant UI.
 *
 * Serves the static frontend and mints a LiveKit token for a fresh room. The token's
 * room configuration dispatches the claim agent, so every "New intake" is a new room
 * and a new agent job. All claim state lives in that job; nothing is stored here.
 */

import 'dotenv/config';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AccessToken, RoomAgentDispatch, RoomConfiguration } from 'livekit-server-sdk';

const HOST = process.env.FNOL_WEB_HOST || '127.0.0.1';
const PORT = Number(process.env.FNOL_WEB_PORT || 4177);
const AGENT_NAME = process.env.FNOL_AGENT_NAME || 'insurance-claim-agent';
const PUBLIC_DIR = resolve(fileURLToPath(new URL('../public', import.meta.url)));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function config() {
  return {
    url: process.env.LIVEKIT_URL || '',
    apiKey: process.env.LIVEKIT_API_KEY || '',
    apiSecret: process.env.LIVEKIT_API_SECRET || '',
  };
}

function missingConfig(): string[] {
  const missing: string[] = [];
  const { url, apiKey, apiSecret } = config();
  if (!url) missing.push('LIVEKIT_URL');
  if (!apiKey) missing.push('LIVEKIT_API_KEY');
  if (!apiSecret) missing.push('LIVEKIT_API_SECRET');
  return missing;
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** Local-only demo: requests from other hosts or cross-site origins are refused. */
function allowed(req: IncomingMessage): boolean {
  const host = (req.headers.host || '').split(':')[0];
  if (!['127.0.0.1', 'localhost'].includes(host!)) return false;
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD' && !origin) return false;
  return true;
}

async function createToken() {
  const { url, apiKey, apiSecret } = config();
  const roomName = `claim-${randomUUID().slice(0, 8)}`;
  const identity = `claimant-${randomUUID().slice(0, 8)}`;
  const token = new AccessToken(apiKey, apiSecret, { identity, name: 'Claimant', ttl: '30m' });
  token.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });
  token.roomConfig = new RoomConfiguration({
    agents: [new RoomAgentDispatch({ agentName: AGENT_NAME })],
  });
  return { url, token: await token.toJwt(), room: roomName, identity };
}

function serveStatic(req: IncomingMessage, res: ServerResponse) {
  const pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname);
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = normalize(join(PUBLIC_DIR, relative));
  if (!file.startsWith(PUBLIC_DIR) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  createReadStream(file).pipe(res);
}

const server = createServer(async (req, res) => {
  if (!allowed(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('This demo accepts local connections only.');
    return;
  }
  const path = new URL(req.url || '/', 'http://localhost').pathname;
  try {
    if (path === '/api/health' && req.method === 'GET') {
      const missing = missingConfig();
      json(res, 200, {
        ok: missing.length === 0,
        missing,
        agent_name: AGENT_NAME,
        voice: process.env.OPENAI_API_KEY ? 'gpt-live' : 'livekit-inference-pipeline',
        avatar: Boolean(process.env.TAVUS_API_KEY),
      });
      return;
    }
    if (path === '/api/token' && req.method === 'POST') {
      const missing = missingConfig();
      if (missing.length) {
        json(res, 503, { detail: `Missing ${missing.join(', ')}. Add them to .env and restart.` });
        return;
      }
      json(res, 200, await createToken());
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(req, res);
      return;
    }
    json(res, 405, { detail: 'Method not allowed' });
  } catch (error) {
    console.error('[web] request failed', error);
    json(res, 500, { detail: 'Request failed' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Claim intake UI on http://${HOST}:${PORT}`);
  const missing = missingConfig();
  if (missing.length) console.warn(`[web] Missing ${missing.join(', ')}; tokens cannot be issued until they are set.`);
});
