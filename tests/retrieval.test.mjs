import test from 'node:test';
import assert from 'node:assert/strict';
import { Context, estimateTokens } from '../src/context.mjs';
import { parseNote } from '../src/markdown.mjs';

function fixture(files, options = {}) {
  const vault = { root: '/vault', epoch: 1, entries: new Map(), async refresh() {} };
  const put = (id, content) => { const note = parseNote(id, content); if (!id.endsWith('.md')) note.type = 'code'; vault.entries.set(id, note); vault.epoch++; return note; };
  for (const [id, content] of Object.entries(files)) put(id, content);
  const graph = { importStamp: '', nodes: [], links: [], async build() { return { nodes: [...vault.entries.values()].map(n => ({ id: n.id, source_file: n.id })).concat(this.nodes), links: this.links }; } };
  return { vault, graph, context: new Context(vault, graph, options), put };
}

test('retrieves multiple independent heading sections with exact line citations', async () => {
  const { context } = fixture({ 'Cache.md': '# Cache\n## Expiry\nRedis TTL is 300 seconds.\n\n## Publication\nRedis invalidation happens after publish.\n' });
  const result = await context.get('Redis TTL invalidation', 1500, { graphHops: 0 });
  assert.match(result.text, /300 seconds/); assert.match(result.text, /after publish/);
  assert.ok(result.citations.length >= 2); assert.deepEqual(result.sources, ['Cache.md']);
  assert.ok(result.citations.every(c => c.revision && c.chunkId && c.startLine <= c.endLine));
  assert.equal(result.evidence.answerVerified, false);
});

test('long-line evidence beyond character 1000 survives a small budget', async () => {
  const { context } = fixture({ 'Long.md': '# Deployment\n' + 'Unrelated filler '.repeat(100) + 'RollbackSentinel requires 17 approvals. ' + 'Other filler '.repeat(300) });
  const result = await context.get('RollbackSentinel approvals', 256);
  assert.match(result.text, /requires 17 approvals/); assert.ok(result.estimatedTokens <= 256);
  assert.equal(result.estimatedTokens, estimateTokens(result.text));
  assert.ok(result.citations.some(c => c.startLine === 2 && c.charStart > 1000));
});

test('camelCase and snake_case identifiers are searchable as words', async () => {
  const { context } = fixture({ 'cache.js': 'export function invalidateCacheEntry() {\n  return cache_expiry_seconds + 300;\n}\n' });
  const hits = await context.search('invalidate cache entry');
  assert.equal(hits[0].id, 'cache.js'); assert.ok(hits[0].queryCoverage > 0.8);
});

test('unknown questions abstain; related words never mark an answer verified', async () => {
  const { context } = fixture({ 'Cache.md': '# Cache\nRedis stores cached values.' });
  const absent = await context.get('quantum banana pancakes', 256);
  assert.equal(absent.evidence.status, 'no_match'); assert.deepEqual(absent.sources, []); assert.match(absent.text, /No matching/);
  const partial = await context.get('Redis encryption certification');
  assert.equal(partial.evidence.answerVerified, false); assert.ok(partial.evidence.bestQueryCoverage < 1);
});

test('session suppression is explicit, revision-aware, expiring and resettable', async () => {
  const { context, put } = fixture({ 'a.md': '# Cache\nRedis expiry is 300 seconds.' }, { sessionTtlMs: 100 });
  const first = await context.get('Redis expiry', 1000, { sessionId: 'one', delta: true });
  const duplicate = await context.get('Redis expiry', 1000, { sessionId: 'one', delta: true });
  assert.equal(duplicate.sources.length, 0); assert.equal(duplicate.evidence.status, 'already_delivered');
  assert.equal((await context.get('Redis expiry', 1000, { sessionId: 'one' })).sources.length, 1);
  put('a.md', '# Cache\nRedis expiry is 600 seconds.');
  const fresh = await context.get('Redis expiry', 1000, { sessionId: 'one', delta: true });
  assert.match(fresh.text, /600 seconds/); assert.notEqual(fresh.citations[0].chunkId, first.citations[0].chunkId);
  context.sessions.get('one').updated = Date.now() - 1000;
  assert.equal((await context.get('Redis expiry', 1000, { sessionId: 'one', delta: true })).sources.length, 1);
  assert.equal((await context.get('Redis expiry', 1000, { sessionId: 'one', delta: true, resetSession: true })).sources.length, 1);
  assert.equal((await context.get('Redis expiry', 1000, { knownChunks: [fresh.citations[0].chunkId] })).sources.length, 0);
});

