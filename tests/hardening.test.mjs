import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {once} from 'node:events';
import {Vault} from '../src/vault.mjs';
import {Graph} from '../src/graph.mjs';
import {Context} from '../src/context.mjs';
import {createServer} from '../src/server.mjs';
import {installExtension,changeExtension} from '../src/workspace.mjs';
const headers={'Content-Type':'application/json','X-Mastermind':'local'};
async function setup(t,options={}){const root=await fs.mkdtemp(path.join(os.tmpdir(),'mastermind-hardening-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const vault=await new Vault(root).init();await vault.write('Evidence.md','# Evidence\nFact 7342.',null);const graph=new Graph(vault),server=createServer(vault,graph,new Context(vault,graph),options);server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));return {root,vault,graph,server,base:`http://127.0.0.1:${server.address().port}`};}
function raw(base,url,data,extra={},method='POST'){return new Promise((resolve,reject)=>{const req=http.request(base+url,{method,headers:{...headers,...extra}},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,body}));});req.on('error',reject);req.setTimeout(5000,()=>req.destroy(new Error('Request timeout')));req.write(data);req.end();});}
test('API validates UTF-8, JSON object, nesting, exact MIME, encoding and chunked request size',async t=>{
 const {base,vault}=await setup(t,{maxBodyBytes:1024});const before=(await vault.read('Evidence.md')).revision;
 for(const payload of ['null','[]','"string"','{'])assert.equal((await raw(base,'/api/query',payload)).status,400,payload);
 assert.equal((await raw(base,'/api/query',Buffer.from([123,34,113,34,58,34,255,34,125]))).status,400);
 assert.equal((await raw(base,'/api/query','{}',{'Content-Type':'application/json-invalid'})).status,403);
 assert.equal((await raw(base,'/api/query','{}',{'Content-Encoding':'gzip'})).status,415);
 assert.equal((await raw(base,'/api/query','{"x":'+('['.repeat(65))+'0'+(']'.repeat(65))+'}')).status,413);
 assert.equal((await raw(base,'/api/query',' '.repeat(1025))).status,413);
 assert.equal((await fetch(base+'/api/status')).status,200);assert.equal((await vault.read('Evidence.md')).revision,before);
});
test('HTTP caps in-flight bodies, rejects excess work and recovers after requests finish',async t=>{
 const {base}=await setup(t,{maxConcurrent:2});const held=[];
 for(let i=0;i<2;i++){let done;const finished=new Promise((resolve,reject)=>{done={resolve,reject};});const req=http.request(base+'/api/query',{method:'POST',headers},res=>{res.resume();res.on('end',()=>done.resolve(res.statusCode));});req.on('error',done.reject);req.flushHeaders();await once(req,'socket');req.write('{');held.push({req,finished});}
 // A response after both connections sent headers establishes the admission boundary.
 let overloaded;for(let i=0;i<20;i++){overloaded=await fetch(base+'/api/status');if(overloaded.status===429)break;await overloaded.body.cancel();await new Promise(r=>setTimeout(r,10));}
 assert.equal(overloaded.status,429);assert.equal(overloaded.headers.get('Retry-After'),'1');await overloaded.body.cancel();for(const h of held)h.req.end('"query":"LIST"}');assert.deepEqual(await Promise.all(held.map(h=>h.finished)),[200,200]);assert.equal((await fetch(base+'/api/status')).status,200);
});
test('local-only checks cover app routes; Host/Origin and cross-site requests cannot write',async t=>{
 const {base,vault,server}=await setup(t);const note=await vault.read('Evidence.md');
 for(const extra of [{Origin:'https://evil.invalid'},{Host:'evil.invalid'},{'Sec-Fetch-Site':'cross-site'}])assert.equal((await raw(base,'/api/note',JSON.stringify({path:note.id,content:'bad',expectedRevision:note.revision}),extra,'PUT')).status,403,JSON.stringify(extra));
 assert.equal((await vault.read(note.id)).revision,note.revision);
 server.prependListener('request',req=>Object.defineProperty(req.socket,'remoteAddress',{value:'192.0.2.9',configurable:true}));assert.equal((await fetch(base+'/api/status')).status,403);
});
test('missing static assets return 404; invalid/overflow ranges return 416 without crashing',async t=>{
 const {root,base}=await setup(t);await fs.writeFile(path.join(root,'clip.mp3'),'0123456789');assert.equal((await fetch(base+'/vendor/fonts/Does_Not_Exist.woff2')).status,404);
 for(const range of ['bytes=-0','bytes=999999999999999999999-','bytes=-999999999999999999999','bytes=1-999999999999999999999','bytes=4-2','bytes=0-1,4-5']){const r=await fetch(base+'/api/asset?path=clip.mp3',{headers:{Range:range}});assert.equal(r.status,416,range);assert.equal(r.headers.get('Content-Range'),'bytes */10');await r.body.cancel();}
 const response=await fetch(base+'/api/asset?path=clip.mp3',{headers:{Range:'bytes=-3'}});assert.equal(response.status,206);assert.equal(await response.text(),'789');
});
test('read-only with external state rejects graph and extension mutations while preserving existing state',async t=>{
 const {root,vault,graph}=await setup(t);await graph.import({nodes:[{id:'before'}],links:[]});await installExtension(vault,{schemaVersion:1,id:'read-only-test',name:'Test',version:'1',commands:[]});
 const ro=await new Vault(root,{readOnly:true,stateDir:path.join(path.dirname(root),path.basename(root)+'-state')}).init();t.after(()=>fs.rm(ro.stateRoot,{recursive:true,force:true}));await fs.mkdir(ro.stateRoot);await fs.copyFile(path.join(vault.stateRoot,'imported-graph.json'),path.join(ro.stateRoot,'imported-graph.json'));await fs.copyFile(path.join(vault.stateRoot,'extensions.json'),path.join(ro.stateRoot,'extensions.json'));
 const before=await fs.readFile(path.join(ro.stateRoot,'imported-graph.json'));const rg=new Graph(ro);await assert.rejects(rg.import({nodes:[],links:[]}),{status:403});await assert.rejects(installExtension(ro,{schemaVersion:1,id:'new-ext',name:'Test',version:'1',commands:[]}),{status:403});await assert.rejects(changeExtension(ro,{id:'read-only-test',enabled:true}),{status:403});assert.deepEqual(await fs.readFile(path.join(ro.stateRoot,'imported-graph.json')),before);assert.equal(JSON.parse(await fs.readFile(path.join(ro.stateRoot,'extensions.json')))[0].enabled,false);
});
test('oversized graph imports cannot poison the previous persisted graph',async t=>{
 const {graph}=await setup(t);await graph.import({nodes:[{id:'original'}],links:[]});await assert.rejects(graph.import({nodes:[{id:'large',text:'x'.repeat(16*1024*1024)}],links:[]}),{status:413});assert.equal((await graph.imported()).nodes[0].id,'original');await assert.rejects(graph.importCanvas({nodes:[null],edges:[]}),{status:400});
});
test('MCP chunked oversized and invalid UTF-8 requests return bounded errors and remain usable',async t=>{
 const {base}=await setup(t);const extra={Accept:'application/json, text/event-stream'};assert.equal((await raw(base,'/mcp',' '.repeat(4*1024*1024+1),extra)).status,413);assert.equal((await raw(base,'/mcp',Buffer.from([255]),extra)).status,400);const r=await raw(base,'/mcp',JSON.stringify({jsonrpc:'2.0',id:1,method:'ping'}),extra);assert.equal(r.status,200);assert.deepEqual(JSON.parse(r.body).result,{});
});

test('bounded soak: 400 reads/queries and 40 edits retain exact revisions and release admission slots',async t=>{
 const {base,vault}=await setup(t);let current=await vault.read('Evidence.md');
 for(let round=0;round<20;round++){
  const results=await Promise.all(Array.from({length:20},(_,i)=>fetch(base+(i%2?'/api/status':'/api/context?q=Evidence&budget=256'))));
  for(const r of results){assert.equal(r.status,200);await r.json();}
  for(let edit=0;edit<2;edit++){const content=`# Evidence\nVerified round ${round}, edit ${edit}.`;const r=await fetch(base+'/api/note',{method:'PUT',headers,body:JSON.stringify({path:'Evidence.md',content,expectedRevision:current.revision})});assert.equal(r.status,200);current=await r.json();assert.equal(current.content,content);assert.equal((await vault.read('Evidence.md')).revision,current.revision);}
 }
 assert.equal((await fetch(base+'/api/status')).status,200);assert.equal((await vault.history('Evidence.md')).length,40);
});
