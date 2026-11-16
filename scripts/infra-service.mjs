import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {regular,privateFile,writeExclusive,withMaintenance} from './infra-fs.mjs';
import {loadConfig,publicConfig} from './infra-config.mjs';
import {Vault} from '../src/vault.mjs';
import {Graph} from '../src/graph.mjs';
import {Context} from '../src/context.mjs';
import {createServer} from '../src/server.mjs';
const equal=(a,b)=>typeof a==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export async function readRecord(c){try{await regular(c.lock,{directory:true});const s=await fs.lstat(c.record);if(!s.isFile()||s.isSymbolicLink()||s.size>16384)throw new Error('Record layanan tidak valid.');const r=JSON.parse(await fs.readFile(c.record,'utf8'));if(typeof r.token!=='string'||!/^[a-f0-9]{64}$/.test(r.token)||!Number.isInteger(r.controlPort)||r.controlPort<1||r.controlPort>65535||!Number.isInteger(r.pid)||r.pid<1)throw new Error('Record layanan tidak valid.');return r;}catch(e){if(e.code==='ENOENT')return null;throw e;}}
export async function control(c,action='status'){
 if(!['status','stop'].includes(action))throw new Error('Invalid control action.');
 const record=await readRecord(c);if(!record)return null;
 const request=async operation=>{
  const r=await fetch(`http://127.0.0.1:${record.controlPort}/${operation}`,{method:operation==='stop'?'POST':'GET',redirect:'error',headers:{Authorization:`Bearer ${record.token}`},signal:AbortSignal.timeout(3000)});
  if(!r.ok){await r.body?.cancel();throw new Error(`Control HTTP ${r.status}`);}
  let size=0;const chunks=[];for await(const chunk of r.body){size+=chunk.length;if(size>16384)throw new Error('Control reply exceeds limit.');chunks.push(chunk);}
  const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(result.pid!==record.pid||result.instance!==record.token.slice(0,12))throw new Error('Identitas proses berbeda.');return result;
 };
 try{const status=await request('status');return action==='stop'?await request('stop'):status;}catch(e){throw new Error(`Layanan tidak dapat diverifikasi: ${e.message}`);}
}
export async function assertStopped(c){
 try{await fs.lstat(c.lock);throw new Error('Service lock masih ada. Hentikan layanan atau periksa infra status/unlock terlebih dahulu.');}catch(e){if(e.code!=='ENOENT')throw e;}
 // Also detect a manually launched server on the configured app port.
 try{const r=await fetch(`http://127.0.0.1:${c.port}/api/status`,{signal:AbortSignal.timeout(1500)});await r.body?.cancel();throw new Error('Port aplikasi masih aktif; hentikan semua server sebelum operasi offline.');}catch(e){if(e.cause?.code!=='ECONNREFUSED')throw e;}
}
async function listen(server,port){server.listen(port,'127.0.0.1');await once(server,'listening');}
async function close(server){if(!server?.listening)return;await new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();});}
export async function runService(file){const c=await loadConfig(file);const service=await withMaintenance(c,()=>runUnlocked(c));process.send?.({ready:true,pid:process.pid});console.log(`Mastermind managed → http://127.0.0.1:${c.port}`);return service;}
async function runUnlocked(c){
 await fs.mkdir(c.runtime,{recursive:true,mode:0o700});await fs.mkdir(c.logs,{recursive:true,mode:0o700});await regular(c.logs,{directory:true});
 await fs.mkdir(c.lock,{mode:0o700}).catch(e=>{if(e.code==='EEXIST')throw new Error('Service lock sudah ada. Gunakan infra status; jangan mulai instance kedua.');throw e;});
 let server,admin,closing=false;const token=randomBytes(32).toString('hex'),startedAt=new Date().toISOString();
 const info=()=>({pid:process.pid,instance:token.slice(0,12),startedAt,uptimeSeconds:Math.floor(process.uptime()),memoryMiB:Math.round(process.memoryUsage().rss/1048576),...publicConfig(c)});
 const log=async(event,detail={})=>{const name=path.join(c.logs,'service.log');try{if((await regular(name)).size>5*1048576){await fs.rename(name+'.1',name+'.2').catch(e=>{if(e.code!=='ENOENT')throw e;});await fs.rename(name,name+'.1');}}catch(e){if(e.code!=='ENOENT')throw e;}const h=await privateFile(name);try{await h.writeFile(JSON.stringify({time:new Date().toISOString(),event,...detail})+'\n');}finally{await h.close();}};
 const stop=async(code=0)=>{if(closing)return;closing=true;const deadline=setTimeout(()=>process.exit(1),15000);deadline.unref();try{await close(server);await close(admin);await log('stopped',{code});await fs.rm(c.lock,{recursive:true});process.exitCode=code;}finally{clearTimeout(deadline);}};
 try{
  const vault=await new Vault(c.vault,{stateDir:c.state,readOnly:c.readOnly,exclude:c.exclude}).init(),graph=new Graph(vault);server=createServer(vault,graph,new Context(vault,graph),{profile:c.profile,mcpToken:c.token});
  await listen(server,c.port);
  admin=http.createServer((req,res)=>{
   if(req.headers.host!==`127.0.0.1:${admin.address().port}`||req.headers.origin||!equal(req.headers.authorization,`Bearer ${token}`)){res.writeHead(403);res.end();return;}
   const status=req.url==='/status'&&req.method==='GET',shutdown=req.url==='/stop'&&req.method==='POST';
   if(!status&&!shutdown){res.writeHead(404);res.end();return;}
   res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({...info(),stopping:shutdown}));if(shutdown)setImmediate(()=>stop().catch(e=>{console.error(e.message);process.exit(1);}));
  });admin.requestTimeout=5000;admin.headersTimeout=5000;await listen(admin,0);
  await writeExclusive(c.record,JSON.stringify({pid:process.pid,token,controlPort:admin.address().port,startedAt,configFile:c.file}));
  await log('started',{pid:process.pid,port:c.port,profile:c.profile});
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>stop().catch(e=>{console.error(e.message);process.exit(1);}));
  for(const service of [server,admin])service.on('error',e=>{console.error(e.message);stop(1).catch(()=>process.exit(1));});
  return {server,admin,stop};
 }catch(e){await close(server);await close(admin);await fs.rm(c.lock,{recursive:true});throw e;}
}
