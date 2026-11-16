import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseEnv} from 'node:util';
export const appRoot=fileURLToPath(new URL('../',import.meta.url));
export const within=(parent,child)=>{const r=path.relative(parent,child);return !r||(!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r));};
export async function canonical(candidate){let p=path.resolve(candidate),tail=[];for(;;){try{return path.join(await fs.realpath(p),...tail);}catch(e){if(e.code!=='ENOENT')throw e;const next=path.dirname(p);if(next===p)throw e;tail.unshift(path.basename(p));p=next;}}}
export async function loadConfig(configPath=path.join(appRoot,'infra/local.env'),environment=process.env){
 const file=path.resolve(configPath);let values={};try{values=parseEnv(await fs.readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;throw new Error('Konfigurasi belum ada. Jalankan infra init.');}
 const v={...values,...Object.fromEntries(Object.entries(environment).filter(([k])=>k.startsWith('MASTERMIND_')))};
 const resolve=async(value,fallback)=>canonical(path.resolve(appRoot,value||fallback));
 const config={file,port:Number(v.MASTERMIND_PORT||6969),profile:v.MASTERMIND_PROFILE||'minimal',readOnly:v.MASTERMIND_READ_ONLY==='true',token:v.MASTERMIND_MCP_TOKEN||undefined};
 if(!Number.isInteger(config.port)||config.port<1024||config.port>65535)throw new Error('MASTERMIND_PORT harus 1024–65535.');
 if(!['minimal','research','full'].includes(config.profile))throw new Error('Profile tidak valid.');
 if(v.MASTERMIND_READ_ONLY&&!['true','false'].includes(v.MASTERMIND_READ_ONLY))throw new Error('READ_ONLY harus true atau false.');
 if(config.token&&(config.token.length<16||config.token.length>4096))throw new Error('Token MCP harus 16–4096 karakter.');
 try{config.exclude=JSON.parse(v.MASTERMIND_EXCLUDE_JSON||'[]');}catch{throw new Error('EXCLUDE_JSON tidak valid.');}
 if(!Array.isArray(config.exclude)||config.exclude.length>100||config.exclude.some(x=>typeof x!=='string'||x.length>1000))throw new Error('EXCLUDE_JSON harus array pola.');
 config.vault=await resolve(v.MASTERMIND_VAULT,'vault');config.state=await resolve(v.MASTERMIND_STATE_DIR,path.join(config.vault,'.mastermind'));
 config.runtime=await resolve(v.MASTERMIND_RUNTIME_DIR,'.local/run');config.logs=await resolve(v.MASTERMIND_LOG_DIR,'.local/logs');config.backups=await resolve(v.MASTERMIND_BACKUP_DIR,'.local/backups');
 if(config.state!==path.join(config.vault,'.mastermind')&&(within(config.vault,config.state)||within(config.state,config.vault)))throw new Error('State harus vault/.mastermind atau direktori terpisah.');
 if(config.readOnly&&within(config.vault,config.state))throw new Error('Read-only membutuhkan STATE_DIR eksternal.');
 const operational=[config.runtime,config.logs,config.backups];
 for(let i=0;i<operational.length;i++){
  for(const source of [config.vault,config.state])if(within(source,operational[i])||within(operational[i],source))throw new Error('Runtime/log/backup harus terpisah dari vault dan state.');
  for(let j=0;j<i;j++)if(within(operational[i],operational[j])||within(operational[j],operational[i]))throw new Error('Runtime/log/backup tidak boleh saling bersarang.');
 }
 if(operational.some(p=>within(p,file))||within(config.vault,file)||within(config.state,file))throw new Error('File konfigurasi harus di luar direktori data.');
 config.lock=path.join(config.runtime,'service.lock');config.record=path.join(config.lock,'owner.json');
 return config;
}
export async function initConfig(file=path.join(appRoot,'infra/local.env')){
 await fs.mkdir(path.dirname(path.resolve(file)),{recursive:true});
 try{await fs.writeFile(file,await fs.readFile(path.join(appRoot,'infra/local.env.example')),{flag:'wx',mode:0o600});return {created:true,file:path.resolve(file)};}catch(e){if(e.code!=='EEXIST')throw e;return {created:false,file:path.resolve(file)};}
}
export function publicConfig(c){return {vault:c.vault,state:c.state,port:c.port,profile:c.profile,readOnly:c.readOnly,runtime:c.runtime,logs:c.logs,backups:c.backups,mcpAuthentication:c.token?'bearer':'loopback-only'};}
