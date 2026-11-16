import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { zipSync, strToU8 } from 'fflate';
import { Vault, digest } from '../src/vault.mjs';
import { previewRename, applyRename, listWorkflows, recoverWorkflow, updateTask, updateProperties, createFromTemplate, previewRestore, applyRestore } from '../src/workflows.mjs';
async function fixture(t, files = {}) {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mastermind-workflows-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 for (const [id,content] of Object.entries(files)){await fs.mkdir(path.dirname(path.join(dir,id)),{recursive:true});await fs.writeFile(path.join(dir,id),content);}
 return await new Vault(dir).init();
}
async function plan(vault,source='Old.md',target='Moved/New.md'){const note=await vault.read(source);const args={path:source,targetPath:target,expectedRevision:note.revision};return {...args,planHash:(await previewRename(vault,args)).planHash};}
test('rename preview is read-only; move updates backlinks, reference links, fragments and outgoing relative assets', async t=>{
 const vault=await fixture(t,{'Old.md':'# Old\n[[Other#Heading|Same]]\n[Other](Other.md)\n![Image](image.png)\n','Other.md':'# Other\n## Heading\n[[Old#^block|Alias]]\n[Named][old]\n\n[old]: Old.md#Heading\n\n`[[Old]]`\n','image.png':'not-real-image'});
 const args=await plan(vault),preview=await previewRename(vault,args);assert.equal(preview.dryRun,true);assert.equal(preview.blocked.length,0);assert.equal(preview.changes.length,2);await assert.rejects(fs.stat(path.join(vault.root,'.mastermind')),{code:'ENOENT'});
 const result=await applyRename(vault,args);assert.ok(result.workflowId);await assert.rejects(vault.read('Old.md'),{status:404});
 const moved=await vault.read('Moved/New.md');assert.match(moved.content,/\[Other\]\(<\.\.\/Other.md>\)/);assert.match(moved.content,/\[Image\]\(<\.\.\/image.png>\)/);
 const linked=await vault.read('Other.md');assert.match(linked.content,/\[\[Moved\/New#\^block\|Alias\]\]/);assert.match(linked.content,/\[Named\]\(<Moved\/New.md#Heading>\)/);assert.match(linked.content,/`\[\[Old\]\]`/);assert.match(linked.content,/\[old\]: Old.md/);assert.equal((await listWorkflows(vault))[0].phase,'committed');
});
test('rename refuses existing targets, case aliases, changed preview and unsupported relative links',async t=>{
 const vault=await fixture(t,{'Old.md':'# Old\n','Existing.md':'keep','Back.md':'[[Old]]'}),args=await plan(vault);
 await assert.rejects(previewRename(vault,{...args,targetPath:'Existing.md'}),{status:409});await assert.rejects(previewRename(vault,{...args,targetPath:'old.md'}),{status:409});
 const back=await vault.read('Back.md');await vault.write('Back.md','changed [[Old]]',back.revision);await assert.rejects(applyRename(vault,args),{status:409});assert.equal((await vault.read('Old.md')).content,'# Old\n');
 const old=await vault.read('Old.md');await vault.write('Old.md','[Missing](../unknown.md)',old.revision);const next=await plan(vault),preview=await previewRename(vault,next);assert.equal(preview.blocked.length,1);await assert.rejects(applyRename(vault,next),{status:409});
});
test('interrupted rename has a durable journal and rollback never overwrites external edits',async t=>{
 const vault=await fixture(t,{'Old.md':'# Old\n','A.md':'[[Old]]','B.md':'[[Old]]'}),args=await plan(vault),write=vault.write.bind(vault);let injected=false;
 vault.write=async(id,...rest)=>{if(id==='B.md'&&!injected){injected=true;await fs.writeFile(path.join(vault.root,'B.md'),'external');throw new Error('injected interruption');}return write(id,...rest);};
 await assert.rejects(applyRename(vault,args),/injected interruption/);const [journal]=await listWorkflows(vault);assert.equal(journal.phase,'interrupted');assert.equal((await vault.read('Old.md')).content,'# Old\n');assert.match((await vault.read('A.md')).content,/Moved\/New/);
 vault.write=write;const recovery=await recoverWorkflow(vault,{workflowId:journal.workflowId});assert.equal(recovery.phase,'rollback-conflict');assert.equal((await vault.read('A.md')).content,'[[Old]]');assert.equal((await vault.read('B.md')).content,'external');assert.ok(await vault.read('Moved/New.md'));
});
test('rollback restores a committed move and retains destination bytes in trash; second rollback is idempotent',async t=>{
 const vault=await fixture(t,{'Old.md':'original','A.md':'[[Old]]'}),result=await applyRename(vault,await plan(vault));const r=await recoverWorkflow(vault,{workflowId:result.workflowId});assert.equal(r.phase,'rolled-back');assert.equal((await vault.read('Old.md')).content,'original');assert.equal((await vault.read('A.md')).content,'[[Old]]');await assert.rejects(vault.read('Moved/New.md'),{status:404});assert.equal((await recoverWorkflow(vault,{workflowId:result.workflowId})).phase,'rolled-back');assert.equal((await vault.listTrash()).length,2);
});
test('task updates preserve CRLF and reject fenced, indented, frontmatter and comment checkboxes',async t=>{
 const text='---\nexample: |\n  - [ ] yaml\n---\n- [ ] active\n  - [x] nested\n\n```md\n- [ ] fake\n```\n\n    - [ ] indented\n\n%%\n- [ ] hidden\n%%\n\n> - [ ] quoted\n'.replaceAll('\n','\r\n');const vault=await fixture(t,{'Tasks.md':text});let note=await vault.read('Tasks.md');
 for(const line of [3,9,12,15])await assert.rejects(updateTask(vault,{path:note.id,line,completed:true,expectedRevision:note.revision}));
 await updateTask(vault,{path:note.id,line:5,completed:true,expectedRevision:note.revision});note=await vault.read(note.id);assert.equal(note.content,text.replace('- [ ] active','- [x] active'));await updateTask(vault,{path:note.id,line:6,completed:false,expectedRevision:note.revision});note=await vault.read(note.id);assert.match(note.content,/- \[ \] nested/);await updateTask(vault,{path:note.id,line:18,completed:true,expectedRevision:note.revision});
 await assert.rejects(updateTask(vault,{path:note.id,line:5,completed:false,expectedRevision:'stale'}),{status:409});
});
test('property edits preserve body bytes and YAML comments; malformed YAML and prototype keys are rejected',async t=>{
 const body='# Body\r\n\r\nUntouched  spaces.\r\n',vault=await fixture(t,{'A.md':'\uFEFF---\r\n# retain comment\r\ntags: [old]\r\nkeep: yes\r\n---\r\n'+body});let note=await vault.read('A.md');await updateProperties(vault,{path:'A.md',properties:{tags:['new'],priority:3},remove:['keep'],expectedRevision:note.revision});note=await vault.read('A.md');assert.ok(note.content.startsWith('\uFEFF---'));assert.ok(note.content.endsWith(body));assert.match(note.content,/# retain comment/);assert.deepEqual(note.properties.tags,['new']);assert.equal(note.properties.keep,undefined);
 await assert.rejects(updateProperties(vault,{path:'A.md',properties:JSON.parse('{"__proto__":{"x":1}}'),expectedRevision:note.revision}));
 const bad=await vault.write('Bad.md','---\nx: [\n---\nbody',null);await assert.rejects(updateProperties(vault,{path:'Bad.md',properties:{x:1},expectedRevision:bad.revision}));assert.equal((await vault.read('Bad.md')).content,bad.content);
});
test('templates render a bounded explicit vocabulary and never overwrite existing notes or execute expressions',async t=>{
 const vault=await fixture(t,{'Templates/Daily.md':'# {{title}}\n{{date}}\n{{path}}\n'});const result=await createFromTemplate(vault,{path:'Daily/2026-11-16.md',templatePath:'Templates/Daily.md',title:'Plan',date:'2026-11-16'});assert.equal((await vault.read(result.path)).content,'# Plan\n2026-11-16\nDaily/2026-11-16.md\n');await assert.rejects(createFromTemplate(vault,{path:result.path,templatePath:'Templates/Daily.md'}),{status:409});
 await vault.write('Templates/Bad.md','{{process.exit()}}',null);await assert.rejects(createFromTemplate(vault,{path:'Unsafe.md',templatePath:'Templates/Bad.md'}),/Placeholder/);await assert.rejects(createFromTemplate(vault,{path:'Wrong.md',templatePath:'Templates/Daily.md',date:'2026-02-30'}));
});
test('all workflow mutations enforce read-only mode',async t=>{
 const writable=await fixture(t,{'Old.md':'- [ ] task','Template.md':'# {{title}}'}),vault=await new Vault(writable.root,{readOnly:true}).init(),note=await vault.read('Old.md'),args={path:'Old.md',expectedRevision:note.revision};
 for(const action of [()=>applyRename(vault,{...args,targetPath:'New.md',planHash:'x'}),()=>recoverWorkflow(vault,{workflowId:'x'}),()=>updateTask(vault,{...args,line:1,completed:true}),()=>updateProperties(vault,{...args,properties:{x:1}}),()=>createFromTemplate(vault,{path:'N.md',templatePath:'Template.md'})])await assert.rejects(action(),{status:403});assert.equal((await vault.read('Old.md')).content,note.content);
});

test('ZIP restore previews paths, validates manifest, creates only absent notes and supports rollback', async t => {
 const vault=await fixture(t), content='# Archive\n', archiveBase64=Buffer.from(zipSync({'Folder/Note.md':strToU8(content),'mastermind-backup-manifest.json':strToU8(JSON.stringify({files:[{path:'Folder/Note.md',revision:digest(content)}]}))})).toString('base64');
 const preview=await previewRestore(vault,{archiveBase64});assert.equal(preview.blocked,false);assert.equal(preview.files[0].path,'Folder/Note.md');await assert.rejects(vault.read('Folder/Note.md'),{status:404});
 const result=await applyRestore(vault,{archiveBase64,planHash:preview.planHash});assert.equal(result.phase,'committed');assert.equal((await vault.read('Folder/Note.md')).content,content);assert.equal((await previewRestore(vault,{archiveBase64})).blocked,true);await assert.rejects(applyRestore(vault,{archiveBase64,planHash:preview.planHash}),{status:409});
 await recoverWorkflow(vault,{workflowId:result.workflowId});await assert.rejects(vault.read('Folder/Note.md'),{status:404});assert.equal((await vault.listTrash()).length,1);
});
test('ZIP restore rejects traversal, duplicate case names, symlinks, declared expansion, checksum errors and non-notes',async t=>{
 const vault=await fixture(t);const encoded=files=>Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k,v])=>[k,strToU8(v)])))).toString('base64');
 for(const files of [{'../escape.md':'bad'},{'A.md':'a','a.md':'b'},{'code.js':'bad'},{'.editor/config.md':'bad'}])await assert.rejects(previewRestore(vault,{archiveBase64:encoded(files)}));
 const archive=Buffer.from(encoded({'A.md':'content'}),'base64'),central=archive.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
 const symlink=Buffer.from(archive);symlink.writeUInt32LE((0xa1ff << 16)>>>0,central+38);await assert.rejects(previewRestore(vault,{archiveBase64:symlink.toString('base64')}),/Symlink/);
 const expanded=Buffer.from(archive);expanded.writeUInt32LE(100*1024*1024,central+24);await assert.rejects(previewRestore(vault,{archiveBase64:expanded.toString('base64')}),{status:413});
 const checksum=Buffer.from(archive);checksum.writeUInt32LE(0,central+16);await assert.rejects(previewRestore(vault,{archiveBase64:checksum.toString('base64')}),/CRC/);
 await assert.rejects(previewRestore(vault,{archiveBase64:encoded({'A.md':'a','mastermind-backup-manifest.json':JSON.stringify({files:[{path:'A.md',revision:'wrong'}]})})}),/Checksum/);
});
test('inline templates support explicit time; invalid dates and template source ambiguity fail safely',async t=>{
 const vault=await fixture(t);const note=await createFromTemplate(vault,{path:'Inline.md',template:'# {{title}}\n{{date}} {{time}}',title:'Day',date:'2026-11-16',time:'09:30'});assert.equal(note.content,'# Day\n2026-11-16 09:30');
 await assert.rejects(createFromTemplate(vault,{path:'Invalid.md',template:'{{date}}',date:'2026-99-99'}),{status:400});await assert.rejects(createFromTemplate(vault,{path:'Both.md',template:'x',templatePath:'Inline.md'}));
});