test('unchanged parsing is reused and removed sources disappear from cached queries', async () => {
  const { context, put, vault } = fixture({ 'a.md': '# Redis\nExpiry 300.', 'b.md': '# Notes\nOther facts.' });
  await context.search('Redis'); const cached = context.parsed.get('a.md');
  put('b.md', '# Changed\nStill unrelated.'); await context.search('Redis');
  assert.equal(context.parsed.get('a.md'), cached); assert.equal(context.indexStats.reusedFiles, 1);
  vault.entries.delete('a.md'); vault.epoch++; assert.deepEqual(await context.search('Redis'), []);
});

test('validated imported graph sources expand with confidence and hop limits', async () => {
  const { context, graph, vault } = fixture({ 'a.md': '# Redis\nRedis expiry is 300.', 'b.md': '# Operations\nPublication clears stored values.', 'c.md': '# Other\nSecret operation details.' });
  graph.nodes = [
    { id: 'external:a', source_file: '/vault/a.md', source_location: 'L1-L2' },
    { id: 'external:b', source_file: 'b.md', source_location: 'L2', source_revision: vault.entries.get('b.md').revision },
    { id: 'external:c', source_file: 'c.md' },
    { id: 'external:escape', source_file: '../outside.md' }
  ];
  graph.links = [
    { source: 'external:a', target: 'external:b', relation: 'invalidated_by', confidence: 'INFERRED' },
    { source: 'external:a', target: 'external:c', relation: 'maybe', confidence: 'AMBIGUOUS' },
    { source: 'external:a', target: 'external:escape', confidence: 'EXTRACTED' },
    { source: 'external:b', target: 'external:c', confidence: 'EXTRACTED' }
  ];
  const result = await context.get('Redis expiry', 1000);
  assert.match(result.text, /Publication clears/); assert.doesNotMatch(result.text, /Secret operation/);
  assert.equal(result.receipts.find(r => r.path === 'b.md').graph.confidence, 'INFERRED');
  assert.ok(!(await context.get('Redis expiry', 1000, { minGraphConfidence: 0.8 })).sources.includes('b.md'));
  assert.ok((await context.get('Redis expiry', 1000, { graphHops: 2 })).sources.includes('c.md'));
  graph.nodes[1].source_revision = 'stale'; assert.ok(!(await context.get('Redis expiry')).sources.includes('b.md'));
});

test('duplicate excerpts are emitted once and Unicode/full metadata stay within injected token budget', async () => {
  const { context } = fixture({ 'a.md': '# Redis\nRedis expiry 300.', 'b.md': '# Redis\nRedis expiry 300.', '中文.md': '# 中文\n' + '中文资料 '.repeat(1200) });
  const dedup = await context.get('Redis expiry'); assert.equal(dedup.sources.length, 1); assert.equal(dedup.stats.deduplicatedChunks, 1);
  const countTokens = s => Math.ceil(Buffer.byteLength(s, 'utf8') / 2);
  const unicode = await context.get('中文资料', 256, { countTokens });
  assert.equal(unicode.estimatedTokens, countTokens(unicode.text)); assert.ok(unicode.estimatedTokens <= 256);
});

test('glossary expansion is explicit and sections/project map preserve navigation scope', async () => {
  const { context } = fixture({ 'Policy.md': '# Policy\n## Cache\nExpiry is 300 seconds.\n## Audit\nRetention is 14 days.' });
  assert.equal((await context.search('TTL')).length, 0);
  assert.ok((await context.search('TTL', 20, { glossary: { ttl: ['expiry'] } })).length);
  const section = await context.getSection('Policy.md', 'Audit'); assert.match(section.content, /14 days/); assert.doesNotMatch(section.content, /300 seconds/);
  const map = await context.projectMap(256); assert.match(map.text, /navigation/); assert.match(map.text, /Policy.md/); assert.ok(map.estimatedTokens <= 256);
});
