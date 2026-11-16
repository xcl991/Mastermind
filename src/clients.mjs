import path from 'node:path';
import { fileURLToPath } from 'node:url';
const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
export const CLIENT_FORMATS = ['json', 'claude', 'cursor', 'vscode', 'codex', 'opencode', 'copilot'];
const toml = value => JSON.stringify(value).replace(/\u007f/g, '\\u007f');
export function clientConfig(vault, { profile = 'minimal', format = 'json', transport = 'stdio', url, tokenEnv } = {}) {
  if (!CLIENT_FORMATS.includes(format)) throw new Error('Unknown client format: ' + format);
  if (!['minimal','research','full'].includes(profile)) throw new Error('Unknown MCP profile.');
  if (!['stdio','http'].includes(transport)) throw new Error('Unknown MCP transport.');
  if (tokenEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) throw new Error('Invalid token environment variable name.');
  const args = [cli, 'mcp', '--vault', vault.root, '--profile', profile];
  if (vault.readOnly) args.push('--read-only');
  if (vault.stateRoot && vault.stateRoot !== path.join(vault.root, '.mastermind')) args.push('--state-dir', vault.stateRoot);
  for (const rule of vault.exclude || []) args.push('--exclude', rule);
  if (transport === 'stdio') {
    if (url || tokenEnv) throw new Error('url/tokenEnv only apply to HTTP configurations.');
    if (format === 'codex') return `[mcp_servers.mastermind]\ncommand = ${toml(process.execPath)}\nargs = ${toml(args)}\nstartup_timeout_sec = 120\n`;
    if (format === 'vscode') return { servers: { mastermind: { type:'stdio', command:process.execPath, args } } };
    if (format === 'copilot') return { mcpServers: { mastermind: {type:'stdio', command:process.execPath, args, tools:['*']} } };
    if (format === 'opencode') return { mcp: { servers: { mastermind: { type:'local', command:[process.execPath,...args] } } } };
    return { mcpServers: { mastermind: { ...(format === 'cursor' ? {type:'stdio'} : {}), command: process.execPath, args } } };
  }
  let endpoint; try { endpoint = new URL(url); } catch { throw new Error('HTTP configuration requires an absolute MCP URL.'); }
  if (!['http:','https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) throw new Error('Invalid MCP HTTP URL.');
  if (format === 'codex') return `[mcp_servers.mastermind]\nurl = ${toml(endpoint.href)}\n${tokenEnv ? `bearer_token_env_var = ${toml(tokenEnv)}\n` : ''}startup_timeout_sec = 120\n`;
  if (format === 'vscode') return { servers: { mastermind: { type:'http', url:endpoint.href, ...(tokenEnv ? {headers:{Authorization:`Bearer \${env:${tokenEnv}}`}} : {}) } } };
  if (format === 'opencode') return { mcp: { servers: { mastermind: { type:'remote', url:endpoint.href, oauth:false, ...(tokenEnv ? {headers:{Authorization:`Bearer {env:${tokenEnv}}`}} : {}) } } } };
  if (format === 'copilot') return { mcpServers: { mastermind: {type:'http', url:endpoint.href, tools:['*'], ...(tokenEnv ? {headers:{Authorization:`Bearer \${${tokenEnv}}`}} : {})} } };
  if (format === 'cursor') return { mcpServers: { mastermind: { url:endpoint.href, ...(tokenEnv ? {headers:{Authorization:`Bearer \${env:${tokenEnv}}`}} : {}) } } };
  // Generic JSON has no universally defined environment interpolation; omit secret values.
  if (format === 'json' && tokenEnv) throw new Error('Generic JSON cannot express a portable token environment reference. Select a named client format.');
  return { mcpServers: { mastermind: { type:'http', url:endpoint.href, ...(tokenEnv ? {headers:{Authorization:`Bearer \${${tokenEnv}}`}} : {}) } } };
}
