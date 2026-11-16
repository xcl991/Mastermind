import fs from 'node:fs/promises';
import path from 'node:path';
const directories=['src','public','docs','examples','skills','tests','.github'];
const scripts=['benchmark.mjs','build-editor.mjs','check.mjs','infra-backup.mjs','infra-config.mjs','infra-fs.mjs','infra-service.mjs','infra.mjs','package.mjs','python-ast.py','release-files.mjs'];
const files=['README.md','THIRD_PARTY_NOTICES.md','package.json','package-lock.json','.gitignore','.gitattributes','infra/local.env.example','infra/vps.env.example','infra/mastermind.service.example','checks/browser.mjs','checks/features-browser.mjs','checks/security-browser.mjs',...scripts.map(n=>'scripts/'+n)];
export async function releaseFiles(root){
 const result=[];
 async function walk(relative){
  const stat=await fs.lstat(path.join(root,relative));if(stat.isSymbolicLink())throw new Error('Release cannot contain symlinks: '+relative);
  if(stat.isDirectory()){for(const name of (await fs.readdir(path.join(root,relative))).sort())await walk(path.posix.join(relative,name));}
  else if(stat.isFile()){
   if(/(^|\/)\.env(?:\.|$)|\.local\.|\.(?:pem|key|p12|pfx)$/i.test(relative))throw new Error('Private file in release tree: '+relative);
   result.push(relative);
  }else throw new Error('Unsupported release file: '+relative);
 }
 for(const relative of [...directories,...files])await walk(relative);
 return [...new Set(result)].sort();
}
