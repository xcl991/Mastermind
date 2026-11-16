import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {loadConfig,initConfig,appRoot} from '../scripts/infra-config.mjs';
import {createSnapshot,verifySnapshot,restoreSnapshot} from '../scripts/infra-backup.mjs';
import {readRecord,control} from '../scripts/infra-service.mjs';
async function freePort(){const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function fixture(t,{external=false}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'mastermind-infra-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const port=await freePort(),file=path.join(root,'local.env');
 const values={MASTERMIND_VAULT:path.join(root,'vault'),MASTERMIND_STATE_DIR:external?path.join(root,'state'):'',MASTERMIND_RUNTIME_DIR:path.join(root,'run'),MASTERMIND_LOG_DIR:path.join(root,'logs'),MASTERMIND_BACKUP_DIR:path.join(root,'backups'),MASTERMIND_PORT:port,MASTERMIND_PROFILE:'research'};
 await fs.writeFile(file,Object.entries(values).map(([k,v])=>`${k}=${JSON.stringify(String(v))}`).join('\n'));await fs.mkdir(values.MASTERMIND_VAULT);await fs.writeFile(path.join(values.MASTERMIND_VAULT,'Note.md'),'# Evidence\nFact 7342.\n');return {root,file,values,c:await loadConfig(file,{})};
}
async function cli(args,file){const child=spawn(process.execPath,[path.join(appRoot,'src/cli.mjs'),'infra',...args,'--config',file],{env:Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('MASTERMIND_')))});let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);const [code]=await once(child,'close');return {code,stdout,stderr};}
test('infra configuration preserves an existing file and rejects overlapping data/backup paths',async t=>{
 const {file,c,values}=await fixture(t);const before=await fs.readFile(file,'utf8');assert.equal((await initConfig(file)).created,false);assert.equal(await fs.readFile(file,'utf8'),before);assert.equal(c.state,path.join(c.vault,'.mastermind'));
 await assert.rejects(loadConfig(file,{MASTERMIND_BACKUP_DIR:path.join(values.MASTERMIND_VAULT,'backup')}),/terpisah/);
 await assert.rejects(loadConfig(file,{MASTERMIND_READ_ONLY:'true'}),/eksternal/);
 await assert.rejects(loadConfig(file,{MASTERMIND_PROFILE:'arbitrary'}),/Profile/);
 assert.equal((await loadConfig(file,{MASTERMIND_PORT:'7777'})).port,7777);
});
test('complete offline snapshot restores Markdown, binary attachments, workspace settings and state without overwriting',async t=>{
 const {root,c}=await fixture(t);await fs.mkdir(path.join(c.vault,'.editor'));await fs.writeFile(path.join(c.vault,'.editor','settings.json'),'{}');await fs.writeFile(path.join(c.vault,'photo.png'),Buffer.from([0,255,4,0,8]));await fs.mkdir(path.join(c.state,'history'),{recursive:true});await fs.writeFile(path.join(c.state,'history','old.md'),'old source');
 const backup=await createSnapshot(c);assert.equal(backup.files,4);assert.equal((await verifySnapshot(backup.snapshot)).verified,true);const target=path.join(root,'restored'),result=await restoreSnapshot(c,backup.snapshot,target);assert.equal(await fs.readFile(path.join(result.state,'history','old.md'),'utf8'),'old source');assert.deepEqual(await fs.readFile(path.join(result.vault,'photo.png')),Buffer.from([0,255,4,0,8]));
 await assert.rejects(restoreSnapshot(c,backup.snapshot,target),{code:'EEXIST'});await assert.rejects(restoreSnapshot(c,backup.snapshot,c.vault),/terpisah/);
 await fs.writeFile(path.join(backup.snapshot,'payload','vault','Note.md'),'corrupt');await assert.rejects(verifySnapshot(backup.snapshot),/mismatch/);assert.equal(await fs.readFile(path.join(c.vault,'Note.md'),'utf8'),'# Evidence\nFact 7342.\n');
});
test('snapshots reject symlinks, live writer locks, traversal manifests and preserve external state',async t=>{
 const {root,c}=await fixture(t,{external:true});await fs.mkdir(c.state);await fs.writeFile(path.join(c.state,'extensions.json'),'[]');const b=await createSnapshot(c);const r=await restoreSnapshot(c,b.snapshot,path.join(root,'restored'));assert.equal(await fs.readFile(path.join(r.state,'extensions.json'),'utf8'),'[]');
 await fs.mkdir(path.join(c.state,'locks'));await fs.writeFile(path.join(c.state,'locks','writer'),'active');await assert.rejects(createSnapshot(c),/write locks/);await fs.rm(path.join(c.state,'locks'),{recursive:true});
 if(process.platform!=='win32'){await fs.symlink(path.join(c.vault,'Note.md'),path.join(c.vault,'shortcut'));await assert.rejects(createSnapshot(c),/Symlink/);await fs.unlink(path.join(c.vault,'shortcut'));}
 const mf=path.join(b.snapshot,'manifest.json'),m=JSON.parse(await fs.readFile(mf));m.files[0].path='vault/../../outside';await fs.writeFile(mf,JSON.stringify(m));await assert.rejects(verifySnapshot(b.snapshot),/Invalid snapshot entry/);
});
test('managed child lifecycle uses authenticated control, health checks, duplicate start and clean shutdown',async t=>{
 const {file,c}=await fixture(t);t.after(async()=>{try{await control(c,'stop');}catch{}for(let i=0;i<30;i++){try{await fs.stat(c.lock);}catch{break;}await delay(100);}});
 const first=await cli(['start'],file);assert.equal(first.code,0,first.stderr);const info=JSON.parse(first.stdout);assert.equal(info.port,c.port);assert.equal('token' in info,false);
 const record=await readRecord(c);const denied=await fetch(`http://127.0.0.1:${record.controlPort}/stop`,{method:'POST'});assert.equal(denied.status,403);
 const second=await cli(['start'],file);assert.equal(second.code,0,second.stderr);assert.equal(JSON.parse(second.stdout).pid,info.pid);assert.equal(JSON.parse(second.stdout).alreadyRunning,true);
 assert.equal((await cli(['health'],file)).code,0);await assert.rejects(createSnapshot(c),/Service lock/);assert.equal((await cli(['unlock'],file)).code,1);
 const stop=await cli(['stop'],file);assert.equal(stop.code,0,stop.stderr);assert.equal((await cli(['health'],file)).code,1);assert.equal((await cli(['stop'],file)).code,0);
 const b=await cli(['backup'],file);assert.equal(b.code,0,b.stderr);assert.equal((await verifySnapshot(JSON.parse(b.stdout).snapshot)).verified,true);
});
test('occupied application port aborts startup and never stops the unrelated process',async t=>{
 const {file,c}=await fixture(t);const other=net.createServer(s=>s.end());other.listen(c.port,'127.0.0.1');await once(other,'listening');t.after(()=>new Promise(r=>other.close(r)));
 const result=await cli(['start'],file);assert.equal(result.code,1);assert.equal(other.listening,true);assert.equal(await readRecord(c),null);await assert.rejects(fs.stat(c.lock),{code:'ENOENT'});
});

