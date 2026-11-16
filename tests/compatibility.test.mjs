import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseNote, sectionOf } from '../src/markdown.mjs';
import { Vault } from '../src/vault.mjs';
import { Graph } from '../src/graph.mjs';
import { Context, estimateTokens } from '../src/context.mjs';
import { createProtocol } from '../src/mcp.mjs';
async function fixture(t, files) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mastermind-compat-')); t.after(() => fs.rm(root, { recursive: true, force: true })); for (const [id, value] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(root, id)), { recursive: true }); await fs.writeFile(path.join(root, id), value); } const vault = await new Vault(root).init(); return { root, vault, graph: new Graph(vault) }; }
test('Markdown token parsing excludes code/comments and retains reference links, heading/block locations', () => {
 const text = '---\naliases: [Example]\n---\n```md\n# Fake\n[[Fake]]\n```\n\n    [[Indented]]\n\n# Real\n\n[Destination][ref]\n\n[ref]: <Folder/Real note.md#Details>\n\n%% [[Hidden]] %%\n\n`[[Inline]]` and [[Target#^block|Label]]\n\nParagraph value. ^proof\n\n## Details\nFact42\n';
 const note = parseNote('Note.md', text); assert.equal(note.title, 'Real'); assert.deepEqual(note.links.map(l => l.target), ['Folder/Real note.md', 'Target']); assert.equal(note.links[0].fragment, 'Details'); assert.equal(note.links[1].block, 'block'); assert.equal(sectionOf(note,'^proof').content, 'Paragraph value. ^proof'); assert.match(sectionOf(note,'Details').content,/Fact42/); for (const link of note.links) assert.equal(text.slice(link.start, link.end), link.raw);
});
test('AST links resolve local imports and calls while respecting parameter shadowing and unique same-line symbols', async t => {
 const { graph } = await fixture(t, { 'lib.ts': 'export function compute(x:number) { return x * 2; }', 'main.ts': "import {compute as calc} from './lib.js';\nexport function run(){return calc(2)}\nfunction shadow(calc:any){return calc(3)}\nconst a=()=>1,b=()=>2;\n// fakeFunction()\n" });
 const g=await graph.build(), byLabel = label => g.nodes.find(n => n.type === 'symbol' && n.label === label); assert.ok(byLabel('compute')); assert.ok(g.links.some(e => e.source === byLabel('run').id && e.target === byLabel('compute').id && e.relation === 'calls')); assert.ok(!g.links.some(e => e.source === byLabel('shadow').id && e.relation === 'calls')); assert.equal(new Set(g.nodes.map(n=>n.id)).size,g.nodes.length); assert.ok(!byLabel('fakeFunction'));
});
test('minimal MCP hides mutation tools and returns budgeted section/map/context', async t => {
 const { vault,graph } = await fixture(t, {'A.md':'# One\n\nUseful fact 123.\n\n## Two\nOther detail.\n'}); const context = new Context(vault, graph), p = createProtocol(vault,graph,context,{profile:'minimal'}); const call=(method,params={})=>p({jsonrpc:'2.0',id:1,method,params}); await call('initialize',{protocolVersion:'2025-11-25'});
 assert.deepEqual((await call('tools/list')).result.tools.map(t=>t.name).sort(),['get_context','get_section','project_map']);
 for (const [name,args] of [['get_context',{query:'Useful fact',budget:256}],['get_section',{path:'A.md',selector:'Two',budget:256}],['project_map',{budget:256}]]) {const r=await call('tools/call',{name,arguments:args}); assert.ok(!r.result.isError,JSON.stringify(r)); assert.ok(estimateTokens(r.result.content[0].text)<=256);}
 assert.equal((await call('tools/call',{name:'write_note',arguments:{path:'A.md',content:'bad',expectedRevision:null}})).error.code,-32602);
});
test('source-linked findings are reusable only while source revisions remain current', async t => {
 const {vault,graph} = await fixture(t, {'Source.md':'# Rule\nUse seeded RNG.\n'}); const {saveFinding} = await import('../src/findings.mjs'), source=await vault.read('Source.md');
 await saveFinding(vault,{path:'Findings.md',title:'Rendering knowledge',summary:'Remember deterministic_rendering_rule.',expectedRevision:null,evidence:[{path:'Source.md',revision:source.revision,startLine:2,endLine:2}]});
 const context = new Context(vault,graph); assert.ok((await context.get('deterministic_rendering_rule')).sources.includes('Findings.md'));
 await vault.write('Source.md','# Changed\nDifferent rule.\n',source.revision); assert.ok(!(await context.get('deterministic_rendering_rule')).sources.includes('Findings.md')); assert.deepEqual(context.staleFindings,['Findings.md']);
 await assert.rejects(saveFinding(vault,{path:'Other.md',title:'Old',summary:'Old',expectedRevision:null,evidence:[{path:'Source.md',revision:source.revision,startLine:2,endLine:2}]}),{status:409});
});
test('Canvas import preserves card metadata, source mapping and connections', async t=>{
 const {graph} = await fixture(t,{'A.md':'# A\nValue'}); await graph.importCanvas({nodes:[{id:'a',type:'file',file:'A.md',x:0,y:0,width:200,height:100},{id:'b',type:'text',text:'Idea',x:300,y:0,width:200,height:100}],edges:[{id:'edge',fromNode:'a',toNode:'b',label:'related'}]}); const g=await graph.build();assert.equal(g.nodes.find(n=>n.original_id==='a').local_source,'A.md');assert.ok(g.links.some(e=>e.source==='external:a'&&e.target==='external:b'));assert.equal((await graph.imported()).nodes[1].canvas.text,'Idea');
});
test('optional Python AST resolves imports without executing source or treating class scope as function closure', async t => {
 const {graph}=await fixture(t,{'lib.py':'def compute(x):\n    return x * 2\n','main.py':'from lib import compute\ndef run():\n    return compute(2)\nclass C:\n    def target(self):\n        return 1\n    def caller(self):\n        return target()\nraise RuntimeError("must never execute")\n'});const g=await graph.build();
 if (!g.nodes.some(n=>n.parser==='python-ast')) {t.skip('Python runtime unavailable; coverage is reported unavailable.');return;}
 const symbol=name=>g.nodes.find(n=>n.type==='symbol'&&n.label===name);assert.ok(g.links.some(e=>e.source===symbol('run').id&&e.target===symbol('compute').id&&e.relation==='calls'));assert.ok(!g.links.some(e=>e.source===symbol('caller').id&&e.relation==='calls'));
});
