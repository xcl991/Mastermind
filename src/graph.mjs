import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail } from './vault.mjs';
import { CodeIndex } from './code.mjs';

const resolutionCache = new WeakMap();
export function resolveLink(target, from, entries, kind = 'wiki') {
  if (!target) return entries.has(from) ? from : null;
  const addMd = value => /\.[a-z0-9]+$/i.test(value) ? value : `${value}.md`;
  const normalized = addMd(target);
  const relative = path.posix.normalize(path.posix.join(path.posix.dirname(from), normalized));
  const candidates = kind === 'markdown' ? [relative, normalized] : [normalized, relative];
  for (const id of candidates) if (entries.has(id)) return id;
  let index = resolutionCache.get(entries);
  if (!index) { index = new Map(); for (const n of entries.values()) for (const term of [path.posix.basename(n.id, '.md'), n.id, n.id.replace(/\.md$/i, ''), ...(n.aliases || [])]) { const key = term.normalize('NFC').toLowerCase(); if (!index.has(key)) index.set(key, new Set()); index.get(key).add(n.id); } resolutionCache.set(entries, index); }
  const lower = target.replace(/\.md$/i, '').normalize('NFC').toLowerCase(), matches = index.get(lower);
  return matches?.size === 1 ? matches.values().next().value : null;
}

export function validateGraph(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.nodes) || !Array.isArray(data.links ?? data.edges)) throw fail('Graph harus memiliki array nodes dan links/edges.');
  if (data.graph?.schema_version !== undefined && data.graph.schema_version !== 1) throw fail('Versi schema graph belum didukung (hanya v1).');
  if (data.nodes.length > 20000 || (data.links ?? data.edges).length > 100000) throw fail('Batas impor: 20.000 nodes dan 100.000 edges.');
  const ids = new Set();
  for (const n of data.nodes) { if (!n || typeof n.id !== 'string' || !n.id || ids.has(n.id)) throw fail('Node ID harus string unik.'); ids.add(n.id); }
  for (const e of data.links ?? data.edges) if (!e || !ids.has(e._src ?? e.source) || !ids.has(e._tgt ?? e.target)) throw fail('Edge mengacu ke node yang tidak ada.');
  return data;
}

