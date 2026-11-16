import path from 'node:path';
import { Lexer } from 'marked';
import { parse as parseYaml } from 'yaml';
const error = (message, status = 400) => Object.assign(new Error(message), { status });
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const clauses = new Set(['FROM', 'WHERE', 'SORT', 'LIMIT', 'GROUP', 'FLATTEN']);
const operators = { OR: 1, '||': 1, AND: 2, '&&': 2, '=': 3, '==': 3, '!=': 3, '>': 3, '>=': 3, '<': 3, '<=': 3, '+': 4, '-': 4, '*': 5, '/': 5, '%': 5 };
const functionArity = { contains: [2, 2], length: [1, 1], lower: [1, 1], upper: [1, 1], default: [2, 2], startswith: [2, 2], endswith: [2, 2], date: [1, 1], choice: [3, 3], 'file.hastag': [1, 1], 'file.infolder': [1, 1] };
const MAX_QUERY = 8192, MAX_ROWS = 500, MAX_WORK = 1000000, MAX_RECORDS = 50000;
const caches = new WeakMap();
const keyOf = key => String(key).replace(/[*_~`]/g, '').trim().normalize('NFC').toLowerCase().replace(/\s+/g, '-');
const validatePath = value => { const parts = value.split('.'); if (parts.some(p => forbidden.has(p.toLowerCase()))) throw error('Prototype/property access is not supported.'); return parts; };
const truth = value => value !== null && value !== undefined && value !== false && value !== 0 && value !== '' && (!Array.isArray(value) || value.length > 0);

function tokenize(query) {
  if (typeof query !== 'string' || !query.trim() || query.length > MAX_QUERY) throw error(`Query must contain 1–${MAX_QUERY} characters.`);
  const tokens = []; let at = 0;
  while (at < query.length) {
    if (/\s/.test(query[at])) { at++; continue; }
    const start = at, char = query[at];
    if (char === '"' || char === "'") {
      at++; let value = '', closed = false;
      while (at < query.length) { const c = query[at++]; if (c === char) { closed = true; break; } if (c === '\\') { if (at >= query.length) break; const escape = query[at++]; if (!['n', 'r', 't', '\\', '"', "'"].includes(escape)) throw error(`Unsupported escape at ${at - 1}.`); value += ({ n: '\n', r: '\r', t: '\t' }[escape] || escape); } else value += c; }
      if (!closed) throw error('Unclosed string literal.'); tokens.push({ type: 'literal', value, start });
    } else if (/\d/.test(char)) {
      const m = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(query.slice(at)); at += m[0].length; const value = Number(m[0]); if (!Number.isFinite(value)) throw error('Number must be finite.'); tokens.push({ type: 'literal', value, start });
    } else if (char === '#') {
      const m = /^#[\p{L}\p{N}_/-]+/u.exec(query.slice(at)); if (!m) throw error('Invalid tag source.'); at += m[0].length; tokens.push({ type: 'tag', value: m[0], start });
    } else {
      const op = /^(?:!=|>=|<=|==|&&|\|\||[(),.!+*/%<>=-])/.exec(query.slice(at));
      if (op) { tokens.push({ type: 'operator', value: op[0], start }); at += op[0].length; }
      else { const m = /^[\p{L}_$][\p{L}\p{N}_$-]*/u.exec(query.slice(at)); if (!m) throw error(`Unsupported syntax at character ${at + 1}: ${query[at]}`); at += m[0].length; tokens.push({ type: 'identifier', value: m[0], start }); }
    }
    if (tokens.length > 1024) throw error('Query exceeds 1024 syntax tokens.', 413);
  }
  tokens.push({ type: 'end', value: '', start: at }); return tokens;
}
class Parser {
  constructor(text) { this.text = text; this.tokens = tokenize(text); this.at = 0; this.depth = 0; this.nodes = 0; }
  peek() { return this.tokens[this.at]; }
  is(value) { return ['identifier','operator'].includes(this.peek().type) && String(this.peek().value).toUpperCase() === value; }
  take(value) { if (this.is(value)) { return this.tokens[this.at++]; } return null; }
  expect(value) { const t = this.take(value); if (!t) throw error(`Expected ${value} at character ${this.peek().start + 1}.`); return t; }
  node(value) { if (++this.nodes > 512) throw error('Expression exceeds 512 nodes.', 413); return value; }
  expression(min = 0) {
    if (++this.depth > 32) throw error('Expression nesting exceeds 32 levels.', 413);
    let left; const token = this.peek();
    if (this.take('!') || this.take('NOT')) left = this.node({ type: 'unary', op: '!', value: this.expression(6) });
    else if (this.take('-')) left = this.node({ type: 'unary', op: '-', value: this.expression(6) });
    else if (this.take('(')) { left = this.expression(); this.expect(')'); }
    else if (token.type === 'literal') { this.at++; left = this.node({ type: 'literal', value: token.value }); }
    else if (token.type === 'identifier' && !clauses.has(token.value.toUpperCase()) && !['AS','ASC','DESC','ASCENDING','DESCENDING','WITHOUT','ID'].includes(token.value.toUpperCase())) {
      this.at++; let name = token.value;
      if (/^(true|false|null)$/i.test(name)) left = this.node({ type: 'literal', value: name.toLowerCase() === 'null' ? null : name.toLowerCase() === 'true' });
      else {
        while (this.take('.')) { const next = this.peek(); if (next.type !== 'identifier') throw error('Expected property name.'); this.at++; name += '.' + next.value; }
        validatePath(name);
        if (this.take('(')) { const fn = name.toLowerCase(), arity = functionArity[fn]; if (!arity) throw error(`Unsupported function: ${name}`); const args = []; if (!this.take(')')) { do { args.push(this.expression()); if (args.length > 8) throw error('Too many function arguments.'); } while (this.take(',')); this.expect(')'); } if (args.length < arity[0] || args.length > arity[1]) throw error(`Invalid argument count for ${name}.`); left = this.node({ type: 'call', name: fn, args }); }
        else left = this.node({ type: 'field', name, path: validatePath(name) });
      }
    } else throw error(`Expected expression at character ${token.start + 1}.`);
    while (true) { const op = String(this.peek().value).toUpperCase(), precedence = ['identifier','operator'].includes(this.peek().type) ? operators[op] : undefined; if (precedence === undefined || precedence < min) break; this.at++; const right = this.expression(precedence + 1); left = this.node({ type: 'binary', op, left, right }); }
    this.depth--; return left;
  }
  source(min = 0) {
    if (++this.depth > 32) throw error('Source nesting exceeds 32 levels.', 413);
    let left; const t = this.peek();
    if (this.take('-') || this.take('!') || this.take('NOT')) left = this.node({ type: 'source-not', value: this.source(3) });
    else if (this.take('(')) { left = this.source(); this.expect(')'); }
    else if (t.type === 'tag' || (t.type === 'literal' && typeof t.value === 'string')) { this.at++; if (t.type !== 'tag' && (t.value.includes('\\') || t.value.split('/').includes('..') || t.value.startsWith('/'))) throw error('Source folder must be vault-relative.'); left = this.node({ type: t.type === 'tag' ? 'source-tag' : 'source-folder', value: t.value.replace(/\/$/, '') }); }
    else throw error('FROM supports quoted folders/files, #tags, AND/OR and negation only.');
    while (true) { const op = String(this.peek().value).toUpperCase(), precedence = ['identifier','operator'].includes(this.peek().type) ? { OR: 1, '||': 1, AND: 2, '&&': 2 }[op] : undefined; if (!precedence || precedence < min) break; this.at++; left = this.node({ type: 'source-op', op, left, right: this.source(precedence + 1) }); }
    this.depth--; return left;
  }
}
export function parseQuery(text) {
  const p = new Parser(text), kind = p.peek().value.toString().toUpperCase(); if (p.peek().type !== 'identifier' || !['TABLE','LIST','TASK'].includes(kind)) throw error('Supported query types: TABLE, LIST, TASK. DataviewJS is not executed.'); p.at++;
  const columns = []; let withoutId = false;
  if (p.take('WITHOUT')) { p.expect('ID'); withoutId = true; if (kind === 'TASK') throw error('TASK WITHOUT ID is not supported.'); }
  if (p.peek().type !== 'end' && !(p.peek().type === 'identifier' && clauses.has(String(p.peek().value).toUpperCase()))) {
    if (kind === 'TASK') throw error('TASK does not accept projected columns.');
    do { const start = p.peek().start, expr = p.expression(); let label = text.slice(start, p.peek().start).trim(); if (p.take('AS')) { const t = p.peek(); if (!(t.type === 'identifier' || (t.type === 'literal' && typeof t.value === 'string'))) throw error('Column alias must be text.'); label = String(t.value); p.at++; } columns.push({ key: `column${columns.length}`, label, expr }); if (columns.length > 20) throw error('At most 20 columns are supported.'); } while (p.take(','));
    if (kind === 'LIST' && columns.length > 1) throw error('LIST supports one projected value.');
  }
  const steps = []; let source = null;
  while (p.peek().type !== 'end') {
    if(p.peek().type !== 'identifier')throw error('Expected query command.');
    const name = String(p.peek().value).toUpperCase(); p.at++;
    if (name === 'FROM') { if (source || steps.length) throw error('FROM must appear once before WHERE/SORT/LIMIT.'); source = p.source(); }
    else if (name === 'WHERE') steps.push({ type: 'where', expr: p.expression() });
    else if (name === 'SORT') { const fields = []; do { const expr = p.expression(); let direction = 1; if (p.take('DESC') || p.take('DESCENDING')) direction = -1; else p.take('ASC') || p.take('ASCENDING'); fields.push({ expr, direction }); if (fields.length > 8) throw error('At most 8 sort fields.'); } while (p.take(',')); steps.push({ type: 'sort', fields }); }
    else if (name === 'LIMIT') { const t = p.peek(); if (t.type !== 'literal' || !Number.isSafeInteger(t.value) || t.value < 0 || t.value > MAX_RECORDS) throw error('LIMIT must be an integer from 0 to 50000.'); p.at++; steps.push({ type: 'limit', value: t.value }); }
    else throw error(`Unsupported clause or syntax: ${name || '(end)'}`);
    if (steps.length > 24) throw error('At most 24 query commands.');
  }
  return { type: kind, withoutId, columns, source, steps, compatibility: 'mastermind-dql-subset-v1' };
}
function own(object, key) { return object !== null && typeof object === 'object' && !forbidden.has(key.toLowerCase()) && Object.hasOwn(object, key) ? object[key] : null; }
function field(row, parts) { let value = row; for (const part of parts) { value = own(value, part); if (value === null || value === undefined) return null; } return value; }
function equal(a, b) { if (a === null || b === null || a === undefined || b === undefined) return (a == null) && (b == null); if (typeof a !== typeof b) return false; if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v,i) => equal(v,b[i])); return typeof a === 'object' ? false : a === b; }
function order(a, b) { if (a == null || b == null) return a == null ? b == null ? 0 : 1 : -1; if (typeof a !== typeof b) return String(typeof a).localeCompare(typeof b); if (typeof a === 'number' || typeof a === 'boolean') return a < b ? -1 : a > b ? 1 : 0; if (typeof a === 'string') return a < b ? -1 : a > b ? 1 : 0; return 0; }
function evaluate(ast, row, work) {
  if (++work.steps > MAX_WORK) throw error('Query work budget exceeded; narrow FROM or simplify expressions.', 413);
  if (ast.type === 'literal') return ast.value;
  if (ast.type === 'field') return field(row, ast.path);
  if (ast.type === 'unary') { const value = evaluate(ast.value,row,work); return ast.op === '!' ? !truth(value) : typeof value === 'number' ? -value : null; }
  if (ast.type === 'binary') {
    const a = evaluate(ast.left,row,work);
    if (['AND','&&'].includes(ast.op)) return truth(a) && truth(evaluate(ast.right,row,work));
    if (['OR','||'].includes(ast.op)) return truth(a) || truth(evaluate(ast.right,row,work));
    const b = evaluate(ast.right,row,work);
    if (['=','=='].includes(ast.op)) return equal(a,b); if (ast.op === '!=') return !equal(a,b);
    if (['>','>=','<','<='].includes(ast.op)) { if (a == null || b == null || typeof a !== typeof b || !['string','number'].includes(typeof a)) return false; const c=order(a,b); return ast.op==='>'?c>0:ast.op==='>='?c>=0:ast.op==='<'?c<0:c<=0; }
    if (ast.op === '+' && typeof a === 'string' && typeof b === 'string') { if (a.length+b.length>16384) throw error('Computed string exceeds 16 KiB.',413); return a+b; }
    if (typeof a !== 'number' || typeof b !== 'number') return null; const value = ast.op==='+'?a+b:ast.op==='-'?a-b:ast.op==='*'?a*b:ast.op==='/'?a/b:a%b; return Number.isFinite(value)?value:null;
  }
  if (ast.type === 'call') {
    if (ast.name === 'choice') return evaluate(ast.args[truth(evaluate(ast.args[0],row,work))?1:2],row,work);
    if (ast.name === 'default') { const value=evaluate(ast.args[0],row,work); return value == null ? evaluate(ast.args[1],row,work) : value; }
    const [a,b] = ast.args.map(expr=>evaluate(expr,row,work));
    if (ast.name === 'contains') return Array.isArray(a)?a.some(v=>equal(v,b)):typeof a==='string'&&typeof b==='string'?a.includes(b):false;
    if (ast.name === 'length') return typeof a==='string'||Array.isArray(a)?a.length:0;
    if (ast.name === 'lower' || ast.name === 'upper') return typeof a==='string'?(ast.name==='lower'?a.toLowerCase():a.toUpperCase()):null;
    if (ast.name === 'startswith' || ast.name === 'endswith') return typeof a==='string'&&typeof b==='string'?(ast.name==='startswith'?a.startsWith(b):a.endsWith(b)):false;
    if (ast.name === 'date') { if (typeof a !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(a) || !Number.isFinite(Date.parse(a)) || new Date(a).toISOString().slice(0,10)!==a) throw error('date() supports a valid quoted ISO YYYY-MM-DD date only.'); return a; }
    if (ast.name === 'file.hastag') return typeof a==='string'&&row.file.tags.includes(a.startsWith('#')?a:'#'+a);
    if (ast.name === 'file.infolder') return typeof a==='string' && (a===''||row.file.folder===a||row.file.folder.startsWith(a+'/'));
  }
  throw error('Unsupported expression.');
}
function matchesSource(ast, row, work) {
  if (!ast) return true; if (++work.steps > MAX_WORK) throw error('Query work budget exceeded.',413);
  if (ast.type==='source-tag') return row.file.tags.includes(ast.value);
  if (ast.type==='source-folder') return ast.value==='' || row.file.path===ast.value || row.file.path===ast.value+'.md' || row.file.folder===ast.value || row.file.folder.startsWith(ast.value+'/');
  if (ast.type==='source-not') return !matchesSource(ast.value,row,work);
  return ['AND','&&'].includes(ast.op)?matchesSource(ast.left,row,work)&&matchesSource(ast.right,row,work):matchesSource(ast.left,row,work)||matchesSource(ast.right,row,work);
}
function safeValue(value, depth = 0, seen = new Set()) {
  if (value === null || ['string','number','boolean'].includes(typeof value)) return value;
  if (depth > 12 || !value || typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value); const out = Array.isArray(value) ? value.slice(0,10000).map(v=>safeValue(v,depth+1,seen)) : Object.create(null);
  if (!Array.isArray(value)) for (const [key,item] of Object.entries(value).slice(0,1000)) if (!forbidden.has(key.toLowerCase())) out[key]=safeValue(item,depth+1,seen);
  seen.delete(value); return out;
}
function scalar(value) { const s=value.trim(); if (/^(true|false|null)$/i.test(s)) return s.toLowerCase()==='null'?null:s.toLowerCase()==='true'; if (/^-?\d+(?:\.\d+)?$/.test(s)&&Number.isFinite(Number(s))) return Number(s); if ((s.startsWith('[')&&s.endsWith(']'))||(s.startsWith('"')&&s.endsWith('"'))) try {return safeValue(JSON.parse(s));}catch{} return s; }
function put(out, key, value) { key=key.replace(/[*_~`]/g,'').trim(); if (!key||forbidden.has(key.toLowerCase())) return; const normalized=keyOf(key); for(const k of new Set([key,normalized])) { if (forbidden.has(k)) continue; out[k]=Object.hasOwn(out,k)?[...(Array.isArray(out[k])?out[k]:[out[k]]),value]:value; } }
function inlineFields(text, fullLine=true) { const out=Object.create(null); const full=fullLine?/^\s*([^\[\]\n:]{1,100})::\s*(.+)$/.exec(text):null; if(full){put(out,full[1],scalar(full[2]));return out;} for(const m of text.matchAll(/\[([^\[\]\n:]{1,100})::\s*([^\]\n]*)\]/g))put(out,m[1],scalar(m[2]));return out; }
function visibleText(tokens) { let out=''; for(const token of tokens||[]) { if(['code','codespan','html','escape','def','checkbox'].includes(token.type))continue; if(token.tokens)out+=visibleText(token.tokens); else if(['text','strong','em','del','link'].includes(token.type))out+=token.text||''; } return out; }
function analyzeMarkdown(note) {
  const body=String(note.body ?? note.content).replace(/%%[\s\S]*?%%/g,s=>s.replace(/[^\r\n]/g,' ')), lines=body.split(/\r?\n/), base=(note.bodyStartLine||1)-1, tasks=[], fields=Object.create(null);
  const tokens=Lexer.lex(body,{gfm:true});
  function walk(list,start=0,end=lines.length,inList=false,depth=0) {
    if(depth>32)return;let cursor=start;
    for(const token of list||[]) {
      if(token.type==='checkbox')continue;
      const first=(token.raw||'').split(/\r?\n/)[0].trim();let line=cursor;
      if(first) {const found=lines.slice(cursor,end).findIndex(l=>l.trim()===first||l.trim().startsWith(first));if(found>=0)line=cursor+found;}
      const length=Math.max(1,(token.raw||'').trimEnd().split(/\r?\n/).length), stop=Math.min(end,line+length);cursor=stop;
      if(['code','html','def'].includes(token.type))continue;
      if(token.type==='list') {
        let itemCursor=line;
        for(const item of token.items||[]) {
          const firstLine=item.raw.split(/\r?\n/)[0].trim(), found=lines.slice(itemCursor,stop).findIndex(l=>l.trim()===firstLine), taskLine=found>=0?itemCursor+found:itemCursor;
          const itemEnd=Math.min(stop,taskLine+item.raw.trimEnd().split(/\r?\n/).length);itemCursor=itemEnd;
          if(item.task) {const match=/^\s*(?:[-+*]|\d+[.)])\s+\[([ xX])\]\s*(.*)$/.exec(lines[taskLine]||''); if(match) {const text=match[2], extra=inlineFields(text,false);tasks.push({...extra,text,status:match[1],completed:/x/i.test(match[1]),checked:match[1]!==' ',line:base+taskLine+1,path:note.id,revision:note.revision,tags:[...text.matchAll(/(?:^|\s)(#[\p{L}\p{N}_/-]+)/gu)].map(m=>m[1])});}}
          walk(item.tokens,taskLine,itemEnd,true,depth+1);
        }
      } else if(token.type==='blockquote') { /* Blockquoted tasks/metadata are not indexed in this subset. */ }
      else if(!inList&&['paragraph','text'].includes(token.type)) {const text=token.tokens?visibleText(token.tokens):token.text||'';for(const row of text.split(/\r?\n/))for(const [key,value]of Object.entries(inlineFields(row)))fields[key]=Object.hasOwn(fields,key)?[...(Array.isArray(fields[key])?fields[key]:[fields[key]]),...(Array.isArray(value)?value:[value])]:value;}
    }
  }
  walk(tokens);return {tasks,fields};
}
export function tasksOf(note) { return analyzeMarkdown(note).tasks; }
export function metadataOf(note) {
  const {tasks,fields}=analyzeMarkdown(note), properties=safeValue(note.properties||{})||Object.create(null), row=Object.assign(Object.create(null),properties);
  for(const [key,value]of Object.entries(properties)){const normalized=keyOf(key);if(!Object.hasOwn(row,normalized)&&!forbidden.has(normalized))row[normalized]=value;}
  for(const [key,value]of Object.entries(fields)) { if(Object.hasOwn(row,key))row[key]=[...(Array.isArray(row[key])?row[key]:[row[key]]),...(Array.isArray(value)?value:[value])];else row[key]=value; }
  const explicit=(note.tags||[]).map(t=>'#'+String(t).replace(/^#/,'')), expanded=new Set();for(const tag of explicit){const parts=tag.split('/');for(let n=1;n<=parts.length;n++)expanded.add(parts.slice(0,n).join('/'));}
  row.file={name:path.posix.basename(note.id,'.md'),path:note.id,folder:path.posix.dirname(note.id)==='.'?'':path.posix.dirname(note.id),ext:path.posix.extname(note.id).slice(1),link:note.id,size:note.bytes??Buffer.byteLength(note.content||''),mtime:note.modified||null,mday:note.modified?.slice(0,10)||null,tags:[...expanded],etags:explicit,aliases:note.aliases||[],outlinks:(note.links||[]).map(l=>l.target),tasks};
  row.note=properties; row.tags??=[...expanded];return row;
}
function clipped(value, state, depth=0, budget={remaining:8192}) {
  if(budget.remaining<32){state.clipped=true;return '[value omitted]';}
  if(typeof value==='string') {const max=Math.min(4096,Math.floor((budget.remaining-4)/6));if(value.length>max){state.clipped=true;value=value.slice(0,max)+'…';}budget.remaining-=Buffer.byteLength(JSON.stringify(value));return value;}
  if(value===null||typeof value==='boolean'||typeof value==='number'){budget.remaining-=24;return value;}
  if(depth>=4){state.clipped=true;budget.remaining-=24;return '[nested value omitted]';}
  if(Array.isArray(value)){const out=[];for(const item of value.slice(0,40)){if(budget.remaining<32)break;out.push(clipped(item,state,depth+1,budget));}if(out.length<value.length)state.clipped=true;return out;}
  if(value&&typeof value==='object'){const out=Object.create(null),keys=Object.keys(value);for(const key of keys.slice(0,40)){const size=Buffer.byteLength(JSON.stringify(key));if(size+32>budget.remaining)break;budget.remaining-=size;out[key]=clipped(value[key],state,depth+1,budget);}if(Object.keys(out).length<keys.length)state.clipped=true;return out;}
  return null;
}
async function runPlan(vault, plan, options={}) {
  const limit=options.limit??100,offset=options.offset??0;if(!Number.isInteger(limit)||limit<1||limit>MAX_ROWS||!Number.isInteger(offset)||offset<0||offset>MAX_RECORDS)throw error('Pagination requires limit 1–500 and offset 0–50000.');
  await vault.refresh();let cache=caches.get(vault);if(!cache){cache=new Map();caches.set(vault,cache);}const work={steps:0},records=[];let scanned=0;
  for(const note of vault.entries.values()) {
    if(note.type!=='note')continue;if(++scanned>20000)throw error('Query exceeds 20000 indexed notes.',413);
    const signature=note.revision+':'+(note.modified||''), old=cache.get(note.id);let data=old?.signature===signature?old.data:metadataOf(note);if(old?.signature!==signature)cache.set(note.id,{signature,data});
    if(!matchesSource(plan.source,data,work))continue;
    if(plan.type==='TASK')for(const task of data.file.tasks)records.push({data:Object.assign(Object.create(null),data,task,{file:data.file}),note,task});else records.push({data,note});
    if(records.length>MAX_RECORDS)throw error('Query exceeds 50000 records; narrow FROM.',413);
  }
  for(const id of cache.keys())if(!vault.entries.has(id))cache.delete(id);
  let selected=records;for(const step of plan.steps){if(step.type==='where')selected=selected.filter(r=>truth(evaluate(step.expr,r.data,work)));else if(step.type==='limit')selected=selected.slice(0,step.value);else {const decorated=selected.map((r,index)=>({r,index,keys:step.fields.map(f=>evaluate(f.expr,r.data,work))}));decorated.sort((a,b)=>{if(++work.steps>MAX_WORK)throw error('Query sort work budget exceeded.',413);for(let i=0;i<step.fields.length;i++){const av=a.keys[i],bv=b.keys[i],c=order(av,bv);if(c)return av==null||bv==null?c:c*step.fields[i].direction;}return a.index-b.index;});selected=decorated.map(x=>x.r);}}
  const projection=plan.columns.length?plan.columns:[], columns=[...(!plan.withoutId||!projection.length?[{key:'file',label:'File'}]:[]),...projection.map(({key,label})=>({key,label}))];if(plan.type==='TASK')columns.push({key:'task',label:'Task'},{key:'completed',label:'Completed'});
  const state={clipped:false},rows=[];let bytes=0;
  for(const record of selected.slice(offset,offset+limit)){const values=[...(!plan.withoutId||!projection.length?[record.note.id]:[]),...projection.map(c=>clipped(evaluate(c.expr,record.data,work),state))];if(record.task)values.push(clipped(record.task.text,state),record.task.completed);const row={path:record.note.id,revision:record.note.revision,values,...(record.task?{line:record.task.line,task:clipped(record.task,state)}:{})};const size=Buffer.byteLength(JSON.stringify(row));if(bytes+size>256*1024)break;rows.push(row);bytes+=size;}
  const nextOffset=offset+rows.length<selected.length?offset+rows.length:null,warnings=[...(state.clipped?['Some returned values were shortened to keep response size bounded.']:[])];
  if(nextOffset!==null&&rows.length<Math.min(limit,selected.length-offset))warnings.push('Response byte budget reached; continue using nextOffset.');
  if(plan.type==='TASK')warnings.push('Task rows are flat; children do not inherit parent query matches. Blockquoted tasks and custom checkbox statuses are not indexed.');
  return {type:plan.type,columns,rows,total:selected.length,nextOffset,truncated:nextOffset!==null||state.clipped,warnings,compatibility:plan.compatibility,scannedFiles:scanned};
}
export async function queryVault(vault, query, options={}) { return runPlan(vault,parseQuery(query),options); }

// Restricted Bases adapter: filters and projected table/list fields only. No formula execution.
export async function queryBase(vault, content, viewName, options={}) {
  if(typeof content!=='string'||content.length>65536)throw error('Base YAML must be at most 64 KiB.');let base;try{base=parseYaml(content,{maxAliasCount:20});}catch(e){throw error('Invalid Bases YAML: '+e.message);}
  if(!base||typeof base!=='object'||Array.isArray(base))throw error('Base must be a YAML object.');
  const allowed=new Set(['filters','views','properties']);for(const key of Object.keys(base))if(!allowed.has(key))throw error(`Unsupported Bases field: ${key}. Formulas and summaries are not executed.`);
  if(!Array.isArray(base.views)||!base.views.length||base.views.length>20)throw error('Base must have 1–20 views.');const matches=viewName?base.views.filter(v=>v?.name===viewName):[base.views[0]];if(matches.length!==1)throw error('Base view is missing or ambiguous.');const view=matches[0];
  if(!view||!['table','list'].includes(view.type))throw error('Bases supports table/list views only.');for(const key of Object.keys(view))if(!['type','name','filters','order','limit'].includes(key))throw error(`Unsupported Bases view field: ${key}`);
  const parseExpression=text=>{const p=new Parser(text),expr=p.expression();if(p.peek().type!=='end')throw error('Unsupported Bases expression syntax.');return expr;};
  let filterNodes=0;const filter=(value,depth=0)=>{if(++filterNodes>100||depth>16)throw error('Bases filter nesting/size limit exceeded.',413);if(typeof value==='string')return parseExpression(value);if(!value||typeof value!=='object'||Array.isArray(value))throw error('Invalid Bases filter.');const keys=Object.keys(value);if(keys.length!==1||!['and','or','not'].includes(keys[0])||!Array.isArray(value[keys[0]])||!value[keys[0]].length)throw error('Bases filters require a nonempty and/or/not list.');const op=keys[0],children=value[op].map(v=>filter(v,depth+1));const combined=children.reduce((a,b)=>({type:'binary',op:op==='or'?'OR':'AND',left:a,right:b}));return op==='not'?{type:'unary',op:'!',value:combined}:combined;};
  const plan={type:view.type.toUpperCase(),withoutId:true,source:null,columns:[],steps:[],compatibility:'mastermind-bases-subset-v1'};
  if(base.filters!==undefined)plan.steps.push({type:'where',expr:filter(base.filters)});if(view.filters!==undefined)plan.steps.push({type:'where',expr:filter(view.filters)});
  const order=view.order??['file.name'];if(!Array.isArray(order)||!order.length||order.length>20||order.some(v=>typeof v!=='string'))throw error('Bases order requires 1–20 property names.');if(view.type==='list'&&order.length>1)throw error('List view supports one displayed property.');
  for(const name of order){const expr=parseExpression(name);if(expr.type!=='field')throw error('Bases order supports property names only.');const settings=own(base.properties||{},name);if(settings&&Object.keys(settings).some(k=>k!=='displayName'))throw error('Unsupported Bases property setting.');const label=settings?.displayName??name;if(typeof label!=='string'||label.length>240)throw error('Invalid Bases displayName.');plan.columns.push({key:name,label,expr});}
  if(view.limit!==undefined){if(!Number.isInteger(view.limit)||view.limit<0||view.limit>MAX_RECORDS)throw error('Invalid Bases limit.');plan.steps.push({type:'limit',value:view.limit});}
  const result=await runPlan(vault,plan,options);result.view=view.name||null;result.warnings.push('Bases adapter queries Markdown notes only; it does not index attachments or execute formulas.');return result;
}