test('stop validates process identity before sending a destructive control request',async t=>{
 const {file,c}=await fixture(t);t.after(async()=>{try{await cli(['stop'],file);}catch{}});const started=await cli(['start'],file);assert.equal(started.code,0,started.stderr);const original=await fs.readFile(c.record,'utf8'),r=JSON.parse(original);await fs.writeFile(c.record,JSON.stringify({...r,pid:r.pid+1000000}));
 const result=await cli(['stop'],file);assert.equal(result.code,1);assert.match(result.stderr,/Identitas proses/);await fs.writeFile(c.record,original);assert.equal((await cli(['health'],file)).code,0);assert.equal((await cli(['stop'],file)).code,0);
});
test('maintenance gate excludes service startup, backup and restore; failed operations release it',async t=>{
 const {file,c,root}=await fixture(t);await fs.mkdir(c.runtime,{recursive:true});const gate=path.join(c.runtime,'maintenance.lock');await fs.mkdir(gate);assert.equal((await cli(['start'],file)).code,1);await assert.rejects(createSnapshot(c),/Maintenance/);await assert.rejects(restoreSnapshot(c,'missing',path.join(root,'new')),/Maintenance/);await fs.rmdir(gate);
 await assert.rejects(restoreSnapshot(c,'missing',path.join(root,'new')));await assert.rejects(fs.stat(gate),{code:'ENOENT'});const b=await createSnapshot(c);assert.equal((await verifySnapshot(b.snapshot)).verified,true);
});
test('infrastructure log symlinks are refused without changing their targets',async t=>{
 if(process.platform==='win32'){t.skip('Symlink creation needs Windows privilege');return;}
 const {file,c,root}=await fixture(t);await fs.mkdir(c.logs);const protectedFile=path.join(root,'private.txt');await fs.writeFile(protectedFile,'keep me');await fs.symlink(protectedFile,path.join(c.logs,'startup.log'));const result=await cli(['start'],file);assert.equal(result.code,1);assert.match(result.stderr,/Unsafe infrastructure path/);assert.equal(await fs.readFile(protectedFile,'utf8'),'keep me');
});
test('snapshot verification rejects platform-specific paths, case-colliding directories and write locks',async t=>{
 const {c}=await fixture(t);const b=await createSnapshot(c),file=path.join(b.snapshot,'manifest.json'),original=JSON.parse(await fs.readFile(file));
 for(const bad of ['vault/evil:stream','vault/CON.txt','vault/folder./x','vault/.mastermind/locks/owner']){const copy=structuredClone(original);copy.files[0].path=bad;await fs.writeFile(file,JSON.stringify(copy));await assert.rejects(verifySnapshot(b.snapshot),/Invalid snapshot entry|write locks/);}
 const collision=structuredClone(original);collision.files=[{...original.files[0],path:'vault/Folder/a.md'},{...original.files[0],path:'vault/folder/b.md'}];collision.bytes*=2;await fs.writeFile(file,JSON.stringify(collision));await assert.rejects(verifySnapshot(b.snapshot),/Case-colliding/);
});

test('hard-killed managed child leaves a recoverable lock; unlock and restart preserve vault data',async t=>{
 const {file,c}=await fixture(t);t.after(async()=>{try{await cli(['stop'],file);}catch{}});const before=await fs.readFile(path.join(c.vault,'Note.md'));
 const start=await cli(['start'],file);assert.equal(start.code,0,start.stderr);const info=JSON.parse(start.stdout);await fs.access(c.record);
 process.kill(info.pid,'SIGKILL');let dead=false;for(let i=0;i<50;i++){try{process.kill(info.pid,0);}catch(e){if(e.code==='ESRCH'){dead=true;break;}throw e;}await delay(50);}assert.equal(dead,true);
 assert.equal((await cli(['status'],file)).code,1);assert.equal((await cli(['start'],file)).code,1);const unlock=await cli(['unlock'],file);assert.equal(unlock.code,0,unlock.stderr);assert.equal((await cli(['start'],file)).code,0);assert.equal((await cli(['health'],file)).code,0);assert.deepEqual(await fs.readFile(path.join(c.vault,'Note.md')),before);assert.equal((await cli(['stop'],file)).code,0);
});
