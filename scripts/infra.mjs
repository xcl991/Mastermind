import fs from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
import {regular,privateFile,withMaintenance} from './infra-fs.mjs';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {appRoot,initConfig,loadConfig,publicConfig} from './infra-config.mjs';
import {control,readRecord,runService} from './infra-service.mjs';
import {createSnapshot,verifySnapshot,restoreSnapshot} from './infra-backup.mjs';
const print=value=>console.log(JSON.stringify(value,null,2));
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
async function start(c){
 const old=await readRecord(c);if(old){const running=await control(c);if(['vault','state','port','profile','readOnly'].some(key=>running[key]!==c[key]))throw new Error('Konfigurasi berubah; gunakan infra restart untuk menerapkan.');return {...running,alreadyRunning:true};}
 await fs.mkdir(c.runtime,{recursive:true,mode:0o700});await fs.mkdir(c.logs,{recursive:true,mode:0o700});
 const logfile=path.join(c.logs,'startup.log');try{if((await regular(logfile)).size>1048576)await fs.rename(logfile,logfile+'.1');}catch(e){if(e.code!=='ENOENT')throw e;}
 const log=await privateFile(logfile);
 try{
  const child=spawn(process.execPath,[path.join(appRoot,'src/cli.mjs'),'infra','run','--config',c.file],{cwd:appRoot,detached:true,stdio:['ignore',log.fd,log.fd,'ipc']});
  await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error('Startup timeout; lihat infra logs.'));},30000);
   const done=(error)=>{clearTimeout(timer);child.removeListener('error',onError);child.removeListener('exit',onExit);child.removeListener('message',onMessage);if(error)reject(error);else resolve();};
   const onError=e=>done(e),onExit=code=>done(new Error(`Startup gagal (${code}); lihat ${logfile}.`)),onMessage=m=>{if(m.ready)done();};
   child.once('error',onError);child.once('exit',onExit);child.on('message',onMessage);
  });
  child.disconnect();child.unref();return await control(c);
 }finally{await log.close();}
}
async function stop(c){const result=await control(c,'stop');if(!result)return {running:false};for(let i=0;i<150;i++){try{await fs.lstat(c.lock);}catch(e){if(e.code==='ENOENT')return {stopped:true,pid:result.pid};throw e;}await delay(100);}throw new Error('Shutdown belum selesai; jangan hapus lock saat proses masih hidup.');}
export async function infraMain(args){
 const command=args[0]||'help',option=name=>{const i=args.indexOf(name);if(i<0)return undefined;const v=args[i+1];if(!v||v.startsWith('--'))throw new Error(`Nilai ${name} diperlukan.`);return v;};
 const file=option('--config')||path.join(appRoot,'infra/local.env');
 if(command==='help'||args.includes('--help')){console.log('Mastermind local infrastructure\n  infra init | start | stop | restart | status | health | logs | run | unlock\n  infra backup\n  infra verify --snapshot PATH\n  infra restore --snapshot PATH --target NEW_DIRECTORY\nAll commands accept --config FILE. Backup/restore require all writers stopped.\nrun stays foreground for service managers; start runs in background.');return;}
 if(command==='init'){print(await initConfig(file));return;}
 const c=await loadConfig(file);
 if(command==='run'){await runService(file);return;}
 if(command==='start'){print(await start(c));return;}
 if(command==='stop'){print(await stop(c));return;}
 if(command==='restart'){await stop(c);print(await start(c));return;}
 if(command==='status'||command==='health'){
  const result=await control(c);
  if(!result){let locked=false;try{await fs.lstat(c.lock);locked=true;}catch(e){if(e.code!=='ENOENT')throw e;}print({running:false,locked,...publicConfig(c)});if(command==='health'||locked)process.exitCode=1;return;}
  const response=await fetch(`http://127.0.0.1:${result.port}/api/status`,{signal:AbortSignal.timeout(3000)}),status=await response.json();if(!response.ok||status.name!=='Mastermind'||status.vault!==result.vault)throw new Error('App health/identity check failed.');print({running:true,healthy:true,...result,version:status.version});return;
 }
 if(command==='logs'){for(const name of ['service.log','startup.log']){try{const handle=await privateFile(path.join(c.logs,name),constants.O_RDONLY);try{const size=(await handle.stat()).size,buffer=Buffer.alloc(Math.min(size,32768));await handle.read(buffer,0,buffer.length,Math.max(0,size-buffer.length));console.log(`${name}\n${buffer.toString()}`);}finally{await handle.close();}}catch(e){if(e.code!=='ENOENT')throw e;}}return;}
 if(command==='unlock'){return withMaintenance(c,async()=>{
  const record=await readRecord(c);if(!record)throw new Error('Tidak ada record valid. Lock tanpa owner perlu inspeksi manual.');
  if(alive(record.pid))throw new Error('PID masih hidup; lock tidak dihapus.');
  try{const response=await fetch(`http://127.0.0.1:${record.controlPort}/status`,{signal:AbortSignal.timeout(1500)});await response.body?.cancel();throw new Error('Control port masih aktif.');}catch(e){if(e.cause?.code!=='ECONNREFUSED')throw e;}
  const current=await readRecord(c);if(current?.token!==record.token)throw new Error('Owner berubah.');await fs.rm(c.lock,{recursive:true});print({unlocked:true});});
 }
 if(command==='backup'){print(await createSnapshot(c));return;}
 if(command==='verify'){const snapshot=option('--snapshot');if(!snapshot)throw new Error('--snapshot diperlukan.');const {manifest,...result}=await verifySnapshot(snapshot);print(result);return;}
 if(command==='restore'){const snapshot=option('--snapshot'),target=option('--target');if(!snapshot||!target)throw new Error('--snapshot dan --target diperlukan.');print(await restoreSnapshot(c,snapshot,target));return;}
 throw new Error(`Perintah infra tidak dikenal: ${command}`);
}
