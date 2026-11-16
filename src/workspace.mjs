import fs from 'node:fs/promises';
import path from 'node:path';
import { fail } from './vault.mjs';
import { findingFreshness } from './findings.mjs';

const own = (object, key) => Object.hasOwn(object, key);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max, label) => { if (typeof value !== 'string' || !value.trim() || value.length > max) throw fail(`Invalid ${label}.`); return value; };
const keys = (object, allowed) => { if (!plain(object) || Object.keys(object).some(k => !allowed.includes(k))) throw fail('Unsupported manifest fields. JavaScript plugins are not supported.'); };
export function validateExtension(input) {
  keys(input, ['schemaVersion', 'id', 'name', 'version', 'description', 'commands', 'theme']);
  if (input.schemaVersion !== 1 || typeof input.id !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(input.id)) throw fail('Extension schemaVersion/id invalid.');
  text(input.name, 80, 'name'); text(input.version, 40, 'version');
  if (input.description !== undefined) text(input.description, 400, 'description');
  if (!Array.isArray(input.commands) || input.commands.length > 20) throw fail('Extension commands must be an array, maximum 20.');
  const ids = new Set(), commands = input.commands.map(c => {
    keys(c, ['id', 'name', 'type', 'query', 'template']);
    if (typeof c.id !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(c.id) || ids.has(c.id)) throw fail('Command IDs must be unique.'); ids.add(c.id); text(c.name, 100, 'command name');
    if (c.type === 'query') { text(c.query, 4096, 'query'); if (own(c, 'template')) throw fail('Query command cannot contain a template.'); }
    else if (c.type === 'template') { text(c.template, 16000, 'template'); if (own(c, 'query')) throw fail('Template command cannot contain a query.'); }
    else throw fail('Supported command types: query, template.');
    return { ...c };
  });
  if (input.theme !== undefined) { keys(input.theme, ['accent', 'background', 'text']); for (const color of Object.values(input.theme)) if (typeof color !== 'string' || !/^#[a-f\d]{6}$/i.test(color)) throw fail('Theme values must be six-digit hex colors.'); }
  return { ...input, commands, permissions: [...new Set(commands.map(c => c.type === 'query' ? 'vault:read' : 'vault:create'))], runtime: 'mastermind-declarative-v1' };
}
async function readExtensions(vault) {
  try {
    const file = await vault.stateFile(['extensions.json']), stat = await fs.stat(file); if (stat.size > 1024 * 1024) throw fail('Extension registry too large.');
    const registry = JSON.parse(await fs.readFile(file, 'utf8')); if (!Array.isArray(registry) || registry.length > 50) throw fail('Invalid registry.');
    return registry.map(item => ({ manifest: validateExtension(item.manifest), enabled: item.enabled === true }));
  } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
export async function listExtensions(vault) { return readExtensions(vault); }
export async function installExtension(vault, input) {
  vault.assertWritable();
  const validated = validateExtension(input), { permissions, runtime, ...manifest } = validated;
  return vault.lock('extensions-registry', async () => {
    const items = await readExtensions(vault);
    if (items.some(i => i.manifest.id === manifest.id)) throw fail('Extension already installed; remove it before replacing the manifest.', 409);
    if (items.length >= 50) throw fail('Maximum 50 extensions.');
    items.push({ manifest, enabled: false }); await persistExtensions(vault, items); return { manifest: validated, enabled: false };
  });
}
async function persistExtensions(vault, items) { const data=items.map(({ manifest: { permissions, runtime, ...manifest }, enabled }) => ({ manifest, enabled })); if(Buffer.byteLength(JSON.stringify(data,null,2))>1024*1024)throw fail('Extension registry maximum 1 MiB.',413);return vault.writeState(['extensions.json'],data); }
export async function changeExtension(vault, { id, enabled, remove = false }) {
  vault.assertWritable();
  if (typeof id !== 'string' || (enabled !== undefined && typeof enabled !== 'boolean') || typeof remove !== 'boolean') throw fail('Invalid extension change.');
  return vault.lock('extensions-registry', async () => { const items = await readExtensions(vault), item = items.find(x => x.manifest.id === id); if (!item) throw fail('Extension not found.', 404); if (enabled !== undefined) item.enabled = enabled; await persistExtensions(vault, remove ? items.filter(x => x !== item) : items); return { id, enabled: item.enabled, removed: remove }; });
}
export async function healthCheck(vault, graph) {
  const g = await graph.build(), notes = [...vault.entries.values()].filter(n => n.type === 'note');
  const linked = new Set(g.links.filter(e => e.relation === 'links_to' && !e.target.startsWith('missing:')).flatMap(e => [e.source, e.target]));
  const missing = g.links.filter(e => e.target.startsWith('missing:')).map(e => ({ path: e.source_file || e.source, target: e.target.slice(8) }));
  const orphans = notes.filter(n => !linked.has(n.id)).map(n => n.id);
  const staleFindings = notes.filter(n => findingFreshness(n, vault.entries).status === 'stale').map(n => n.id);
  let pluginInventory = [], pluginInventoryWarning;
  const ids = new Set();
  try {
    const directories = (await fs.readdir(vault.root, {withFileTypes:true})).filter(e => e.isDirectory() && /^\.[\w-]+$/.test(e.name) && !['.mastermind','.git'].includes(e.name)).sort((a,b)=>a.name.localeCompare(b.name));
    if(directories.length>32) pluginInventoryWarning='Plugin inventory limited to 32 settings directories.';
    for(const entry of directories.slice(0,32)) {
      try {
        const directory=path.join(vault.root,entry.name),folder=await fs.lstat(directory);if(folder.isSymbolicLink()||!folder.isDirectory())throw fail('External editor settings directory is not a regular directory.');
        const file=path.join(directory,'community-plugins.json'),stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>256*1024)throw fail('Plugin inventory unavailable.');
        const data=JSON.parse(await fs.readFile(file,'utf8'));if(!Array.isArray(data))throw fail('Plugin inventory invalid.');
        for(const id of data)if(typeof id==='string'&&/^[\w-]{1,100}$/.test(id)&&ids.size<200)ids.add(id);
      } catch(e) {if(e.code!=='ENOENT')pluginInventoryWarning=e.message;}
    }
    pluginInventory=[...ids].map(id=>({id,support:id==='dataview'?'native-query-subset':'external-runtime-required'}));
  } catch(e) {pluginInventoryWarning=e.message;}

  return { files: vault.entries.size, notes: notes.length, nodes: g.nodes.length, edges: g.links.length, counts: { brokenLinks: missing.length, orphanNotes: orphans.length, staleFindings: staleFindings.length }, brokenLinks: missing.slice(0, 200), orphanNotes: orphans.slice(0, 200), staleFindings: staleFindings.slice(0, 200), truncated: missing.length > 200 || orphans.length > 200 || staleFindings.length > 200, warnings: vault.warnings.slice(0, 200), pluginInventory, pluginInventoryWarning, modelApiCalls: 0 };
}
export async function notePage(vault, { query = '', offset = 0, limit = 100 } = {}) {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) throw fail('Invalid pagination.');
  const records = await vault.list(query);
  return { total: records.length, notes: records.slice(offset, offset + limit).map(n => ({ id: n.id, title: n.title, type: n.type, tags: n.tags, aliases: n.aliases, revision: n.revision, modified: n.modified, snippet: n.snippet })), nextOffset: offset + limit < records.length ? offset + limit : null, epoch: vault.epoch };
}
