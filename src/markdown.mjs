import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { Lexer } from 'marked';

const hash = text => createHash('sha256').update(text).digest('hex');
const error = (message, status = 400) => Object.assign(new Error(message), { status });
const cleanTitle = text => String(text).replace(/!?(?:\[\[([^|\]]+)\|)?([^\]]+)\]\]/g, '$2').replace(/[*_`]/g, '').trim();
export const headingKey = text => cleanTitle(text).normalize('NFC').toLocaleLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-');
export function splitTarget(value) {
  const [rawTarget, ...fragments] = String(value).split('#');
  return { target: rawTarget.trim(), fragment: fragments.join('#'), block: fragments[0]?.startsWith('^') ? fragments[0].slice(1) : null };
}

export function parseNote(id, content) {
  let properties = {}, body = content, warning, bodyOffset = 0;
  const front = content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/);
  if (front) {
    bodyOffset = front[0].length; body = content.slice(bodyOffset);
    try { const p = parseYaml(front[1], { maxAliasCount: 30 }); if (p && typeof p === 'object' && !Array.isArray(p)) { JSON.stringify(p); properties = p; } }
    catch { warning = 'Frontmatter YAML tidak valid; isi asli tetap dipertahankan.'; }
  }
  const strings = value => (Array.isArray(value) ? value : typeof value === 'string' ? [value] : []).filter(x => typeof x === 'string').map(x => x.trim()).filter(Boolean);
  const links = [], headings = [], blocks = [], inlineTags = [], lineStarts = [0];
  for (let i = 0; i < content.length; i++) if (content[i] === '\n') lineStarts.push(i + 1);
  const lineAt = offset => { let lo = 0, hi = lineStarts.length; while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (lineStarts[mid] <= offset) lo = mid; else hi = mid; } return lo + 1; };
  // Mask workspace comments without moving source positions or changing line numbers.
  const source = body.replace(/%%[\s\S]*?%%/g, s => s.replace(/[^\r\n]/g, ' '));
  const tokens = Lexer.lex(source, { gfm: true });
  const addLink = (target, kind, embed, label, start, raw) => {
    if (typeof target !== 'string' || /^(?:[a-z][\w+.-]*:|\/\/)/i.test(target)) return;
    try { if (kind === 'markdown') target = decodeURIComponent(target); } catch { return; }
    const split = splitTarget(target);
    links.push({ ...split, label, kind, embed, start, end: start + raw.length, raw, line: lineAt(start), target: split.target || id });
  };
  function walk(list, base = bodyOffset, available = source) {
    let cursor = 0;
    for (const token of list || []) {
      const raw = token.raw ?? '', found = available.indexOf(raw, cursor), relative = found === -1 ? cursor : found, start = base + relative;
      cursor = relative + raw.length;
      if (['code', 'codespan', 'html', 'def', 'escape'].includes(token.type)) continue;
      if (token.type === 'heading') headings.push({ level: token.depth, text: cleanTitle(token.text), line: lineAt(start), startLine: lineAt(start), key: headingKey(token.text) });
      if (token.type === 'link' || token.type === 'image') addLink(token.href, 'markdown', token.type === 'image', token.text, start, raw);
      // Paragraph-level range includes preceding text for a Markdown block identifier.
      if (['paragraph', 'blockquote', 'list'].includes(token.type)) {
        const match = raw.match(/(?:^|\s)\^([A-Za-z0-9-]+)\s*$/);
        if (match) blocks.push({ id: match[1], startLine: lineAt(start), endLine: lineAt(start + raw.trimEnd().length - 1) });
      }
      if (token.tokens) walk(token.tokens, start, raw);
      else if (token.items) for (const item of token.items) { const at = raw.indexOf(item.raw); walk(item.tokens, start + Math.max(0, at), item.raw); }
      else if (token.type === 'table') {
        for (const row of [token.header, ...token.rows]) for (const cell of row) { const at = raw.indexOf(cell.text); walk(cell.tokens, start + Math.max(0, at), cell.text); }
      } else if (['text', 'heading'].includes(token.type)) {
        for (const m of raw.matchAll(/(!?)\[\[([^\]\n]+)\]\]/g)) { const [target, ...label] = m[2].split('|'); addLink(target, 'wiki', !!m[1], label.join('|') || undefined, start + m.index, m[0]); }
        for (const m of raw.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)) if (!/^\d+$/.test(m[1])) inlineTags.push(m[1]);
      }
    }
  }
  walk(tokens);
  const tags = [...new Set([...strings(properties.tags ?? properties.tag).flatMap(t => t.split(/[,\s]+/)).map(t => t.replace(/^#/, '')), ...inlineTags])].filter(Boolean);
  const uniqueLinks = [...new Map(links.map(l => [l.start + ':' + l.kind, l])).values()];
  return { id, title: String(properties.title || headings.find(h => h.level === 1)?.text || path.posix.basename(id, '.md')), properties, aliases: strings(properties.aliases ?? properties.alias), tags, links: uniqueLinks, headings, blocks, warning, body, bodyStartLine: lineAt(bodyOffset), content, revision: hash(content), words: body.trim().split(/\s+/u).filter(Boolean).length, type: 'note' };
}

export function sectionOf(note, selector = '') {
  const lines = note.content.split(/\r?\n/); let startLine = 1, endLine = lines.length;
  if (selector.startsWith('#')) selector = selector.slice(1);
  if (selector.startsWith('^')) {
    const matches = (note.blocks || []).filter(b => b.id === selector.slice(1));
    if (matches.length !== 1) throw error(matches.length ? 'Block ID ambigu.' : 'Block tidak ditemukan.', matches.length ? 409 : 404);
    ({ startLine, endLine } = matches[0]);
  } else if (selector) {
    const keys = selector.split('#').map(headingKey); let candidates = (note.headings || []).map((h, index) => ({ h, index })).filter(({ h }) => h.key === keys.at(-1) || headingKey(h.text) === keys.at(-1));
    if (keys.length > 1) candidates = candidates.filter(({ index }) => { const ancestry = []; for (const h of note.headings.slice(0, index + 1)) { while (ancestry.length && ancestry.at(-1).level >= h.level) ancestry.pop(); ancestry.push(h); } return ancestry.slice(-keys.length).map(h => h.key).join('#') === keys.join('#'); });
    if (candidates.length !== 1) throw error(candidates.length ? 'Heading ambigu; gunakan jalur heading lengkap.' : 'Heading tidak ditemukan.', candidates.length ? 409 : 404);
    const { h, index } = candidates[0]; startLine = h.line; endLine = note.headings.slice(index + 1).find(n => n.level <= h.level)?.line - 1 || lines.length;
  }
  return { path: note.id, revision: note.revision, selector, startLine, endLine, content: lines.slice(startLine - 1, endLine).join('\n') };
}
