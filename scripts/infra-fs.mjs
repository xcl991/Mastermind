import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
export async function regular(file,{missing=false,directory=false}={}){try{const s=await fs.lstat(file);if(s.isSymbolicLink()||!(directory?s.isDirectory():s.isFile()))throw new Error('Unsafe infrastructure path: '+file);return s;}catch(e){if(missing&&e.code==='ENOENT')return null;throw e;}}
export async function privateFile(file,flags=constants.O_WRONLY|constants.O_APPEND|constants.O_CREAT){await regular(file,{missing:true});return fs.open(file,flags|(constants.O_NOFOLLOW||0),0o600);}
export async function syncDirectory(dir){let h;try{h=await fs.open(dir,'r');await h.sync();}catch(e){if(!['EINVAL','ENOTSUP','EISDIR','EPERM','EBADF','EACCES'].includes(e.code))throw e;}finally{await h?.close();}}
export async function writeExclusive(file,data){const h=await privateFile(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL);try{await h.writeFile(data);await h.sync();}finally{await h.close();}await syncDirectory(path.dirname(file));}
export async function withMaintenance(c,fn){
 await fs.mkdir(c.runtime,{recursive:true,mode:0o700});await regular(c.runtime,{directory:true});const gate=path.join(c.runtime,'maintenance.lock');
 try{await fs.mkdir(gate,{mode:0o700});}catch(e){if(e.code==='EEXIST')throw new Error('Maintenance/startup sedang berlangsung atau lock perlu inspeksi: '+gate);throw e;}
 try{await writeExclusive(path.join(gate,'owner.json'),JSON.stringify({pid:process.pid,hostname:os.hostname(),token:randomUUID(),createdAt:new Date().toISOString()}));return await fn();}finally{await fs.rm(gate,{recursive:true});await syncDirectory(c.runtime);}
}