export class Graph {
  constructor(vault) { this.vault = vault; this.cachedEpoch = -1; this.code = new CodeIndex(vault); }
  async import(data) {
    this.vault.assertWritable(); validateGraph(data);
    const serialized=JSON.stringify(data);if(Buffer.byteLength(serialized)>16*1024*1024)throw fail('Graph maximum 16 MiB.',413);
    await this.vault.lock('graph-import', async () => {
      const dir = await this.vault.internal(); const file = path.join(dir, 'imported-graph.json');
      try { const s = await fs.lstat(file); if (s.isSymbolicLink()) throw fail('File graph berupa symlink.', 403); await fs.copyFile(file, path.join(await this.vault.internal('graph-history'), `${Date.now()}-${randomUUID()}.json`)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      await this.vault.durableFile(file,serialized);
    });
    this.cachedEpoch = -1; return { nodes: data.nodes.length, edges: (data.links ?? data.edges).length };
  }
  async importCanvas(data) {
    if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.edges)) throw fail('Canvas harus memiliki nodes dan edges.');
    if(data.nodes.some(n=>!n||typeof n!=='object')||data.edges.some(e=>!e||typeof e!=='object'))throw fail('Canvas nodes/edges tidak valid.');
    return this.import({ graph: { schema_version: 1, original_format: 'json-canvas-1.0' }, nodes: data.nodes.map(n => ({ id: n.id, label: String(n.text || n.file || n.label || n.url || n.id).slice(0, 240), source_file: n.type === 'file' ? n.file : undefined, canvas: n })), links: data.edges.map(e => ({ ...e, source: e.fromNode, target: e.toNode, relation: e.label || 'canvas-link', confidence: 'EXTRACTED' })) });
  }
  async imported() {
    const file = path.join(this.vault.stateRoot || path.join(this.vault.root, '.mastermind'), 'imported-graph.json');
    try { await this.vault.internal(); const s = await fs.lstat(file); if (s.isSymbolicLink() || s.size > 16 * 1024 * 1024) throw fail('File graph tidak aman atau terlalu besar.'); return validateGraph(JSON.parse(await fs.readFile(file, 'utf8'))); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  async build() {
    if (this.building) return this.building;
    this.building = this.buildSnapshot();
    try { return await this.building; } finally { this.building = null; }
  }
  async buildSnapshot() {
    await this.vault.refresh();
    // Import may be replaced by a second MCP process; stat it before cache reuse.
    const importFile = path.join(this.vault.stateRoot || path.join(this.vault.root, '.mastermind'), 'imported-graph.json');
    const stamp = await fs.lstat(importFile).then(s => `${s.mtimeMs}:${s.ctimeMs}:${s.size}`).catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
    if (this.cachedEpoch === this.vault.epoch && this.importStamp === stamp) return this.cache;
    const nodes = [], links = [], entries = this.vault.entries, epoch = this.vault.epoch, known = new Set();
    const node = n => { if (!known.has(n.id)) { known.add(n.id); nodes.push(n); } };
    for (const n of entries.values()) node({ id: n.id, label: n.title, type: n.type, source_file: n.id, tags: n.tags, community: n.id.includes('/') ? n.id.split('/')[0] : 'Vault' });
    for (const n of entries.values()) {
      for (const ref of n.links) {
        const resolved = resolveLink(ref.target, n.id, entries, ref.kind), target = resolved ?? `missing:${ref.target}`;
        if (!resolved) node({ id: target, label: ref.target, type: 'missing', community: 'Unresolved' });
        links.push({ source: n.id, target, relation: 'links_to', confidence: 'EXTRACTED', source_file: n.id });
      }
      for (const tag of n.tags) { node({ id: `tag:${tag}`, label: `#${tag}`, type: 'tag', community: 'Tags' }); links.push({ source: n.id, target: `tag:${tag}`, relation: 'tagged', confidence: 'EXTRACTED' }); }
    }
    const code = await this.code.build(entries, epoch);
    for (const n of code.nodes) node(n);
    links.push(...code.links);
    const imported = await this.imported();
    if (imported) {
      for (const n of imported.nodes) {
        let candidate = typeof n.source_file === 'string' ? n.source_file.replaceAll('\\', '/') : '';
        if (path.isAbsolute(candidate)) candidate = path.relative(this.vault.root, candidate).split(path.sep).join('/');
        candidate = candidate.replace(/^\.\//, '');
        const local = entries.has(candidate) && !candidate.split('/').includes('..') ? candidate : undefined;
        node({ ...n, id: `external:${n.id}`, original_id: n.id, label: String(n.label ?? n.id), type: 'imported', local_source: local, mapping_status: local ? 'source-mapped' : 'unmapped', community: String(n.community ?? 'Imported graph') });
      }
      for (const e of imported.links ?? imported.edges) { const { _src, _tgt, ...attributes } = e; links.push({ ...attributes, source: `external:${_src ?? e.source}`, target: `external:${_tgt ?? e.target}` }); }
    }
    const seen = new Set(); const unique = links.filter(e => { if (e.source.startsWith('external:')) return true; const k = JSON.stringify([e.source, e.target, e.relation, e.confidence, e.source_location]); if (seen.has(k)) return false; seen.add(k); return true; });
    const degree = new Map(); for (const e of unique) { degree.set(e.source, (degree.get(e.source) || 0) + 1); degree.set(e.target, (degree.get(e.target) || 0) + 1); }
    for (const n of nodes) n.degree = degree.get(n.id) || 0;
    this.cache = { directed: true, multigraph: true, graph: { schema_version: 1, producer: 'mastermind', mastermind_version: '0.3.3', code_coverage: code.coverage, imported_graph_metadata: imported?.graph ?? null }, nodes, links: unique, warnings: this.vault.warnings };
    this.cachedEpoch = epoch; this.importStamp = stamp; return this.cache;
  }
  async query(query = '', limit = 100) {
    const graph = await this.build(); const q = String(query).toLowerCase(); limit = Math.max(1, Math.min(1000, Number(limit) || 100));
    const matched = graph.nodes.filter(n => `${n.label} ${n.id}`.toLowerCase().includes(q));
    const nodes = matched.slice(0, limit), ids = new Set(nodes.map(n => n.id));
    return { ...graph, nodes, links: graph.links.filter(e => ids.has(e.source) && ids.has(e.target)), totalMatches: matched.length, truncated: matched.length > limit };
  }
  async neighbors(id) { const g = await this.build(); return { node: g.nodes.find(n => n.id === id) ?? null, incoming: g.links.filter(e => e.target === id), outgoing: g.links.filter(e => e.source === id) }; }
  async shortestPath(from, to) {
    const g = await this.build(), ids = new Set(g.nodes.map(n => n.id)); if (!ids.has(from) || !ids.has(to)) throw fail('Node tidak ditemukan.', 404);
    const adjacent = new Map(g.nodes.map(n => [n.id, []]));
    for (const e of g.links) { adjacent.get(e.source).push(e.target); adjacent.get(e.target).push(e.source); }
    const queue = [from], parent = new Map([[from, null]]);
    for (let i = 0; i < queue.length && !parent.has(to); i++) for (const next of adjacent.get(queue[i])) if (!parent.has(next)) { parent.set(next, queue[i]); queue.push(next); }
    if (!parent.has(to)) return { path: [], found: false, traversal: 'undirected' };
    const route = []; for (let n = to; n !== null; n = parent.get(n)) route.unshift(n);
    return { path: route, found: true, traversal: 'undirected' };
  }
  async canvas() {
    const g = await this.build(), indexes = new Map(g.nodes.map((n, i) => [n.id, i])); return { nodes: g.nodes.map((n, i) => ({ id: `n${i}`, type: 'text', text: n.label, x: (i % 6) * 280, y: Math.floor(i / 6) * 180, width: 240, height: 120 })), edges: g.links.map((e, i) => ({ id: `e${i}`, fromNode: `n${indexes.get(e.source)}`, toNode: `n${indexes.get(e.target)}`, label: e.relation || 'link' })) };
  }
}
