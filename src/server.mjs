import http from 'node:http';
import {readJsonBody,isLoopback} from './http-input.mjs';
import {createHttpMcpHandler} from './mcp-http.mjs';
import {createServices} from './services.mjs';
import {queryVault,queryBase} from './query.mjs';
import {previewRename,applyRename,listWorkflows,recoverWorkflow,updateTask,updateProperties,createFromTemplate,previewRestore,applyRestore} from './workflows.mjs';
import {listExtensions,installExtension,changeExtension,healthCheck,notePage} from './workspace.mjs';
import {embedSource,serveAsset} from './attachments.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';
import { clientConfig } from './clients.mjs';
import { resolveLink } from './graph.mjs';
import { splitTarget, sectionOf } from './markdown.mjs';
import { fail } from './vault.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const staticFiles = new Map([
  ['/markdown-view.js',['public/markdown-view.js','text/javascript']], ['/workspace-ui.js',['public/workspace-ui.js','text/javascript']], ['/canvas-editor.js',['public/canvas-editor.js','text/javascript']],
  ['/vendor/katex.js',['node_modules/katex/dist/katex.mjs','text/javascript']], ['/vendor/katex.css',['node_modules/katex/dist/katex.min.css','text/css']],
  ['/examples/research-workspace.json',['examples/extensions/research-workspace.json','application/json']],
  ['/editor.bundle.js', ['public/editor.bundle.js', 'text/javascript']],
  ['/', ['public/index.html', 'text/html']], ['/app.js', ['public/app.js', 'text/javascript']], ['/graph-view.js', ['public/graph-view.js', 'text/javascript']], ['/style.css', ['public/style.css', 'text/css']],
  ['/vendor/marked.js', ['node_modules/marked/lib/marked.esm.js', 'text/javascript']], ['/vendor/purify.js', ['node_modules/dompurify/dist/purify.es.mjs', 'text/javascript']]
]);
export function createServer(vault, graph, context, options = {}) {
  const maxBodyBytes=options.maxBodyBytes??16*1024*1024,maxConcurrent=options.maxConcurrent??32;
  if(!Number.isInteger(maxBodyBytes)||maxBodyBytes<256||maxBodyBytes>16*1024*1024||!Number.isInteger(maxConcurrent)||maxConcurrent<1||maxConcurrent>128)throw new Error('Invalid HTTP limits.');
  const body=async req=>{const value=await readJsonBody(req,maxBodyBytes);if(!value||typeof value!=='object'||Array.isArray(value))throw fail('JSON object diperlukan.',400);return value;};
  let active=0;
  const services = createServices(vault, graph), mcp = createHttpMcpHandler(vault, graph, context, {profile: options.profile || 'minimal', token: options.mcpToken, services});
  const server = http.createServer(async (req, res) => {
    const json = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    let admitted=false,released=false;const release=()=>{if(admitted&&!released){released=true;active--;}};res.once('finish',release);res.once('close',release);
    try {
      if(!isLoopback(req.socket.remoteAddress))throw fail('HTTP endpoint is local-only.',403);
      if(active>=maxConcurrent){res.setHeader('Retry-After','1');throw fail('HTTP request concurrency limit reached.',429);}
      active++;admitted=true;
      if (new URL(req.url, 'http://localhost').pathname === '/mcp') return await mcp(req, res);
      const port = res.socket.localPort, hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!hosts.includes(req.headers.host)) throw fail('Host tidak diizinkan.', 403);
      if (req.headers.origin && !hosts.map(h => `http://${h}`).includes(req.headers.origin)) throw fail('Origin tidak diizinkan.', 403);
      if (req.headers['sec-fetch-site'] === 'cross-site') throw fail('Cross-site request ditolak.', 403);
      const url = new URL(req.url, `http://${req.headers.host}`), route = url.pathname, method = req.method;
      const mutations = ['POST', 'PUT', 'DELETE'];
      if (mutations.includes(method) && (req.headers['x-mastermind'] !== 'local' || req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json')) throw fail('Header aplikasi diperlukan.', 403);
      if (method === 'GET' && staticFiles.has(route)) { const [file, mime] = staticFiles.get(route); const bytes=await fs.readFile(path.join(root,file)); res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8`, 'Cache-Control': 'no-cache' }); res.end(bytes); return; }
      if (method === 'GET' && route === '/api/status') return json({ name: 'Mastermind', version: '0.3.3', readOnly: vault.readOnly, vault: vault.root, node: process.version, memoryMiB: Math.round(process.memoryUsage().rss / 1048576), mcp: ['stdio','streamable-http'], mcpHttp: mcp.status(), modelApiCalls: 0 });
      if (method === 'GET' && route.startsWith('/vendor/fonts/')) { const name = route.slice('/vendor/fonts/'.length); if (!/^[A-Za-z0-9_-]+\.woff2$/.test(name)) throw fail('Font not found.', 404); const file = path.join(root, 'node_modules/katex/dist/fonts', name); const bytes=await fs.readFile(file); res.writeHead(200, {'Content-Type':'font/woff2','Cache-Control':'public, max-age=86400'}); res.end(bytes); return; }
      if (method === 'GET' && route === '/api/notes-page') return json(await notePage(vault,{query:url.searchParams.get('q')||'',offset:Number(url.searchParams.get('offset')||0),limit:Number(url.searchParams.get('limit')||100)}));
      if (method === 'POST' && route === '/api/query') {const a=await body(req);return json(await queryVault(vault,a.query,{limit:a.limit??100,offset:a.offset??0}));}
      if (method === 'POST' && route === '/api/base') {const a=await body(req);return json(await queryBase(vault,a.content,a.view,{limit:a.limit??100,offset:a.offset??0}));}
      if (method === 'PUT' && route === '/api/task') return json(await updateTask(vault,await body(req)));
      if (method === 'PUT' && route === '/api/properties') return json(await updateProperties(vault,await body(req)));
      if (method === 'PUT' && route === '/api/document') {const a=await body(req);return json(await vault.writeDocument(a.path,a.content,a.expectedRevision));}
      if (method === 'POST' && route === '/api/template') return json(await createFromTemplate(vault,await body(req)));
      if (method === 'POST' && route === '/api/rename/preview') return json(await previewRename(vault,await body(req)));
      if (method === 'POST' && route === '/api/rename/apply') return json(await applyRename(vault,await body(req)));
      if (method === 'GET' && route === '/api/workflows') return json(await listWorkflows(vault));
      if (method === 'POST' && route === '/api/workflows/recover') return json(await recoverWorkflow(vault,await body(req)));
      if (method === 'POST' && route === '/api/restore/preview') return json(await previewRestore(vault,await body(req)));
      if (method === 'POST' && route === '/api/restore/apply') return json(await applyRestore(vault,await body(req)));
      if (method === 'GET' && route === '/api/extensions') return json(await listExtensions(vault));
      if (method === 'POST' && route === '/api/extensions') return json(await installExtension(vault,await body(req)));
      if (method === 'PUT' && route === '/api/extensions') return json(await changeExtension(vault,await body(req)));
      if (method === 'GET' && route === '/api/health') return json(await healthCheck(vault,graph));
      if (method === 'GET' && route === '/api/embed') return json(await embedSource(vault,url.searchParams.get('from'),url.searchParams.get('target')));
      if (method === 'GET' && route === '/api/notes') return json(await vault.list(url.searchParams.get('q') || ''));
      if (method === 'GET' && route === '/api/note') return json(await vault.read(url.searchParams.get('path')));
      if (method === 'PUT' && route === '/api/note') { const a = await body(req); return json(await vault.write(a.path, a.content, a.expectedRevision)); }
      if (method === 'DELETE' && route === '/api/note') { const a = await body(req); return json(await vault.trash(a.path, a.expectedRevision)); }
      if (method === 'GET' && route === '/api/graph-view') {const g=await graph.build(),q=(url.searchParams.get('q')||'').slice(0,2000).toLowerCase(),type=url.searchParams.get('type')||'all',matched=g.nodes.filter(n=>(type==='all'||n.type===type)&&`${n.label} ${n.id}`.toLowerCase().includes(q)),nodes=matched.slice(0,350),ids=new Set(nodes.map(n=>n.id));return json({nodes,links:g.links.filter(e=>ids.has(e.source)&&ids.has(e.target)).slice(0,3000),totalNodes:g.nodes.length,totalMatches:matched.length,truncated:matched.length>350});}
      if (method === 'GET' && route === '/api/local-graph') {const id=url.searchParams.get('path'),g=await graph.build(),links=g.links.filter(e=>e.source===id||e.target===id).slice(0,100),ids=new Set([id,...links.flatMap(e=>[e.source,e.target])]);return json({nodes:g.nodes.filter(n=>ids.has(n.id)),links,totalNodes:g.nodes.length,truncated:links.length===100});}
      if (method === 'GET' && route === '/api/graph') return json(await graph.build());
      if (method === 'GET' && route === '/api/neighbors') return json(await graph.neighbors(url.searchParams.get('path')));
      if (method === 'GET' && route === '/api/path') return json(await graph.shortestPath(url.searchParams.get('from'), url.searchParams.get('to')));
      if (method === 'GET' && route === '/api/context') return json(await context.get(url.searchParams.get('q') || '', url.searchParams.get('budget')));
      if (method === 'POST' && route === '/api/import-canvas') return json(await graph.importCanvas(await body(req)));
      if (method === 'POST' && route === '/api/import-graph') return json(await graph.import(await body(req)));
      if (method === 'GET' && route === '/api/export') {
        const format = url.searchParams.get('format'), data = format === 'canvas' ? await graph.canvas() : format === 'original' ? await graph.imported() : await graph.build();
        res.setHeader('Content-Disposition', `attachment; filename="${format === 'canvas' ? 'mastermind.canvas' : 'graph.json'}"`); return json(data);
      }
      if (method === 'GET' && route === '/api/mcp-config') return json(clientConfig(vault, { format: url.searchParams.get('format') || 'json', transport: url.searchParams.get('transport') || 'stdio', url: url.searchParams.get('transport') === 'http' ? `http://${req.headers.host}/mcp` : undefined, profile: options.profile || 'minimal' }));
      if (method === 'GET' && route === '/api/section') return json(await context.getSection(url.searchParams.get('path'), url.searchParams.get('selector') || '', url.searchParams.get('budget')));
      if (method === 'GET' && route === '/api/resolve') { await vault.refresh(); const ref = splitTarget(url.searchParams.get('target') || ''), id = resolveLink(ref.target, url.searchParams.get('from') || '', vault.entries, url.searchParams.get('kind') || 'wiki'); return json({ path: id, selector: ref.fragment, section: id && ref.fragment ? sectionOf(await vault.read(id), ref.fragment) : null }); }
      if (method === 'GET' && route === '/api/history') return json(url.searchParams.has('version') ? await vault.historyRead(url.searchParams.get('path'), url.searchParams.get('version')) : await vault.history(url.searchParams.get('path')));
      if (method === 'POST' && route === '/api/history/restore') { const a = await body(req); return json(await vault.restoreHistory(a.path, a.version, a.expectedRevision)); }
      if (method === 'GET' && route === '/api/trash') return json(await vault.listTrash());
      if (method === 'POST' && route === '/api/trash/restore') { const a = await body(req); return json(await vault.restoreTrash(a.trashId, a.targetPath)); }
      if (method === 'GET' && route === '/api/doctor') return json(await vault.doctor());
      if (method === 'GET' && route === '/api/backup') { await vault.refresh(true); const files = {}, manifest = []; let bytes = 0; for (const n of vault.entries.values()) { if (n.type !== 'note') continue; const current = await vault.read(n.id); bytes += Buffer.byteLength(current.content); if (bytes > 32 * 1024 * 1024) throw fail('Backup catatan maksimum 32 MiB; salin vault melalui filesystem untuk backup besar.', 413); files[n.id] = strToU8(current.content); manifest.push({ path: n.id, revision: current.revision }); } files['mastermind-backup-manifest.json'] = strToU8(JSON.stringify({ created: new Date().toISOString(), scope: 'Markdown notes only; excludes attachments, plugins and history', files: manifest }, null, 2)); res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="mastermind-notes.zip"', 'Cache-Control': 'no-store' }); res.end(zipSync(files)); return; }

      if (['GET','HEAD'].includes(method) && route === '/api/asset') return await serveAsset(vault,url.searchParams.get('path'),req,res);
      throw fail('Endpoint tidak ditemukan.', 404);
    } catch (e) { if(res.destroyed)return;if(!req.complete&&!res.headersSent)res.setHeader('Connection','close');if (!res.headersSent) json({ error: e.code === 'ENOENT' ? 'File tidak ditemukan.' : e.message }, e.status || (e.code === 'ENOENT' ? 404 : 500)); else res.end(); }
  });
  server.on('close', () => mcp.close());
  server.headersTimeout = 15000; server.requestTimeout = 30000; server.maxRequestsPerSocket=1000; server.setTimeout(30000,socket=>socket.destroy());
  return server;
}
