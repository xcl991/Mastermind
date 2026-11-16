import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Vault } from '../src/vault.mjs';
import { Graph } from '../src/graph.mjs';
import { Context } from '../src/context.mjs';
import { createProtocol, serveStdio } from '../src/mcp.mjs';
import { createHttpMcpHandler } from '../src/mcp-http.mjs';
import { clientConfig } from '../src/clients.mjs';
import { updateProperties, createFromTemplate } from '../src/workflows.mjs';
const headers = { 'Content-Type':'application/json', Accept:'application/json, text/event-stream' };
const msg = (method, params={}, id=1) => ({jsonrpc:'2.0',id,method,params});
async function setup(t,options={}) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'mastermind-http-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.writeFile(path.join(root,'Evidence.md'),'# Evidence\n\nThe answer is 7342.\n\n## Next\nMore context.\n');
 const vault=await new Vault(root,{readOnly:Boolean(options.readOnly)}).init(),graph=new Graph(vault),context=new Context(vault,graph);
 const handler=createHttpMcpHandler(vault,graph,context,options),server=http.createServer(handler);server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>{handler.close();server.close(resolve);server.closeAllConnections();}));
 const url=`http://127.0.0.1:${server.address().port}/mcp`;
 return {vault,graph,context,handler,url,post:(body,extra={})=>fetch(url,{method:'POST',headers:{...headers,...extra},body:typeof body==='string'?body:JSON.stringify(body)})};
}
test('official SDK Streamable HTTP: initialize, tools, resources, templates and prompts without sessions',async t=>{
 const {url}=await setup(t,{profile:'research',token:'local-test-token-12345'}),client=new Client({name:'http-test',version:'1'});
 const transport=new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{Authorization:'Bearer local-test-token-12345'}}});await client.connect(transport);t.after(()=>client.close());
 assert.equal(transport.sessionId,undefined);const listing=await client.listTools();assert.ok(listing.tools.some(t=>t.name==='get_context'));assert.ok(!listing.tools.some(t=>t.name==='write_note'));
 const result=await client.callTool({name:'get_context',arguments:{query:'answer',budget:512}});assert.match(result.content[0].text,/7342/);
 assert.equal((await client.listResources()).resources.length,2);assert.equal((await client.listResourceTemplates()).resourceTemplates.length,1);
 const resource=await client.readResource({uri:'mastermind://note/Evidence.md?startLine=3&endLine=3'});assert.match(resource.contents[0].text,/Evidence.md:3-3/);assert.match(resource.contents[0].text,/7342/);
 const prompts=await client.listPrompts();assert.ok(prompts.prompts.some(p=>p.name==='vault_research'));const prompt=await client.getPrompt({name:'vault_research',arguments:{question:'What is the answer?'}});assert.match(prompt.messages[0].content.text,/What is the answer/);
 const capabilities=await client.readResource({uri:'mastermind://capabilities'});assert.equal(JSON.parse(capabilities.contents[0].text).profile,'research');
});
test('HTTP rejects unauthenticated/cross-origin requests, unsupported versions, malformed bodies and sessions',async t=>{
 const {post,url}=await setup(t,{token:'local-test-token-12345',maxBodyBytes:1024});const auth={Authorization:'Bearer local-test-token-12345'};
 assert.equal((await post(msg('initialize',{protocolVersion:'2025-11-25'}))).status,401);
 assert.equal((await post(msg('ping'),{...auth,Origin:'https://evil.invalid'})).status,403);
 assert.equal((await post(msg('ping'),{...auth,'MCP-Protocol-Version':'invalid'})).status,400);
 assert.equal((await post(msg('ping'),{...auth,'MCP-Session-Id':'fake'})).status,400);
 assert.equal((await post(msg('ping'),{...auth,Accept:'application/json'})).status,406);
 assert.equal((await post(msg('ping'),{...auth,'Content-Type':'text/plain'})).status,415);
 assert.equal((await post('{',{...auth})).status,400);
 assert.equal((await post([msg('ping')],auth)).status,400);
 assert.equal((await post({jsonrpc:'2.0',id:1,result:{}},auth)).status,400);
 assert.equal((await post(' '.repeat(1025),auth)).status,413);
 assert.equal((await fetch(url,{headers:{...auth,Accept:'text/event-stream'}})).status,405);
 assert.equal((await fetch(url,{method:'DELETE',headers:auth})).status,405);
 const notification=await post({jsonrpc:'2.0',method:'notifications/initialized'},auth);assert.equal(notification.status,202);assert.equal(await notification.text(),'');
 const badHost=await new Promise((resolve,reject)=>{const r=http.request(url,{method:'POST',headers:{...headers,...auth,Host:'evil.invalid'}},res=>{res.resume();resolve(res.statusCode);});r.on('error',reject);r.end(JSON.stringify(msg('ping')));});assert.equal(badHost,403);
});
test('recursive tool validation stops invalid source receipts and inherited/prototype fields before side effects',async t=>{
 const {vault,graph,context}=await setup(t),protocol=createProtocol(vault,graph,context);await protocol(msg('initialize',{protocolVersion:'2025-11-25'}));
 const source=await vault.read('Evidence.md');const valid={path:'Finding.md',title:'Fact',summary:'A claim',expectedRevision:null,evidence:[{path:'Evidence.md',revision:source.revision,startLine:3,endLine:3}]};
 for(const evidence of [[null],[{...valid.evidence[0],startLine:1.5}],[{...valid.evidence[0],revision:'invalid'}],[{...valid.evidence[0],surprise:true}]]){
  const r=await protocol(msg('tools/call',{name:'save_finding',arguments:{...valid,evidence}}));assert.equal(r.error.code,-32602);
 }
 const poisoned=JSON.parse('{"query":"test","__proto__":{"polluted":true}}');assert.equal((await protocol(msg('tools/call',{name:'get_context',arguments:poisoned}))).error.code,-32602);
 assert.equal((await protocol(msg('tools/call',{name:'get_context',arguments:Object.create({query:'test'})}))).error.code,-32602);assert.equal({}.polluted,undefined);
 await assert.rejects(vault.read('Finding.md'),{status:404});
});
test('resource bounds, traversal rejection and prompt arguments cannot widen read access',async t=>{
 const {vault,graph,context}=await setup(t),protocol=createProtocol(vault,graph,context,{profile:'minimal'});await protocol(msg('initialize',{protocolVersion:'2025-11-25'}));
 for(const uri of ['file:///etc/passwd','mastermind://note/%2E%2E%2Foutside.md','mastermind://note/Evidence.md?startLine=-1','mastermind://note/Evidence.md?endLine=hello','mastermind://user@note/Evidence.md'])assert.ok((await protocol(msg('resources/read',{uri}))).error,uri);
 assert.equal((await protocol(msg('prompts/get',{name:'note_review',arguments:{}}))).error.code,-32602);
 assert.equal((await protocol(msg('prompts/get',{name:'note_review',arguments:{path:'Evidence.md',extra:'bad'}}))).error.code,-32602);
 assert.equal((await protocol(msg('resources/list',{cursor:'bad'}))).error.code,-32602);
 const r=await protocol(msg('resources/read',{uri:'mastermind://note/Evidence.md'}));assert.match(r.result.contents[0].text,/revision [a-f0-9]{64}/);
});
test('service tools are discoverable only when implemented; read-only profiles cannot call mutations',async t=>{
 let wrote=false;const {vault,graph,context}=await setup(t,{readOnly:true});const services={queryVault:async()=>({rows:[]}),updateTask:async()=>{wrote=true;},renameNote:async()=>{wrote=true;}};
 const p=createProtocol(vault,graph,context,{profile:'full',services});await p(msg('initialize',{protocolVersion:'2025-11-25'}));const names=(await p(msg('tools/list'))).result.tools.map(t=>t.name);assert.ok(names.includes('query_vault'));assert.ok(!names.includes('update_task'));assert.ok(!names.includes('rename_note'));
 assert.equal((await p(msg('tools/call',{name:'update_task',arguments:{}}))).error.code,-32602);assert.equal(wrote,false);
 const writable={...vault,readOnly:false},p2=createProtocol(writable,graph,context,{profile:'full',services});await p2(msg('initialize',{protocolVersion:'2025-11-25'}));const result=await p2(msg('tools/call',{name:'rename_note',arguments:{from:'Evidence.md',to:'Other.md',expectedRevision:'a'.repeat(64),dryRun:false}}));assert.equal(result.result.isError,true);assert.equal(wrote,false);
});
test('client formats preserve read-only scope and use each documented nesting and token reference',()=>{
 const vault={root:'/vault path',stateRoot:'/state',readOnly:true,exclude:['vendor/**']};
 for(const format of ['json','claude','cursor']){const c=clientConfig(vault,{format});assert.ok(c.mcpServers.mastermind.args.includes('--read-only'));assert.ok(c.mcpServers.mastermind.args.includes('vendor/**'));}
 assert.equal(clientConfig(vault,{format:'vscode'}).servers.mastermind.type,'stdio');assert.equal(clientConfig(vault,{format:'opencode'}).mcp.servers.mastermind.type,'local');assert.match(clientConfig(vault,{format:'codex'}),/startup_timeout_sec = 120/);
 for(const format of ['claude','cursor','vscode','opencode','codex'])assert.match(JSON.stringify(clientConfig(vault,{format,transport:'http',url:'http://127.0.0.1:6969/mcp',tokenEnv:'MASTERMIND_MCP_TOKEN'})),/MASTERMIND_MCP_TOKEN/);
 assert.throws(()=>clientConfig(vault,{format:'invented'}));assert.throws(()=>clientConfig(vault,{transport:'http',url:'file:///vault'}));assert.throws(()=>clientConfig(vault,{transport:'http',url:'http://127.0.0.1/mcp',tokenEnv:'TOKEN'}));
});
test('structured edit tools preserve revisions, accept safe JSON properties and return compact creation receipts',async t=>{
 const {vault,graph,context}=await setup(t),services={updateProperties:a=>updateProperties(vault,a),createFromTemplate:a=>createFromTemplate(vault,a),writeDocument:a=>vault.writeDocument(a.path,a.content,a.expectedRevision)};
 const p=createProtocol(vault,graph,context,{profile:'full',services});await p(msg('initialize',{protocolVersion:'2025-11-25'}));
 const invoke=(name,args)=>p(msg('tools/call',{name,arguments:args}));let source=await vault.read('Evidence.md');
 const changed=await invoke('update_properties',{path:'Evidence.md',expectedRevision:source.revision,properties:{status:'active',score:2.5,archived:false,unset:null,metadata:{owners:['Steven'],progress:3}}});
 assert.equal(changed.result.isError,undefined);source=await vault.read('Evidence.md');assert.equal(source.properties.metadata.progress,3);assert.match(source.content,/The answer is 7342/);
 const created=await invoke('create_from_template',{path:'Draft.md',expectedRevision:null,template:'# {{title}}\nCreated {{date}}',title:'Review',date:'2026-11-16'});
 const receipt=JSON.parse(created.result.content[0].text);assert.equal(receipt.path,'Draft.md');assert.equal(receipt.content,undefined);assert.match(receipt.revision,/^[a-f0-9]{64}$/);assert.equal((await vault.read('Draft.md')).content,'# Review\nCreated 2026-11-16');
 assert.equal((await invoke('create_from_template',{path:'Draft.md',expectedRevision:null,template:'replace'})).result.isError,true);
 for(const [path,content] of [['Tasks.base','views:\n  - type: table\n    name: Tasks\n'],['Map.canvas','{"nodes":[],"edges":[]}']]){
  const result=await invoke('write_document',{path,content,expectedRevision:null});assert.equal(result.result.isError,undefined);assert.equal(JSON.parse(result.result.content[0].text).path,path);assert.equal((await vault.read(path)).content,content);
 }
 assert.equal((await invoke('write_document',{path:'Map.canvas',content:'invalid',expectedRevision:(await vault.read('Map.canvas')).revision})).result.isError,true);
 assert.equal((await vault.read('Map.canvas')).content,'{"nodes":[],"edges":[]}');
});
test('structured tools hide without services or write access and reject unsafe nested values before invoking services',async t=>{
 const {vault,graph,context}=await setup(t);let calls=0;const services={updateProperties:async()=>{calls++;},createFromTemplate:async()=>{calls++;},writeDocument:async()=>{calls++;}};
 const names=['update_properties','create_from_template','write_document'];
 for(const options of [{profile:'full'},{profile:'research',services},{profile:'minimal',services},{profile:'full',services,readOnly:true}]){
  const p=createProtocol({...vault,readOnly:options.readOnly??false},graph,context,options);await p(msg('initialize',{protocolVersion:'2025-11-25'}));const listed=(await p(msg('tools/list'))).result.tools.map(t=>t.name);for(const name of names)assert.ok(!listed.includes(name));
 }
 const p=createProtocol(vault,graph,context,{profile:'full',services});await p(msg('initialize',{protocolVersion:'2025-11-25'}));const invoke=(name,args)=>p(msg('tools/call',{name,arguments:args}));
 const args={path:'Evidence.md',expectedRevision:'a'.repeat(64)};
 for(const properties of [JSON.parse('{"safe":{"constructor":{"bad":true}}}'),{nested:{value:undefined}},{nested:[Infinity]},{'bad\nkey':1},{large:'x'.repeat(4001)}])assert.equal((await invoke('update_properties',{...args,properties})).error.code,-32602);
 assert.equal((await invoke('update_properties',{path:'Evidence.md',properties:{safe:true}})).error.code,-32602);
 assert.equal((await invoke('create_from_template',{path:'Draft.md',template:'text'})).error.code,-32602);
 assert.equal((await invoke('create_from_template',{path:'Draft.md',expectedRevision:null,template:'text',templatePath:'Evidence.md'})).result.isError,true);
 assert.equal((await invoke('write_document',{path:'script.js',expectedRevision:null,content:'text'})).error.code,-32602);
 assert.equal(calls,0);
});
test('stdio framing keeps errors separate and processes the following valid request',async()=>{
 const input=new PassThrough(),output=new PassThrough();let result='';output.on('data',chunk=>result+=chunk);
 const run=serveStdio(async m=>({jsonrpc:'2.0',id:m.id,result:{ok:true}}),input,output);input.end('{bad}\n'+JSON.stringify(msg('ping'))+'\n');await run;const lines=result.trim().split('\n').map(JSON.parse);assert.equal(lines[0].error.code,-32700);assert.equal(lines[1].result.ok,true);
});
