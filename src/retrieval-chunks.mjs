import { createHash } from 'node:crypto';
export const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 20);
const STOP = new Set('the a an and or of to in on for is are was were be been this that these those what which who how why when where does do did can could should would please tell me about with from as at by it its saya kamu apa apakah bagaimana yang dan atau di ke dari untuk adalah dengan berapa kapan dimana jelaskan tolong'.split(' '));
export function words(value) {
  const raw = String(value).normalize('NFKC');
  const split = raw.replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').replace(/[_/.-]/g, ' ');
  return [...(raw.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) || []), ...(split.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [])];
}
export function queryTerms(query, glossary = {}) {
  const base = [...new Set(words(String(query).slice(0, 4096)))].filter(w => !STOP.has(w)).slice(0, 40);
  const extra = base.flatMap(w => Array.isArray(glossary[w]) ? glossary[w] : typeof glossary[w] === 'string' ? [glossary[w]] : []).flatMap(words);
  return [...new Set([...base, ...extra])].slice(0, 64);
}
export function chunksOf(note) {
  const lines = note.content.split(/\r?\n/), chunks = []; let pending = [], start = 1, heading = '';
  const add = (text, first, last, charStart = 0, charEnd) => {
    if (!text.trim()) return;
    const counts = new Map(); for (const t of words(text)) counts.set(t, (counts.get(t) || 0) + 1);
    chunks.push({ id: note.id, title: note.title, revision: note.revision, chunkId: digest(`${note.id}\0${note.revision}\0${first}:${last}:${charStart}`), startLine: first, endLine: last, charStart, ...(charEnd == null ? {} : { charEnd }), heading, excerpt: text, counts, length: [...counts.values()].reduce((a, b) => a + b, 0) });
  };
  const flush = () => { if (pending.length) add(pending.join('\n'), start, start + pending.length - 1); pending = []; };
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], h = !fenced && note.type !== 'code' && /^(#{1,6})\s+(.+)/.exec(line);
    if (h) { flush(); heading = h[2]; }
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (line.length > 2200) {
      flush();
      for (let at = 0; at < line.length; at += 1880) add(line.slice(at, at + 2000), i + 1, i + 1, at, Math.min(line.length, at + 2000));
      continue;
    }
    if (pending.length && (pending.length >= (note.type === 'code' ? 36 : 48) || pending.join('\n').length + line.length > 2200 || (!fenced && !line.trim() && pending.join('\n').length >= 500))) flush();
    if (!pending.length) start = i + 1;
    pending.push(line);
  }
  flush(); return chunks;
}
// Keep the query-bearing line even when the evidence occurs late in a long line.
export function excerptOf(chunk, terms, maxChars = 1800) {
  if (chunk.excerpt.length <= maxChars) return { ...chunk, clipped: false };
  const lines = chunk.excerpt.split('\n'); let best = 0, score = -1;
  for (let i = 0; i < lines.length; i++) { const n = terms.filter(t => lines[i].toLowerCase().includes(t)).length; if (n > score) { score = n; best = i; } }
  const line = lines[best];
  if (line.length > maxChars) {
    const lower = line.toLowerCase(); const positions = terms.map(t => lower.indexOf(t)).filter(n => n >= 0);
    const focus = positions.length ? Math.min(...positions) : 0, start = Math.min(Math.max(0, focus - Math.floor(maxChars / 4)), Math.max(0, line.length - maxChars));
    return { ...chunk, startLine: chunk.startLine + best, endLine: chunk.startLine + best, charStart: (best === 0 ? chunk.charStart : 0) + start, charEnd: (best === 0 ? chunk.charStart : 0) + start + maxChars, excerpt: line.slice(start, start + maxChars), clipped: true };
  }
  let first = best, last = best, size = line.length;
  while (size < maxChars) {
    if (first > 0 && size + lines[first - 1].length + 1 <= maxChars) { first--; size += lines[first].length + 1; }
    else if (last + 1 < lines.length && size + lines[last + 1].length + 1 <= maxChars) { last++; size += lines[last].length + 1; }
    else break;
  }
  return { ...chunk, startLine: chunk.startLine + first, endLine: chunk.startLine + last, charStart: 0, excerpt: lines.slice(first, last + 1).join('\n'), clipped: true };
}
