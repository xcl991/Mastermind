import { stringify } from 'yaml';
import { fail } from './vault.mjs';
export async function saveFinding(vault, { path, title, summary, evidence, expectedRevision }) {
  vault.assertWritable();
  if (!Array.isArray(evidence) || !evidence.length || evidence.length > 12) throw fail('Provide 1–12 source receipts.');
  if (typeof title !== 'string' || title.length > 240 || typeof summary !== 'string' || summary.length > 12000) throw fail('Invalid title/summary.');
  const receipts = [];
  for (const item of evidence) {
    if (item.path === path) throw fail('Finding cannot cite itself.');
    const source = await vault.read(item.path);
    if (source.revision !== item.revision) throw fail('Source changed: ' + item.path, 409);
    const lines = source.content.split(/\r?\n/), startLine = item.startLine, endLine = item.endLine;
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine > lines.length || endLine - startLine > 199) throw fail('Invalid evidence range.');
    receipts.push({ path: source.id, revision: source.revision, startLine, endLine });
  }
  const content = `---\n${stringify({ title, tags: ['mastermind-finding'], mastermind_evidence: receipts, evidence_status: 'source-linked; summary is author-provided, not automatically verified' })}---\n# ${title.replace(/[\r\n]/g, ' ')}\n\n${summary}\n\n## Sources\n\n${receipts.map(r => `- [[${r.path}]]:${r.startLine}-${r.endLine} · revision ${r.revision}`).join('\n')}\n`;
  const note = await vault.write(path, content, expectedRevision);
  return { path: note.id, revision: note.revision, evidence: receipts, answerVerified: false };
}
export function findingFreshness(note, entries) {
  const receipts = note.properties?.mastermind_evidence;
  if (!receipts) return { status: 'ordinary-source' };
  if (!Array.isArray(receipts) || !receipts.length) return { status: 'stale', reason: 'invalid receipts' };
  const stale = receipts.filter(r => !r || typeof r.path !== 'string' || entries.get(r.path)?.revision !== r.revision);
  return stale.length ? { status: 'stale', paths: stale.map(r => r?.path) } : { status: 'source-current', answerVerified: false };
}
