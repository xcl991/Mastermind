import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Vault, parseNote } from '../src/vault.mjs';
import { Graph, validateGraph } from '../src/graph.mjs';
import { Context, estimateTokens } from '../src/context.mjs';
async function fixture(t) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mastermind-test-')); t.after(() => fs.rm(root, { recursive: true, force: true })); const vault = await new Vault(root).init(), graph = new Graph(vault); return { root, vault, graph, context: new Context(vault, graph) }; }
test('Markdown frontmatter, aliases and links survive round trip', async t => {
  const { vault } = await fixture(t), content = '---\ntags: [alpha, beta]\naliases: [Second brain]\ncustom: keep me\n---\n# Test\n[[Folder/Other#Heading|Other]] #inline\n[Link](Folder/Other.md)\n```js\n[[not a link]]\n```\n';
  const created = await vault.write('Folder/Test.md', content, null); assert.equal((await vault.read(created.id)).content, content); assert.deepEqual(created.tags, ['alpha', 'beta', 'inline']); assert.equal(created.links.length, 2); assert.equal(created.properties.custom, 'keep me');
  assert.equal(parseNote('bad.md', '---\nx: [\n---\n# Still readable').warning.includes('YAML'), true);
});
test('revision conflicts never overwrite existing content; updates keep history', async t => {
  const { vault, root } = await fixture(t); const a = await vault.write('a.md', '# Original', null);
  await assert.rejects(vault.write('a.md', '# Replacement', null), /Konflik/);
  await fs.writeFile(path.join(root, 'a.md'), '# External edit');
  await assert.rejects(vault.write('a.md', '# Stale', a.revision), /Konflik/);
  const b = await vault.read('a.md'); await vault.write('a.md', '# Updated', b.revision);
  const historyFolders = await fs.readdir(path.join(root, '.mastermind/history')); const history = await fs.readdir(path.join(root, '.mastermind/history', historyFolders[0])); assert.equal(await fs.readFile(path.join(root, '.mastermind/history', historyFolders[0], history[0]), 'utf8'), '# External edit');
});
test('separate processes cannot both update the same revision', async t => {
  const { vault, root } = await fixture(t), a = await vault.write('a.md', 'old', null), second = await new Vault(root).init();
  const results = await Promise.allSettled([vault.write('a.md', 'first', a.revision), second.write('a.md', 'second', a.revision)]); assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
});
test('traversal, internal paths, non-Markdown writes and symlinks are rejected', async t => {
  const { vault, root } = await fixture(t);
  for (const id of ['../outside.md', '/outside.md', '.editor/config.md', 'a/../../x.md', 'x\\y.md', 'CON.md']) await assert.rejects(vault.write(id, 'x', null));
  await assert.rejects(vault.write('program.js', 'x', null));
  await fs.symlink(os.tmpdir(), path.join(root, 'escape')); await assert.rejects(vault.write('escape/x.md', 'x', null), /Symlink/);
});
test('graph resolves relative links, aliases, unique names, preserves unresolved ambiguity', async t => {
  const { vault, graph } = await fixture(t);
  await vault.write('A.md', '# A\n[[B]] [[Alias]] [[Duplicate]]\n[relative](Folder/C.md)', null);
  await vault.write('Folder/B.md', '# B\n[[A]]', null); await vault.write('Folder/C.md', '---\naliases: [Alias]\n---\n# C', null);
  await vault.write('one/Duplicate.md', '# One', null); await vault.write('two/Duplicate.md', '# Two', null);
  const g = await graph.build(); assert.ok(g.links.some(e => e.source === 'A.md' && e.target === 'Folder/B.md')); assert.ok(g.links.some(e => e.target === 'Folder/C.md')); assert.ok(g.nodes.some(n => n.id === 'missing:Duplicate'));
  assert.deepEqual((await graph.shortestPath('Folder/B.md', 'Folder/C.md')).path, ['Folder/B.md', 'A.md', 'Folder/C.md']);
  assert.equal((await graph.neighbors('A.md')).incoming.length, 1);
});
test('Graph import preserves original metadata and _src direction; export canvas is connected', async t => {
  const { graph } = await fixture(t), data = { directed: false, graph: { schema_version: 1, source_version: 'test', hyperedges: [] }, nodes: [{ id: 'a', label: 'A', custom: 42 }, { id: 'b', label: 'B' }], links: [{ source: 'a', target: 'b', _src: 'b', _tgt: 'a', confidence: 'INFERRED', relation: 'uses', rationale: 'Evidence' }] };
  await graph.import(data); assert.deepEqual(await graph.imported(), data); const g = await graph.build(); assert.equal(g.links[0].source, 'external:b'); assert.equal(g.links[0].target, 'external:a'); assert.equal(g.links[0].rationale, 'Evidence'); assert.equal(g.nodes[0].custom, 42);
  const canvas = await graph.canvas(); assert.equal(canvas.edges[0].fromNode, 'n1');
  assert.throws(() => validateGraph({ nodes: [{ id: 'a' }, { id: 'a' }], links: [] }), /unik/);
  assert.throws(() => validateGraph({ nodes: [], links: [{ source: 'missing', target: 'missing' }] }), /tidak ada/);
  assert.throws(() => validateGraph({ nodes: [], links: [], graph: { schema_version: 99 } }), /schema/);
});
test('incremental refresh catches external writes and import from a second instance', async t => {
  const { vault, graph, root } = await fixture(t); await vault.write('a.md', '# A', null); await graph.build();
  await fs.writeFile(path.join(root, 'a.md'), '# New\n[[B]]'); await vault.refresh(true); assert.ok((await graph.build()).nodes.some(n => n.id === 'missing:B'));
  const other = new Graph(await new Vault(root).init()); await other.import({ nodes: [{ id: 'external' }], links: [] }); assert.ok((await graph.build()).nodes.some(n => n.id === 'external:external'));
});
test('trash retains original bytes and metadata', async t => {
  const { vault, root } = await fixture(t), note = await vault.write('a.md', '# Keep this', null), result = await vault.trash(note.id, note.revision);
  await assert.rejects(vault.read(note.id), /tidak ditemukan/); assert.equal(await fs.readFile(path.join(root, '.mastermind/trash', result.trashId, 'note.md'), 'utf8'), note.content);
});
test('context returns relevant cited facts within budget; no-match is explicit', async t => {
  const { vault, context } = await fixture(t);
  await vault.write('Architecture.md', '# Caching\nRedis cache expires after 300 seconds.\n[[Operations]]\n' + 'General architecture notes.\n'.repeat(300), null);
  await vault.write('Operations.md', '# Operations\nCache invalidation occurs after publication.\n', null);
  await vault.write('Unrelated.md', '# Recipes\n' + 'Make banana pancakes.\n'.repeat(300), null);
  const c = await context.get('Redis cache expires', 1000); assert.match(c.text, /300 seconds/); assert.match(c.text, /Architecture.md:1-/); assert.ok(c.estimatedTokens <= 1000); assert.ok(c.estimatedTokens < c.fullCorpusEstimatedTokens); assert.equal(estimateTokens(c.text), c.estimatedTokens);
  const missing = await context.get('qzxvjkl', 256); assert.equal(missing.sources.length, 0); assert.match(missing.text, /No matching/);
});
test('Unicode queries and minimum budgets remain bounded', async t => {
  const { vault, context } = await fixture(t); await vault.write('Unicode.md', '# 中文\n' + '中文数据资料 '.repeat(1500), null);
  for (const budget of [256, 1000, 2000]) { const c = await context.get('中文'.repeat(120), budget); assert.ok(c.estimatedTokens <= budget, `${c.estimatedTokens} > ${budget}`); }
});
