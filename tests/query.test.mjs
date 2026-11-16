import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNote } from '../src/markdown.mjs';
import { queryVault, parseQuery, metadataOf, tasksOf, queryBase } from '../src/query.mjs';
const fakeVault = files => ({ refresh: async()=>{}, entries: new Map(Object.entries(files).map(([id,content])=>[id,{...parseNote(id,content),modified:'2026-11-16T01:00:00.000Z'}])) });
const fixture=()=>fakeVault({
 'Projects/Active.md':'---\nstatus: active\npriority: 3\ntags: [project/work]\nthoughts:\n  rating: 8\n---\n# Active\nOwner:: Steven\n**Effort**:: 5\n\n- [ ] Ship query engine [due:: 2026-11-20] #work\n  - [x] Parse safely\n\n```md\n- [ ] Fake fenced task\nsecret:: not-indexed\n```\n\n    - [ ] Fake indented task\n\n`inlinefake:: ignore`\n',
 'Projects/Done.md':'---\nstatus: done\npriority: 1\ntags: [project]\n---\n# Done\nOwner:: Ana\n\n- [x] Done work\n',
 'Other.md':'# Other\nA [rating:: 9] field and [mood:: good].\n',
 'Archived/Old.md':'---\nstatus: active\npriority: 2\ntags: [archive]\n---\n# Old\n'
});
test('TABLE typed metadata, nested fields, normalized inline keys, source folders/tags and aliases',async()=>{
 const r=await queryVault(fixture(),'TABLE status, effort AS "Effort", thoughts.rating FROM "Projects" AND #project WHERE priority >= 2 AND contains(file.tags, "#project/work") SORT priority DESC LIMIT 10');
 assert.equal(r.type,'TABLE');assert.equal(r.total,1);assert.deepEqual(r.rows[0].values,['Projects/Active.md','active',5,8]);assert.equal(r.columns[2].label,'Effort');assert.equal(r.rows[0].revision.length,64);
});
test('LIST WITHOUT ID, boolean source composition and strict folder boundaries',async()=>{
 const r=await queryVault(fixture(),'LIST WITHOUT ID file.name FROM (#project OR "Other.md") AND -"Projects/Done" SORT file.name');assert.deepEqual(r.rows.map(r=>r.values),[['Active'],['Other']]);
 const v=fakeVault({'Foo/A.md':'# A','Foobar/B.md':'# B'});assert.deepEqual((await queryVault(v,'LIST FROM "Foo"')).rows.map(r=>r.path),['Foo/A.md']);
});
test('WHERE/SORT/LIMIT execute in written order, missing values stay null and sort last',async()=>{
 const v=fixture();const limited=await queryVault(v,'TABLE priority LIMIT 2 SORT priority ASC');assert.deepEqual(limited.rows.map(r=>r.values[1]),[1,3]);
 const all=await queryVault(v,'TABLE priority SORT priority DESC');assert.deepEqual(all.rows.map(r=>r.values[1]),[3,2,1,null]);
 assert.equal((await queryVault(v,'LIST WHERE missing = null')).total,4);assert.equal((await queryVault(v,'LIST WHERE missing > 1')).total,0);assert.equal((await queryVault(v,'LIST WHERE priority = "3"')).total,0);
});
test('TASK uses exact source lines and task-local fields; fenced and indented code excluded',async()=>{
 const v=fixture(),note=v.entries.get('Projects/Active.md'),tasks=tasksOf(note);assert.equal(tasks.length,2);for(const t of tasks)assert.ok(note.content.split('\n')[t.line-1].includes(t.text));
 const r=await queryVault(v,'TASK FROM #project WHERE !completed AND due <= date("2026-11-20")');assert.equal(r.total,1);assert.equal(r.rows[0].task.due,'2026-11-20');assert.equal(r.rows[0].task.completed,false);
 assert.equal(metadataOf(note).secret,undefined);assert.equal(metadataOf(note).inlinefake,undefined);
});
test('duplicate inline values aggregate once and task metadata does not leak to page fields',async()=>{
 const note=parseNote('A.md','# A\nScore:: 1\nScore:: 2\n\n- [ ] T [due:: 2026-11-20]\n');const row=metadataOf(note);assert.deepEqual(row.Score,[1,2]);assert.deepEqual(row.score,[1,2]);assert.equal(row.due,undefined);assert.equal(row.file.tasks[0].due,'2026-11-20');
});
test('strings containing syntax words are data, not interpreted commands',async()=>{
 const r=await queryVault(fixture(),'TABLE "FROM", "not", ")", "WHERE" AS "SORT" LIMIT 1');assert.deepEqual(r.rows[0].values.slice(1),['FROM','not',')','WHERE']);
});
test('no JS, prototype access, method invocation, network expressions, unknown clauses or malformed tokens',()=>{
 for(const q of ['TABLE constructor','TABLE file.__proto__.polluted','TABLE file.constructor.name','TABLE process.exit()','TABLE eval("1")','TABLE fetch("https://example.com")','TABLE file.name.toString()','TABLE x; process.exit()','LIST GROUP BY status','LIST FLATTEN file.tasks','CALENDAR due','dataviewjs dv.pages()','TABLE "unterminated','TABLE priority FROM #project FROM "Other"','LIST SORT missing WHER status','TASK status','LIST a, b','LIST LIMIT -1','TABLE "\\u0022"'])assert.throws(()=>parseQuery(q),{status:400},q);
 assert.equal({}.polluted,undefined);
});
test('query complexity, pagination and response bytes are bounded',async()=>{
 assert.throws(()=>parseQuery('LIST WHERE '+ '('.repeat(40)+'true'+')'.repeat(40)),{status:413});assert.throws(()=>parseQuery('LIST '+ 'x'.repeat(9000)),{status:400});
 const files=Object.fromEntries(Array.from({length:220},(_,i)=>[`N${i}.md`,'---\nvalue: "'+ 'x'.repeat(6000)+'"\n---\n# Note']));const v=fakeVault(files),r=await queryVault(v,'TABLE value',{limit:500});assert.ok(r.truncated);assert.ok(r.nextOffset>0);assert.ok(Buffer.byteLength(JSON.stringify(r.rows))<260*1024);assert.ok(r.warnings.length);
 const next=await queryVault(v,'TABLE value',{limit:20,offset:r.nextOffset});assert.notEqual(next.rows[0].path,r.rows[0].path);
 await assert.rejects(queryVault(v,'LIST',{limit:501}),{status:400});
});
test('metadata cache invalidates on new revisions and removes deleted sources',async()=>{
 const v=fixture();assert.equal((await queryVault(v,'LIST WHERE status="active"')).total,2);v.entries.set('Projects/Active.md',parseNote('Projects/Active.md','---\nstatus: done\n---\n# Changed'));v.entries.delete('Archived/Old.md');assert.equal((await queryVault(v,'LIST WHERE status="active"')).total,0);
});
test('safe computed columns support small arithmetic and deterministic date literals only',async()=>{
 const r=await queryVault(fixture(),'TABLE priority * 2 AS Doubled, default(missing, "fallback"), choice(status = "done", "yes", "no") FROM "Projects/Done.md"');assert.deepEqual(r.rows[0].values.slice(1),[2,'fallback','yes']);
 await assert.rejects(queryVault(fixture(),'LIST WHERE date("2026-02-31")'),{status:400});assert.equal((await queryVault(fixture(),'TABLE 1 / 0 LIMIT 1')).rows[0].values[1],null);
});
test('Bases restricted table view combines global/local filters and property display names',async()=>{
 const yaml='filters:\n  and:\n    - file.hasTag("project")\nproperties:\n  note.status:\n    displayName: Status\nviews:\n  - type: table\n    name: Active\n    filters: \'note.status == "active" && file.inFolder("Projects")\'\n    order: [file.name, note.status]\n    limit: 10\n';const r=await queryBase(fixture(),yaml,'Active');assert.equal(r.total,1);assert.deepEqual(r.rows[0].values,['Active','active']);assert.equal(r.columns[1].label,'Status');assert.equal(r.compatibility,'mastermind-bases-subset-v1');
});
test('Bases rejects formula execution, extra view behavior, cyclic/oversized filters and unknown views',async()=>{
 for(const yaml of ['formulas: {bad: "process.exit()"}\nviews: [{type: table}]','views: [{type: kanban}]','views: [{type: table, groupBy: status}]','views: [{type: table}]\nfilters: &a {and: [*a]}','views: [{type: table}]\nfilters: file.constructor("evil")'])await assert.rejects(queryBase(fixture(),yaml));
 await assert.rejects(queryBase(fixture(),'views: [{type: table, name: Test}]','Missing'),{status:400});
});
