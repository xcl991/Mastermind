import { parse } from '@babel/parser';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const EXTENSIONS = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py'];
const CACHE_VERSION = 4;
const digest = s => createHash('sha256').update(s).digest('hex');
const member = n => n?.type === 'Identifier' ? n.name : n?.type === 'ThisExpression' ? 'this' : n?.type === 'MemberExpression' && !n.computed ? `${member(n.object)}.${member(n.property)}` : null;
const names = n => !n ? [] : n.type === 'Identifier' ? [n.name] : n.type === 'RestElement' ? names(n.argument) : n.type === 'AssignmentPattern' ? names(n.left) : n.type === 'ObjectPattern' ? n.properties.flatMap(p => names(p.value || p.argument)) : n.type === 'ArrayPattern' ? n.elements.flatMap(names) : [];

export function analyzeJavaScript(id, content) {
  const output = { parser: 'babel', symbols: [], imports: [], calls: [], exports: {}, scopes: [{ parent: null, bindings: {} }], limitations: [] };
  let ast;
  try { ast = parse(content, { sourceType: 'unambiguous', errorRecovery: true, plugins: [...(/\.[mc]?tsx?$/.test(id) ? ['typescript'] : []), ...(!/\.[mc]?ts$/.test(id) ? ['jsx'] : []), 'decorators-legacy'], allowReturnOutsideFunction: true }); }
  catch (e) { return { ...output, limitations: [`Parse failed: ${e.message}`], coverage: 'unavailable' }; }
  if (ast.errors?.length) output.limitations.push(...ast.errors.map(e => e.message).slice(0, 10));
  const bind = (scope, name, value) => { if (name) output.scopes[scope].bindings[name] = value; };
  const addSymbol = (node, label, kind, owner) => {
    if (output.symbols.length >= 2000) return null;
    const symbol = { id: `symbol:${id}#${label}@${node.loc.start.line}:${node.start}`, label, kind, type: 'symbol', source_file: id, source_location: `L${node.loc.start.line}-L${node.loc.end.line}`, startLine: node.loc.start.line, endLine: node.loc.end.line, start: node.start, end: node.end, owner: owner || id, confidence: 'EXTRACTED', parser: 'babel' };
    output.symbols.push(symbol); return symbol;
  };
  function walk(n, scope = 0, owner = null, parent = null, hint = '') {
    if (!n || typeof n !== 'object' || typeof n.type !== 'string') return;
    if (n.type.startsWith('TS') && !['TSAsExpression', 'TSNonNullExpression', 'TSSatisfiesExpression', 'TSTypeAssertion', 'TSInstantiationExpression', 'TSParameterProperty'].includes(n.type)) return;
    if (n.type === 'ImportDeclaration') {
      for (const spec of n.specifiers) { const imp = { target: n.source.value, local: spec.local.name, imported: spec.type === 'ImportDefaultSpecifier' ? 'default' : spec.type === 'ImportNamespaceSpecifier' ? '*' : spec.imported.name ?? spec.imported.value, line: n.loc.start.line }; output.imports.push(imp); bind(scope, imp.local, { import: output.imports.length - 1 }); }
      if (!n.specifiers.length) output.imports.push({ target: n.source.value, line: n.loc.start.line }); return;
    }
    if (n.type === 'VariableDeclarator') {
      for (const name of names(n.id)) bind(scope, name, { unknown: true });
      if (n.init?.type === 'CallExpression' && n.init.callee.type === 'Identifier' && n.init.callee.name === 'require' && n.init.arguments[0]?.type === 'StringLiteral') {
        const target = n.init.arguments[0].value;
        if (n.id.type === 'Identifier') { output.imports.push({ target, local: n.id.name, imported: '*', line: n.loc.start.line }); bind(scope, n.id.name, { import: output.imports.length - 1 }); }
        else if (n.id.type === 'ObjectPattern') for (const p of n.id.properties) if (p.type === 'ObjectProperty' && p.value.type === 'Identifier') { output.imports.push({ target, local: p.value.name, imported: p.key.name || p.key.value, line: n.loc.start.line }); bind(scope, p.value.name, { import: output.imports.length - 1 }); }
      }
      walk(n.init, scope, owner, n, n.id.type === 'Identifier' ? n.id.name : ''); return;
    }
    if (n.type === 'ClassDeclaration' || n.type === 'ClassExpression') {
      const label = n.id?.name || hint || `class@${n.loc.start.line}`, symbol = addSymbol(n, label, 'class', owner);
      if (symbol && n.id) bind(scope, n.id.name, { symbol: symbol.id });
      if (n.superClass) output.calls.push({ from: symbol?.id || owner || id, name: member(n.superClass), scope, line: n.loc.start.line, relation: 'inherits' });
      const child = output.scopes.push({ parent: scope, bindings: {} }) - 1; walk(n.body, child, symbol?.id || owner, n, label); return;
    }
    if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod', 'ClassMethod', 'ClassPrivateMethod'].includes(n.type)) {
      const label = n.id?.name || hint || (n.key && !n.computed ? n.key.name ?? n.key.value : null) || `anonymous@${n.loc.start.line}`;
      const symbol = addSymbol(n, String(label), n.type.includes('Method') ? 'method' : 'function', owner);
      if (symbol && (n.type === 'FunctionDeclaration' || parent?.type === 'VariableDeclarator')) bind(scope, n.id?.name || hint, { symbol: symbol.id });
      const child = output.scopes.push({ parent: scope, bindings: {} }) - 1;
      if (n.id && symbol) bind(child, n.id.name, { symbol: symbol.id });
      for (const p of n.params) for (const name of names(p.type === 'TSParameterProperty' ? p.parameter : p)) bind(child, name, { unknown: true });
      walk(n.body, child, symbol?.id || owner, n); return;
    }
    if (n.type === 'BlockStatement' && !parent?.type?.includes('Function') && !parent?.type?.includes('Method')) scope = output.scopes.push({ parent: scope, bindings: {} }) - 1;
    if (n.type === 'CatchClause') { scope = output.scopes.push({ parent: scope, bindings: {} }) - 1; for (const name of names(n.param)) bind(scope, name, { unknown: true }); }
    if (n.type === 'CallExpression' || n.type === 'NewExpression' || n.type === 'OptionalCallExpression') {
      const name = member(n.callee); if (name) output.calls.push({ from: owner || id, name, scope, line: n.loc.start.line, relation: n.type === 'NewExpression' ? 'constructs' : 'calls' });
    }
    if (n.type === 'ExportNamedDeclaration') {
      walk(n.declaration, scope, owner, n);
      if (n.declaration) { const d = n.declaration; for (const name of d.type === 'VariableDeclaration' ? d.declarations.flatMap(v => names(v.id)) : names(d.id)) output.exports[name] = { local: name }; }
      for (const spec of n.specifiers || []) if (spec.type === 'ExportSpecifier') output.exports[spec.exported.name ?? spec.exported.value] = n.source ? { target: n.source.value, imported: spec.local.name ?? spec.local.value } : { local: spec.local.name ?? spec.local.value }; return;
    }
    if (n.type === 'ExportDefaultDeclaration') {
      const before = output.symbols.length; walk(n.declaration, scope, owner, n, 'default');
      output.exports.default = n.declaration.type === 'Identifier' ? { local: n.declaration.name } : n.declaration.id ? { local: n.declaration.id.name } : output.symbols[before] ? { symbol: output.symbols[before].id } : { unknown: true }; return;
    }
    if (n.type === 'AssignmentExpression') {
      const label = member(n.left), before = output.symbols.length;
      walk(n.right, scope, owner, n, label || '');
      if (label?.startsWith('exports.') || label?.startsWith('module.exports.')) { const name = label.split('.').at(-1); output.exports[name] = n.right.type === 'Identifier' ? { local: n.right.name } : output.symbols[before] ? { symbol: output.symbols[before].id } : { unknown: true }; }
      else if (label === 'module.exports') output.exports.default = n.right.type === 'Identifier' ? { local: n.right.name } : output.symbols[before] ? { symbol: output.symbols[before].id } : { unknown: true };
      return;
    }
    if (n.type === 'ObjectProperty') { walk(n.value, scope, owner, n, !n.computed ? String(n.key.name ?? n.key.value) : ''); return; }
    for (const [key, value] of Object.entries(n)) { if (['loc', 'start', 'end', 'comments', 'tokens', 'errors'].includes(key)) continue; if (Array.isArray(value)) for (const v of value) walk(v, scope, owner, n); else if (value && typeof value.type === 'string') walk(value, scope, owner, n); }
  }
  walk(ast.program);
  if (output.symbols.length >= 2000) output.limitations.push('Symbol limit 2000 per file reached.');
  return { ...output, coverage: output.limitations.length ? 'partial' : 'static-subset' };
}

