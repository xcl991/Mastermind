import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {regular,privateFile,writeExclusive,syncDirectory,withMaintenance} from './infra-fs.mjs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {canonical,within} from './infra-config.mjs';
import {assertStopped} from './infra-service.mjs';
const MAX_FILES=100000,MAX_BYTES=20*1024**3;
async function hash(file,maximum=MAX_BYTES){const source=await privateFile(file,constants.O_RDONLY),h=createHash('sha256');let bytes=0;try{if(!(await source.stat()).isFile())throw new Error('Not a regular backup file.');for await(const chunk of source.createReadStream({autoClose:false})){bytes+=chunk.length;if(bytes>maximum)throw new Error('File grew beyond snapshot limit.');h.update(chunk);}return h.digest('hex');}finally{await source.close();}}
const fail=message=>{throw new Error(message);};
const portable=name=>name&&!/[\\\x00-\x1f<>:\"|?*]/.test(name)&&!/[ .]$/.test(name)&&name!=='.'&&name!=='..'&&!/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
async function inventory(root,{skip=[]}={}){
 const files=[];let bytes=0;
 async function walk(dir,relative=''){
  const st=await fs.lstat(dir);if(st.isSymbolicLink()||!st.isDirectory())fail('Snapshot root/directory must not be a symlink.');
  for(const name of (await fs.readdir(dir)).sort()){
   const full=path.join(dir,name),id=relative?relative+'/'+name:name;
   if(skip.some(x=>full===x||within(x,full)))continue;
   if(!portable(name))fail('Unsupported filename in snapshot.');
   const before=await fs.lstat(full);if(before.isSymbolicLink())fail(`Symlink ditolak: ${id}`);
   if(before.isDirectory())await walk(full,id);
   else if(before.isFile()){
    bytes+=before.size;if(files.length>=MAX_FILES||bytes>MAX_BYTES)fail('Backup maximum 100,000 files / 20 GiB.');
    const sha256=await hash(full,before.size),after=await fs.lstat(full);
    if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ino!==after.ino)fail(`Sumber berubah: ${id}`);
    files.push({path:id,bytes:before.size,sha256});
   }else fail(`Special file ditolak: ${id}`);
  }
 }
 await walk(root);return files;
}
function same(a,b){return JSON.stringify(a)===JSON.stringify(b);}
async function copyFiles(source,destination,files){
 for(const f of files){
  const parts=f.path.split('/');let parent=source;await regular(parent,{directory:true});for(const part of parts.slice(0,-1)){parent=path.join(parent,part);await regular(parent,{directory:true});}
  const target=path.join(destination,...parts);await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});
  const input=await privateFile(path.join(source,...parts),constants.O_RDONLY);let output;
  try{
   const before=await input.stat();if(!before.isFile()||before.size!==f.bytes)fail('Source changed before copy: '+f.path);
   output=await privateFile(target,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL);let bytes=0;const digest=createHash('sha256');
   for await(const chunk of input.createReadStream({autoClose:false})){bytes+=chunk.length;if(bytes>f.bytes)fail('Source grew during copy: '+f.path);digest.update(chunk);await output.writeFile(chunk);}
   if(bytes!==f.bytes||digest.digest('hex')!==f.sha256)fail('Checksum copy tidak cocok: '+f.path);
   await output.sync();
  }finally{await output?.close();await input.close();}
  if(await hash(target,f.bytes)!==f.sha256)fail('Destination checksum mismatch: '+f.path);
  let dir=path.dirname(target);for(;;){await syncDirectory(dir);if(dir===destination)break;dir=path.dirname(dir);}
 }
}
async function noWriters(c){await assertStopped(c);try{if((await fs.readdir(path.join(c.state,'locks'))).length)fail('State masih memiliki write locks; periksa doctor dan hentikan penulis lain.');}catch(e){if(e.code!=='ENOENT')throw e;}}
export async function createSnapshot(c){return withMaintenance(c,()=>createSnapshotUnlocked(c));}
async function createSnapshotUnlocked(c){
 await noWriters(c);await fs.mkdir(c.backups,{recursive:true,mode:0o700});
 const stateInside=within(c.vault,c.state),sources=[{name:'vault',root:c.vault,skip:[path.join(c.state,'locks')]}];
 if(!stateInside){try{await fs.access(c.state);sources.push({name:'state',root:c.state,skip:[path.join(c.state,'locks')]});}catch(e){if(e.code!=='ENOENT')throw e;}}
 const id=new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8),staging=path.join(c.backups,'.partial-'+id),destination=path.join(c.backups,id);
 await fs.mkdir(staging,{mode:0o700});
 try{
  const manifest={schemaVersion:1,createdAt:new Date().toISOString(),stateLayout:stateInside?'inside-vault':'external',consistency:'Offline writers required; source hashes checked twice. Not an atomic filesystem snapshot.',files:[],bytes:0};
  for(const source of sources){source.files=await inventory(source.root,{skip:source.skip});await fs.mkdir(path.join(staging,'payload',source.name),{recursive:true,mode:0o700});await copyFiles(source.root,path.join(staging,'payload',source.name),source.files);for(const f of source.files){manifest.files.push({...f,path:source.name+'/'+f.path});manifest.bytes+=f.bytes;}}
  if(manifest.files.length>MAX_FILES||manifest.bytes>MAX_BYTES)fail('Combined backup limit exceeded.');
  for(const source of sources)if(!same(source.files,await inventory(source.root,{skip:source.skip})))fail('Sumber berubah selama backup. Hentikan semua penulis dan ulangi.');
  await noWriters(c);await writeExclusive(path.join(staging,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  await verifySnapshot(staging);await fs.rename(staging,destination);await syncDirectory(c.backups);return {snapshot:destination,files:manifest.files.length,bytes:manifest.bytes};
 }catch(e){await fs.rm(staging,{recursive:true,force:true});throw e;}
}
export async function verifySnapshot(snapshot){
 const root=path.resolve(snapshot),st=await fs.lstat(root);if(!st.isDirectory()||st.isSymbolicLink())fail('Invalid snapshot directory.');
 const file=path.join(root,'manifest.json'),mstat=await fs.lstat(file);if(!mstat.isFile()||mstat.isSymbolicLink()||mstat.size>32*1048576)fail('Invalid backup manifest.');
 const m=JSON.parse(await fs.readFile(file,'utf8'));
 if(!m||typeof m!=='object'||m.schemaVersion!==1||!['inside-vault','external'].includes(m.stateLayout)||!Array.isArray(m.files)||m.files.length>MAX_FILES)fail('Invalid manifest schema.');
 const paths=new Set(),components=new Map();let bytes=0;
 for(const f of m.files){
  if(!f||typeof f.path!=='string'||!/^(vault|state)\//.test(f.path)||f.path.includes('\\')||/[\x00-\x1f]/.test(f.path)||f.path.split('/').some(p=>!portable(p))||!Number.isSafeInteger(f.bytes)||f.bytes<0||typeof f.sha256!=='string'||!/^[a-f0-9]{64}$/.test(f.sha256))fail('Invalid snapshot entry.');
  const parts=f.path.split('/');for(let i=1;i<=parts.length;i++){const prefix=parts.slice(0,i).join('/'),folded=prefix.normalize('NFC').toLowerCase();if(components.has(folded)&&components.get(folded)!==prefix)fail('Case-colliding snapshot directories.');components.set(folded,prefix);}
  if(f.path.startsWith('state/locks/')||f.path.startsWith('vault/.mastermind/locks/'))fail('Live write locks cannot be restored.');
  const key=f.path.normalize('NFC').toLowerCase();if(paths.has(key))fail('Duplicate/case-colliding snapshot path.');paths.add(key);bytes+=f.bytes;
  if(m.stateLayout==='inside-vault'&&f.path.startsWith('state/'))fail('Unexpected external state.');
 }
 if(bytes!==m.bytes||bytes>MAX_BYTES)fail('Invalid snapshot byte count.');
 const actual=await inventory(path.join(root,'payload'));const ordered=a=>a.map(f=>({path:f.path,bytes:f.bytes,sha256:f.sha256})).sort((a,b)=>a.path.localeCompare(b.path));
 if(!same(ordered(actual),ordered(m.files)))fail('Snapshot checksum/content mismatch.');
 return {verified:true,snapshot:root,files:m.files.length,bytes,manifest:m};
}
export async function restoreSnapshot(c,snapshot,target){return withMaintenance(c,()=>restoreSnapshotUnlocked(c,snapshot,target));}
async function restoreSnapshotUnlocked(c,snapshot,target){
 await noWriters(c);const verified=await verifySnapshot(snapshot),destination=await canonical(target),source=await canonical(snapshot);
 for(const protectedPath of [c.vault,c.state,c.runtime,c.logs,c.backups,source])if(within(protectedPath,destination)||within(destination,protectedPath))fail('Restore target harus terpisah dari data aktif, backup, dan runtime.');
 // Only a new directory is accepted; never merge into existing user data.
 await fs.mkdir(destination,{mode:0o700});
 try{
  await copyFiles(path.join(source,'payload'),destination,verified.manifest.files);
  const restored=await inventory(destination),expected=verified.manifest.files;
  const ordered=a=>a.map(f=>({path:f.path,bytes:f.bytes,sha256:f.sha256})).sort((a,b)=>a.path.localeCompare(b.path));
  if(!same(ordered(restored),ordered(expected)))fail('Restore verification failed.');
  await fs.mkdir(path.join(destination,'vault'),{recursive:true,mode:0o700});
  if(verified.manifest.stateLayout==='external')await fs.mkdir(path.join(destination,'state'),{recursive:true,mode:0o700});
  return {restored:true,target:destination,vault:path.join(destination,'vault'),state:verified.manifest.stateLayout==='external'?path.join(destination,'state'):path.join(destination,'vault','.mastermind'),files:verified.files,bytes:verified.bytes};
 }catch(e){throw new Error(`Restore belum lengkap; data dipertahankan untuk inspeksi di ${destination}: ${e.message}`);}
}
