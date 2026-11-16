import path from 'node:path';
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {fail} from './vault.mjs';
import {resolveLink} from './graph.mjs';
import {splitTarget,sectionOf} from './markdown.mjs';
export const assetTypes={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.avif':'image/avif','.pdf':'application/pdf','.mp3':'audio/mpeg','.wav':'audio/wav','.ogg':'audio/ogg','.m4a':'audio/mp4','.mp4':'video/mp4','.webm':'video/webm'};
export async function embedSource(vault,from,target){
 await vault.refresh();vault.validate(from);if(typeof target!=='string'||target.length>1000)throw fail('Invalid embed target.');
 const ref=splitTarget(target),ext=path.posix.extname(ref.target).toLowerCase();
 if(assetTypes[ext]){const relative=path.posix.normalize(path.posix.join(path.posix.dirname(from),ref.target));for(const id of [...new Set(ref.target.startsWith('.') ? [relative] : [ref.target,relative])]){try{const file=await vault.safe(id),s=await fs.stat(file);if(!s.isFile()||s.size>128*1024*1024)throw fail('Attachment limit 128 MiB.');return {kind:'asset',path:id,mime:assetTypes[ext],url:'/api/asset?path='+encodeURIComponent(id)+(ext==='.pdf'&&/^page=\d+$/.test(ref.fragment)?'#'+ref.fragment:'')};}catch(e){if(e.code!=='ENOENT')throw e;}}throw fail('Attachment not found.',404);}
 const id=resolveLink(ref.target,from,vault.entries);if(!id)throw fail('Embed source missing or ambiguous.',404);
 const note=await vault.read(id);if(id.endsWith('.base'))return {kind:'base',path:id,selector:ref.fragment,revision:note.revision,content:note.content};
 if(note.type!=='note')throw fail('Use source navigation for code/documents.');const section=sectionOf(note,ref.fragment);return {kind:'note',...section,content:section.content.slice(0,24000),truncated:section.content.length>24000};
}
export async function serveAsset(vault,id,req,res){
 const mime=assetTypes[path.extname(id||'').toLowerCase()];if(!mime)throw fail('Unsupported attachment.');
 const file=await vault.safe(id),s=await fs.stat(file);if(!s.isFile()||s.size>128*1024*1024)throw fail('Attachment limit 128 MiB.');
 let start=0,end=s.size-1,status=200;const range=req.headers.range;
 if(range){res.setHeader('Content-Range',`bytes */${s.size}`);const match=/^bytes=(\d*)-(\d*)$/.exec(range);if(!match||(!match[1]&&!match[2])||match.slice(1).some(v=>v&&!Number.isSafeInteger(Number(v))))throw fail('Invalid byte range.',416);if(!match[1]){const last=Number(match[2]);start=Math.max(0,s.size-last);}else{start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>end||start>=s.size)throw fail('Unsatisfiable byte range.',416);status=206;res.setHeader('Content-Range',`bytes ${start}-${end}/${s.size}`);}
 res.setHeader('Accept-Ranges','bytes');res.setHeader('Content-Type',mime);res.setHeader('Content-Length',Math.max(0,end-start+1));res.setHeader('Cache-Control','private, no-cache');res.statusCode=status;
 if(req.method==='HEAD'||s.size===0){res.end();return;}
 await new Promise((resolve,reject)=>{const stream=createReadStream(file,{start,end});stream.on('error',reject);res.once('close',()=>{stream.destroy();resolve();});stream.on('end',resolve);stream.pipe(res);});
}