test('rename retains Markdown inline and reference link titles', async t=>{
 const vault=await fixture(t,{'Old.md':'source','A.md':'[Inline](Old.md "Inline title")\n[Reference][r]\n\n[r]: Old.md "Reference title"\n'});await applyRename(vault,await plan(vault));const content=(await vault.read('A.md')).content;assert.match(content,/\[Inline\]\(<Moved\/New.md> "Inline title"\)/);assert.match(content,/\[Reference\]\(<Moved\/New.md> "Reference title"\)/);
});
test('rollback keeps a renamed destination when a new note links to it',async t=>{
 const vault=await fixture(t,{'Old.md':'source'}),result=await applyRename(vault,await plan(vault));await vault.write('New backlink.md','[[Moved/New]]',null);const recovery=await recoverWorkflow(vault,{workflowId:result.workflowId});assert.equal(recovery.phase,'rollback-conflict');assert.equal((await vault.read('Old.md')).content,'source');assert.equal((await vault.read('Moved/New.md')).content,'source');assert.ok(recovery.conflicts.some(c=>c.path==='New backlink.md'));
});

test('restore rollback preserves a concurrently created file even when bytes equal the planned content',async t=>{
 const vault=await fixture(t), archiveBase64=Buffer.from(zipSync({'A.md':strToU8('a'),'B.md':strToU8('b')})).toString('base64'),preview=await previewRestore(vault,{archiveBase64}),write=vault.write.bind(vault);
 vault.write=async(id,...rest)=>{if(id==='B.md'){await fs.writeFile(path.join(vault.root,id),'b');throw new Error('concurrent create');}return write(id,...rest);};await assert.rejects(applyRestore(vault,{archiveBase64,planHash:preview.planHash}),/concurrent create/);vault.write=write;const [journal]=await listWorkflows(vault),recovery=await recoverWorkflow(vault,{workflowId:journal.workflowId});assert.equal(recovery.phase,'rollback-conflict');assert.equal((await vault.read('B.md')).content,'b');await assert.rejects(vault.read('A.md'),{status:404});
});
