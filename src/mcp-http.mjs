import {readJsonBody} from './http-input.mjs';
import { timingSafeEqual } from 'node:crypto';
import { createProtocol, PROTOCOL_VERSIONS } from './mcp.mjs';

const HTTP_VERSIONS = PROTOCOL_VERSIONS.filter(v => v !== '2024-11-05');
const response = (res, status, error, code = -32000) => {
  if(res.destroyed||res.headersSent)return;
  if(status>=400)res.setHeader('Connection','close');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code, message: error } }));
};
const header = (req, name) => typeof req.headers[name] === 'string' ? req.headers[name] : '';
const accepts = (req, type) => header(req, 'accept').split(',').some(value => { const [mime, ...params] = value.trim().toLowerCase().split(';'); return mime === type && !params.some(p => /^\s*q\s*=\s*0(?:\.0*)?\s*$/.test(p)); });
const equalToken = (provided, expected) => {
  if (provided.length > 8192) return false;
  const a = Buffer.from(provided), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Stateless Streamable HTTP with JSON replies; no sessions, SSE, resumability or server push. */
export function createHttpMcpHandler(vault, graph, context, { profile = 'minimal', token, allowedOrigins = [], services = {}, maxBodyBytes = 4 * 1024 * 1024, maxConcurrent = 16 } = {}) {
  if (token !== undefined && (typeof token !== 'string' || token.length < 16 || token.length > 4096)) throw new Error('MCP bearer token must contain 16–4096 characters.');
  if (!Array.isArray(allowedOrigins) || allowedOrigins.some(origin => { try { return new URL(origin).origin !== origin; } catch { return true; } })) throw new Error('allowedOrigins must contain exact URL origins.');
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 256 || maxBodyBytes > 16 * 1024 * 1024) throw new Error('Invalid MCP body limit.');
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 128) throw new Error('Invalid MCP concurrency limit.');
  // Validate the profile and service contract at startup, before accepting traffic.
  createProtocol(vault, graph, context, { profile, services, stateless: true, versions: HTTP_VERSIONS });
  let active = 0, closed = false;
  const handler = async (req, res) => {
    let admitted = false;
    try {
      if (closed) return response(res, 503, 'MCP endpoint is closing.');
      const port = req.socket.localPort, host = header(req, 'host');
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
      if (!hosts.includes(host)) return response(res, 403, 'MCP Host is not allowed.');
      const origin = header(req, 'origin'), ownOrigins = hosts.map(h => `http://${h}`);
      if (origin && !ownOrigins.includes(origin) && !allowedOrigins.includes(origin)) return response(res, 403, 'MCP Origin is not allowed.');
      if (header(req, 'sec-fetch-site') === 'cross-site' && !allowedOrigins.includes(origin)) return response(res, 403, 'Cross-site MCP request denied.');
      const remote = req.socket.remoteAddress || '';
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return response(res, 403, 'MCP HTTP endpoint is local-only.');
      if (token && !equalToken(header(req, 'authorization'), `Bearer ${token}`)) {
        res.setHeader('WWW-Authenticate', 'Bearer realm="mastermind-local"');
        return response(res, 401, 'MCP bearer token required.');
      }
      const version = header(req, 'mcp-protocol-version');
      if (version && !HTTP_VERSIONS.includes(version)) return response(res, 400, 'Unsupported MCP-Protocol-Version.');
      // We never issue sessions. A supplied ID cannot be resumed on this endpoint.
      if (header(req, 'mcp-session-id')) return response(res, 400, 'This MCP endpoint is stateless; omit MCP-Session-Id.');
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return response(res, 405, 'Only POST is supported. SSE, legacy SSE and session DELETE are not provided.');
      }
      if (!accepts(req, 'application/json') || !accepts(req, 'text/event-stream')) return response(res, 406, 'Accept must include application/json and text/event-stream.');
      if (header(req, 'content-type').split(';')[0].trim().toLowerCase() !== 'application/json') return response(res, 415, 'Content-Type must be application/json.');
      if (header(req, 'content-encoding') && header(req, 'content-encoding') !== 'identity') return response(res, 415, 'Compressed MCP request bodies are not supported.');
      if (Number(header(req, 'content-length') || 0) > maxBodyBytes) return response(res, 413, 'MCP body exceeds limit.');
      if (active >= maxConcurrent) { res.setHeader('Retry-After', '1'); return response(res, 429, 'MCP request concurrency limit reached.'); }
      active++; admitted = true;
      let message;
      try { message=await readJsonBody(req,maxBodyBytes); } catch(e) { return response(res,e.status||400,e.message,e.status===400?-32700:-32000); }
      if (!message || Array.isArray(message) || typeof message !== 'object' || message.jsonrpc !== '2.0') return response(res, 400, 'Expected a single JSON-RPC 2.0 message.', -32600);
      // No server-to-client requests are emitted, so there is no response awaiting fulfillment.
      if (!Object.hasOwn(message, 'method')) return response(res, 400, 'Unsolicited JSON-RPC response.');
      const protocol = createProtocol(vault, graph, context, { profile, services, stateless: true, versions: HTTP_VERSIONS });
      const result = await protocol(message);
      if (res.destroyed) return;
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
      if (!result) { res.writeHead(202); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(result));
    } catch (error) {
      if (!res.destroyed && !res.headersSent) response(res, 500, 'MCP request failed.', -32603);
      else if (!res.destroyed) res.end();
    } finally { if (admitted) active--; }
  };
  handler.close = () => { closed = true; };
  handler.status = () => ({ transport: 'streamable-http', stateless: true, authentication: token ? 'bearer' : 'loopback-only', active, closed });
  return handler;
}
