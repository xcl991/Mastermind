import { parse as parseYaml } from 'yaml';
const invalid = message => Object.assign(new Error(message), { status: 400 });
export function validateCanvas(data) {
  if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.edges) || data.nodes.length > 5000 || data.edges.length > 20000) throw invalid('Canvas requires nodes/edges; maximum 5000 nodes and 20000 edges.');
  const ids = new Set();
  for (const n of data.nodes) {
    if (!n || typeof n.id !== 'string' || !n.id || n.id.length > 200 || ids.has(n.id)) throw invalid('Canvas node IDs must be unique strings.'); ids.add(n.id);
    if (!['text', 'file', 'link', 'group'].includes(n.type)) throw invalid('Unsupported Canvas node type.');
    for (const key of ['x', 'y', 'width', 'height']) if (!Number.isFinite(n[key]) || Math.abs(n[key]) > 1e7 || (['width', 'height'].includes(key) && n[key] <= 0)) throw invalid('Canvas geometry must be finite and bounded.');
    if (n.type === 'text' && typeof n.text !== 'string') throw invalid('Text node requires text.');
    if (n.type === 'file' && typeof n.file !== 'string') throw invalid('File node requires file.');
    if (n.type === 'link' && (typeof n.url !== 'string' || !/^https?:\/\//i.test(n.url))) throw invalid('Link nodes must use HTTP(S).');
  }
  const edges = new Set();
  for (const e of data.edges) { if (!e || typeof e.id !== 'string' || !e.id || edges.has(e.id) || !ids.has(e.fromNode) || !ids.has(e.toNode)) throw invalid('Invalid Canvas edge IDs or endpoints.'); edges.add(e.id); }
  return data;
}
export function validateDocument(id, content) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > 2 * 1024 * 1024) throw invalid('Document maximum 2 MiB.');
  if (id.endsWith('.canvas')) { try { return validateCanvas(JSON.parse(content)); } catch (e) { throw invalid(e.message); } }
  if (id.endsWith('.base')) { let data; try { data = parseYaml(content, { maxAliasCount: 20 }); } catch (e) { throw invalid(e.message); } if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.views)) throw invalid('Base requires a YAML object with views.'); return data; }
  throw invalid('Structured document must be .base or .canvas.');
}
