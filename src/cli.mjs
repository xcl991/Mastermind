#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Vault } from './vault.mjs';
import { Graph } from './graph.mjs';
import { clientConfig } from './clients.mjs';
import {createServices} from './services.mjs';
import {queryVault} from './query.mjs';
import {healthCheck} from './workspace.mjs';
import { Context } from './context.mjs';
import { createServer } from './server.mjs';
import { createProtocol, serveStdio } from './mcp.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2), command = args[0] || 'serve';
const option = (name, fallback) => { const at = args.indexOf(name); if (at === -1) return fallback; if (!args[at + 1] || args[at + 1].startsWith('--')) throw new Error(`Nilai ${name} diperlukan.`); return args[at + 1]; };
try {
  if (command === 'infra') { await (await import('../scripts/infra.mjs')).infraMain(args.slice(1)); }
  else if (command === '--help' || args.includes('--help')) {
    console.log('Mastermind\n  node src/cli.mjs serve [--vault PATH] [--port 6969]\n  node src/cli.mjs mcp --vault PATH\n  node src/cli.mjs context --query "pertanyaan" [--budget 2000] [--vault PATH]\n  node src/cli.mjs graph [--vault PATH]\n  node src/cli.mjs mcp-config [--vault PATH]\n\nOptions: --read-only --state-dir PATH --exclude GLOB (repeatable)\nMCP: --profile minimal|research|full (default minimal); mcp-config --format codex\nQuery: query --query TABLE...\nDoctor: doctor --vault PATH\nMCP HTTP: http://127.0.0.1:PORT/mcp; optional MASTERMIND_MCP_TOKEN environment variable\nContext: --text outputs only budgeted context\nNode.js 22+. Default vault: folder vault/ di direktori aplikasi.');
  } else {
    if (!['serve', 'mcp', 'context', 'graph', 'mcp-config', 'query', 'doctor'].includes(command)) throw new Error(`Perintah tidak dikenal: ${command}`);
    const vaultPath = option('--vault', process.env.MASTERMIND_VAULT || path.join(root, 'vault'));
    const exclude = args.flatMap((a, i) => a === '--exclude' ? [args[i + 1]] : []);
    const vault = await new Vault(vaultPath, { readOnly: args.includes('--read-only'), stateDir: option('--state-dir', undefined), exclude }).init();
    if (command === 'serve' && path.resolve(vaultPath) === path.join(root, 'vault') && !(await fs.readdir(vault.root)).length) {
      await fs.cp(path.join(root, 'examples/vault'), vault.root, { recursive: true, force: false }); await vault.refresh(true);
    }
    const graph = new Graph(vault), context = new Context(vault, graph);
    if (command === 'mcp') await serveStdio(createProtocol(vault, graph, context, { profile: option('--profile', 'minimal'), services: createServices(vault,graph) }));
    else if (command === 'mcp-config') { const config = clientConfig(vault, { profile: option('--profile', 'minimal'), format: option('--format', 'json'), transport: option('--transport', 'stdio'), url: option('--url', option('--transport','stdio') === 'http' ? 'http://127.0.0.1:6969/mcp' : undefined) }); console.log(typeof config === 'string' ? config : JSON.stringify(config, null, 2)); }
    else if (command === 'query') console.log(JSON.stringify(await queryVault(vault,option('--query','LIST'),{limit:Number(option('--limit','100'))}),null,2));
    else if (command === 'doctor') console.log(JSON.stringify({health:await healthCheck(vault,graph),storage:await vault.doctor()},null,2));
    else if (command === 'graph') console.log(JSON.stringify(await graph.build(), null, 2));
    else if (command === 'context') { const result = await context.get(option('--query', ''), option('--budget', '2000')); console.log(args.includes('--text') ? result.text : JSON.stringify(result, null, 2)); }
    else {
      const port = Number(option('--port', process.env.PORT || '6969')); if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port tidak valid.');
      const server = createServer(vault, graph, context, {profile: option('--profile','minimal'),mcpToken: process.env.MASTERMIND_MCP_TOKEN});
      server.on('error', e => { console.error(`Mastermind: ${e.message}`); process.exitCode = 1; });
      server.listen(port, '127.0.0.1', () => console.log(`Mastermind → http://127.0.0.1:${server.address().port}\nVault: ${vault.root}\nLocal only · MCP stdio + HTTP /mcp available · No model API calls`));
      for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
    }
  }
} catch (e) { console.error(`Mastermind: ${e.message}`); process.exitCode = 1; }