async function analyzePython(id, content) {
  return new Promise(resolve => {
    const child = spawn(process.env.MASTERMIND_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-I', fileURLToPath(new URL('../scripts/python-ast.py', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '', error = '', settled = false; const finish = result => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
    const unavailable = message => ({ parser: 'python-ast', symbols: [], imports: [], calls: [], scopes: [{ parent: null, bindings: {} }], exports: {}, coverage: 'unavailable', limitations: [message] });
    const timer = setTimeout(() => { child.kill(); finish(unavailable('Python AST timeout.')); }, 5000);
    child.on('error', e => finish(unavailable(`Python AST unavailable: ${e.code}`))); child.stdin.on('error', () => {});
    child.stdout.on('data', d => { out += d; if (out.length > 4e6) { child.kill(); finish(unavailable('Python AST output limit.')); } }); child.stderr.on('data', d => error += d.toString().slice(0, 1000));
    child.on('close', code => { try { finish(code ? unavailable(error || 'Python AST failed.') : JSON.parse(out)); } catch { finish(unavailable('Invalid Python AST result.')); } }); child.stdin.end(JSON.stringify({ id, content }));
  });
}

function resolveModule(from, spec, entries, python = false) {
  let base;
  if (python) {
    const dots = spec.match(/^\.+/)?.[0].length || 0, rest = spec.slice(dots).replaceAll('.', '/');
    base = dots ? path.posix.join(path.posix.dirname(from), '../'.repeat(Math.max(0, dots - 1)), rest) : rest;
  } else { if (!spec.startsWith('.')) return null; base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec)); }
  if (base.startsWith('../') || base.startsWith('/')) return null;
  const candidates = [base, ...EXTENSIONS.map(ext => base + ext), ...EXTENSIONS.map(ext => base + '/index' + ext), base + '/__init__.py'];
  if (base.endsWith('.js')) candidates.push(base.slice(0, -3) + '.ts', base.slice(0, -3) + '.tsx');
  return candidates.find(p => entries.has(p)) || null;
}
function lookup(analysis, scope, name) { while (scope !== null && scope !== undefined) { const s = analysis.scopes[scope]; if (!s) break; if (Object.hasOwn(s.bindings, name)) return s.bindings[name]; scope = s.parent; } return null; }
export class CodeIndex {
  constructor(vault) { this.vault = vault; this.cache = new Map(); this.epoch = -1; }
  async build(entries = this.vault.entries, epoch = this.vault.epoch) {
    if (this.epoch === epoch) return this.result;
    const analyses = new Map(), limitations = []; let cacheDir;
    if (!this.vault.readOnly || this.vault.stateRoot !== path.join(this.vault.root, '.mastermind')) cacheDir = await this.vault.internal('code-cache');
    for (const record of entries.values()) {
      if (record.type !== 'code') continue;
      const key = digest(`${CACHE_VERSION}:${record.id}:${record.revision}`); let data = this.cache.get(key);
      if (!data && cacheDir) try { const file = path.join(cacheDir, key + '.json'); const s = await fs.lstat(file); if (s.isFile() && !s.isSymbolicLink() && s.size < 4e6) { const cached = JSON.parse(await fs.readFile(file, 'utf8')); if (cached.key === key && cached.version === CACHE_VERSION) data = cached.data; } } catch {}
      if (!data) {
        data = record.id.endsWith('.py') ? await analyzePython(record.id, record.content) : analyzeJavaScript(record.id, record.content);
        if (cacheDir) await fs.writeFile(path.join(cacheDir, key + '.json'), JSON.stringify({ version: CACHE_VERSION, key, data }), { flag: 'wx' }).catch(() => {});
      }
      this.cache.set(key, data); analyses.set(record.id, data);
      if (data.limitations.length) limitations.push({ file: record.id, coverage: data.coverage, limitations: data.limitations });
      if (analyses.size % 15 === 0) await new Promise(resolve => setImmediate(resolve));
    }
    const nodes = [], links = [], unresolved = [];
    const exported = (file, name, seen = new Set()) => {
      const key = file + ':' + name; if (seen.has(key) || seen.size > 10) return null; seen.add(key); const a = analyses.get(file), exp = a?.exports[name]; if (!exp) return null;
      if (exp.symbol) return exp.symbol;
      if (exp.local) return lookup(a, 0, exp.local)?.symbol || null;
      if (exp.target) { const target = resolveModule(file, exp.target, entries, file.endsWith('.py')); if (target) return exported(target, exp.imported, seen); }
      return null;
    };
    for (const [file, a] of analyses) {
      const admitted = a.symbols.slice(0, Math.max(0, 20000 - nodes.length)); nodes.push(...admitted);
      for (const n of admitted) links.push({ source: n.owner, target: n.id, relation: 'contains', confidence: 'EXTRACTED', source_file: file });
      for (const imp of a.imports) { const target = resolveModule(file, imp.target, entries, file.endsWith('.py')); if (target) links.push({ source: file, target, relation: 'imports', confidence: 'EXTRACTED', source_file: file, source_location: `L${imp.line}`, parser: a.parser }); }
      for (const call of a.calls) {
        if (!call.name) continue;
        const parts = call.name.split('.'), binding = lookup(a, call.scope, parts[0]); let target = parts.length === 1 ? binding?.symbol : null;
        if (binding?.import !== undefined) { const imp = a.imports[binding.import], fileTarget = resolveModule(file, imp.target, entries, file.endsWith('.py')); if (fileTarget) target = exported(fileTarget, imp.imported === '*' && parts.length === 2 ? parts[1] : parts.length === 1 ? imp.imported : ''); }
        if (target) links.push({ source: call.from, target, relation: call.relation || 'calls', confidence: 'INFERRED', source_file: file, source_location: `L${call.line}`, rationale: 'Static lexical/import binding; runtime dispatch not observed.', parser: a.parser });
        else if (unresolved.length < 1000) unresolved.push({ source_file: file, line: call.line, name: call.name, reason: 'Dynamic, external, ambiguous, or unsupported binding' });
      }
    }
    const ids = new Set([...entries.keys(), ...nodes.map(n => n.id)]);
    this.result = { nodes, links: links.filter(e => ids.has(e.source) && ids.has(e.target)), coverage: { files: analyses.size, symbols: nodes.length, parser: 'Babel JS/TS + optional Python stdlib AST', semanticEquivalence: false, limitations, unresolved, truncated: nodes.length >= 20000 || unresolved.length >= 1000 } };
    this.epoch = epoch; if (this.cache.size > 2 * analyses.size + 50) { const keep = new Set([...entries.values()].map(n => digest(`${CACHE_VERSION}:${n.id}:${n.revision}`))); for (const key of this.cache.keys()) if (!keep.has(key)) this.cache.delete(key); }
    return this.result;
  }
}
