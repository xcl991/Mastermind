import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { Vault } from '../src/vault.mjs';
import { Graph } from '../src/graph.mjs';
import { Context, estimateTokens } from '../src/context.mjs';
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mastermind-benchmark-'));
async function bytes(root) { let total = 0; for (const entry of await fs.readdir(root, { withFileTypes: true })) { const p = path.join(root, entry.name); total += entry.isDirectory() ? await bytes(p) : (await fs.stat(p)).size; } return total; }
try {
  const count = 500;
  for (let i = 0; i < count; i++) await fs.writeFile(path.join(directory, `Note-${i}.md`), `# Design note ${i}\n\n[[Note-${(i + 1) % count}]]\n\n` + Array.from({ length: 70 }, (_, j) => `Section ${j}: implementation planning for component ${i}, local storage, maintenance, verification and documentation.`).join('\n'));
  await fs.appendFile(path.join(directory, 'Note-42.md'), '\n\n## Redis cache policy\nThe Redis TTL is exactly 300 seconds. Invalidate it after publication.\n');
  const start = performance.now(), vault = await new Vault(directory).init(), scanMs = performance.now() - start, graph = new Graph(vault), context = new Context(vault, graph);
  const graphStart = performance.now(), built = await graph.build(), graphMs = performance.now() - graphStart;
  const query = 'Redis TTL publication'; let queryStart = performance.now(); const result = await context.get(query, 2000), coldQueryMs = performance.now() - queryStart;
  queryStart = performance.now(); await context.get(query, 2000); const warmQueryMs = performance.now() - queryStart;
  const sourceFileTokens = result.sources.reduce((sum, id) => sum + estimateTokens(vault.entries.get(id).content), 0);
  let productionBytes = 0; for (const dir of ['src', 'public', 'node_modules/marked', 'node_modules/yaml', 'node_modules/dompurify', 'node_modules/@types/trusted-types']) productionBytes += await bytes(dir);
  const report = { measuredAt: new Date().toISOString(), environment: { platform: process.platform, arch: process.arch, node: process.version }, fixture: '500 synthetic Markdown notes, 70 lines each, one planted Redis TTL fact; no LLM evaluation', files: count, graphNodes: built.nodes.length, graphEdges: built.links.length, scanMs: +scanMs.toFixed(2), graphMs: +graphMs.toFixed(2), coldQueryMs: +coldQueryMs.toFixed(2), warmQueryMs: +warmQueryMs.toFixed(2), processRssMiB: +(process.memoryUsage().rss / 1048576).toFixed(2), sourceAndProductionDependenciesMiB: +(productionBytes / 1048576).toFixed(2), context: { query, budget: result.budget, sources: result.sources, estimatedTokens: result.estimatedTokens, fullSelectedSourceFilesEstimatedTokens: sourceFileTokens, fullCorpusEstimatedTokens: result.fullCorpusEstimatedTokens, reductionVersusSelectedFullFilesPercent: +((1 - result.estimatedTokens / sourceFileTokens) * 100).toFixed(2), retainedExpectedFact: result.text.includes('300 seconds'), estimator: result.estimator }, limitations: ['Synthetic workload, not measured API billing or a production retrieval benchmark.', 'No comparative performance benchmark against other applications.', 'Process RSS excludes browser and Node executable installation.', 'Disk measurement excludes development dependencies, evidence, research source, and vault.', 'Lexical retrieval does not establish semantic recall for arbitrary questions.'] };
  await fs.mkdir('artifacts', { recursive: true }); await fs.writeFile('artifacts/benchmark.json', JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2));
} finally { await fs.rm(directory, { recursive: true, force: true }); }
