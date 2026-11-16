import { Marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';
import katex from '/vendor/katex.js';
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const markdown = new Marked({ gfm: true, breaks: false });
const math = (value, displayMode) => {
  try { return katex.renderToString(value.slice(0, 8000), { displayMode, throwOnError: false, trust: false, strict: 'warn', maxExpand: 200, maxSize: 20, output: 'htmlAndMathml' }); }
  catch { return `<code>${escape(value)}</code>`; }
};
markdown.use({ extensions: [
  { name:'workspaceCommentBlock',level:'block',start:src=>src.indexOf('%%'),tokenizer(src){const m=/^%%[\s\S]*?%%(?:\n|$)/.exec(src);if(m)return {type:'workspaceCommentBlock',raw:m[0]};},renderer(){return '';} },
  { name:'workspaceComment',level:'inline',start:src=>src.indexOf('%%'),tokenizer(src){const m=/^%%[\s\S]*?%%/.exec(src);if(m)return {type:'workspaceComment',raw:m[0]};},renderer(){return '';} },
  { name: 'wikilink', level: 'inline', start: src => src.indexOf('[['), tokenizer(src) { const m = /^(!?)\[\[([^\]\n]+)\]\]/.exec(src); if (m) return { type: 'wikilink', raw: m[0], target: m[2].split('|')[0], label: m[2].split('|')[1] || m[2], embed: !!m[1] }; }, renderer(t) { return `<a href="#" data-wiki="${escape(t.target)}"${t.embed ? ' data-transclude="true"' : ''}>${escape(t.label)}</a>`; } },
  { name: 'highlight', level: 'inline', start: src => src.indexOf('=='), tokenizer(src) { const m = /^==([^=\n]+)==/.exec(src); if (m) return { type: 'highlight', raw: m[0], value: m[1] }; }, renderer(t) { return `<mark>${escape(t.value)}</mark>`; } },
  { name: 'inlineMath', level: 'inline', start: src => src.indexOf('$'), tokenizer(src) { const m = /^\$(?!\s|\$)([^\n$]+?)(?<!\s)\$(?!\d)/.exec(src); if (m) return { type: 'inlineMath', raw: m[0], value: m[1] }; }, renderer(t) { return math(t.value, false); } },
  { name: 'blockMath', level: 'block', start: src => src.indexOf('$$'), tokenizer(src) { const m = /^\$\$\s*\n?([\s\S]+?)\n?\$\$(?:\n|$)/.exec(src); if (m) return { type: 'blockMath', raw: m[0], value: m[1] }; }, renderer(t) { return math(t.value, true); } }
], renderer: { html(t) { return DOMPurify.sanitize(t.text, { FORBID_TAGS: ['style','script'], FORBID_ATTR: ['style'] }); }, code(t) { const lang = (t.lang || '').split(/\s/)[0].toLowerCase(); if (['dataview', 'base'].includes(lang)) return `<div data-query-kind="${lang}" data-query="${escape(t.text)}">Memuat tampilan data…</div>`; if (lang === 'dataviewjs') return '<aside class="render-notice">Mastermind tidak menjalankan DataviewJS. Gunakan query dataview deklaratif.</aside>'; return `<pre><code>${escape(t.text)}</code></pre>`; } } });

function clean(content) {
  const html = markdown.parse(content.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/, ''));
  // KaTeX emits inline layout styles. Remove author HTML styles before retaining only KaTeX layout styles.
  const safe = DOMPurify.sanitize(html, { USE_PROFILES: { html: true, mathMl: true }, FORBID_ATTR: ['srcset','autoplay'], FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'object', 'embed'] });
  const template = document.createElement('template'); template.innerHTML = safe;
  template.content.querySelectorAll('[style]').forEach(node => { if (!node.closest('.katex')) node.removeAttribute('style'); });
  return template.innerHTML;
}
export function renderQueryResult(container, result, { open, toggleTask, readOnly = false } = {}) {
  container.replaceChildren(); const caption = document.createElement('p'); caption.className = 'query-caption'; caption.textContent = `${result.total} hasil${result.truncated ? ' · hasil dibatasi' : ''}`; container.append(caption);
  const columns=(result.columns||[]).map((c,i)=>({...c,index:i})).filter(c=>c.key!=='file');
  const table = document.createElement('table'), head = document.createElement('tr');
  for (const label of ['Sumber', ...columns.map(c => c.label || c.key)]) { const cell = document.createElement('th'); cell.textContent = label; head.append(cell); } table.append(head);
  for (const row of result.rows || []) {
    const tr = document.createElement('tr'), source = document.createElement('td'), link = document.createElement('button'); link.className = 'text-button'; link.textContent = row.path; link.onclick = () => open?.(row.path); source.append(link); tr.append(source);
    if (result.type === 'TASK' && toggleTask) { const box = document.createElement('input'); box.type = 'checkbox'; box.checked = Boolean(row.task?.completed); box.disabled = readOnly; box.setAttribute('aria-label', 'Selesaikan tugas'); box.onchange = async () => { box.disabled = true; try { await toggleTask(row, box.checked); } catch (e) { box.checked = !box.checked; caption.textContent = e.message; } finally { box.disabled = readOnly; } }; source.prepend(box); }
    for (const value of columns.map(c=>row.values?.[c.index])) { const cell = document.createElement('td'); cell.textContent = value == null ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value); tr.append(cell); } table.append(tr);
  }
  const wrap = document.createElement('div'); wrap.className = 'table-scroll'; wrap.append(table); container.append(wrap);
  for (const message of result.warnings || []) { const warning = document.createElement('p'); warning.className = 'muted'; warning.textContent = message; container.append(warning); }
}
export async function renderMarkdown(container, content, { path, api, follow, open, generation, valid = () => true, depth = 0, visited = new Set(), state = { embeds: 0, queries: 0 }, readOnly = false, toggleTask } = {}) {
  if(!valid(generation))return;
  container.innerHTML = clean(content);
  container.querySelectorAll('blockquote').forEach(quote => {
    const first = quote.querySelector(':scope > p'); if (!first) return;
    const match = /^\[!([\w-]+)\]([+-])?\s*([^\n]*)/.exec(first.textContent); if (!match) return;
    const callout = document.createElement(match[2] ? 'details' : 'aside'); callout.className = 'callout'; callout.dataset.type = match[1]; if (match[2] === '+') callout.open = true;
    const title = document.createElement(match[2] ? 'summary' : 'strong'); title.textContent = match[3] || match[1]; callout.append(title); first.textContent = first.textContent.slice(match[0].length).trim(); while (quote.firstChild) callout.append(quote.firstChild); quote.replaceWith(callout);
  });
  container.querySelectorAll('a:not([data-transclude])').forEach(a => {
    const href = a.getAttribute('href') || ''; if (a.dataset.wiki) a.onclick = e => { e.preventDefault(); follow(a.dataset.wiki, path, 'wiki'); };
    else if (/^https?:\/\//i.test(href)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    else a.onclick = e => { e.preventDefault(); if (!/^[a-z][\w+.-]*:/i.test(href)) { try { follow(decodeURIComponent(href), path, 'markdown'); } catch {} } };
  });
  container.querySelectorAll('[autoplay]').forEach(node=>node.removeAttribute('autoplay'));
  container.querySelectorAll('img').forEach(img => { img.removeAttribute('srcset'); const value = img.getAttribute('src') || ''; if (/^[a-z]+:/i.test(value)) { if (!value.startsWith('data:image/')) { img.removeAttribute('src'); img.alt = 'Gambar eksternal: ' + value; } return; } const base = path.split('/').slice(0, -1).join('/'); try { const id = decodeURIComponent(new URL(value, `http://local/${base ? base + '/' : ''}`).pathname.slice(1)); img.src = '/api/asset?path=' + encodeURIComponent(id); } catch { img.removeAttribute('src'); img.alt='Path gambar tidak valid'; } });
  for (const a of [...container.querySelectorAll('[data-transclude]')]) {
    if(!valid(generation))return;
    const target = a.dataset.wiki, slot = document.createElement('section'); slot.className = 'note-embed'; a.replaceWith(slot);
    if (depth >= 3 || ++state.embeds > 12) { slot.textContent = 'Batas embed tercapai. Buka sumber untuk melanjutkan.'; continue; }
    try {
      const embedded = await api('/api/embed?from=' + encodeURIComponent(path) + '&target=' + encodeURIComponent(target)); if (!valid(generation)) return;
      const header = document.createElement('button'); header.className = 'embed-source'; header.textContent = embedded.path; header.onclick = () => embedded.kind === 'note' || embedded.kind === 'base' ? open(embedded.path) : window.open(embedded.url, '_blank', 'noopener'); slot.append(header);
      if (embedded.kind === 'asset') { const type = embedded.mime.startsWith('image/') ? 'img' : embedded.mime.startsWith('audio/') ? 'audio' : embedded.mime.startsWith('video/') ? 'video' : null; if (type) { const media = document.createElement(type); media.src = embedded.url; if (type !== 'img') { media.controls = true; media.preload = 'metadata'; } slot.append(media); } else { const label = document.createElement('p'); label.textContent = 'Buka PDF melalui tombol sumber.'; slot.append(label); } continue; }
      const key = embedded.path + '#' + (embedded.selector || ''); if (visited.has(key)) { slot.append('Embed berulang dihentikan.'); continue; }
      const body = document.createElement('div'); slot.append(body);
      if (embedded.kind === 'base') { const result=await api('/api/base', { method:'POST',body:{content:embedded.content,view:embedded.selector||undefined} }); if(!valid(generation))return;renderQueryResult(body,result,{open,toggleTask,readOnly}); }
      else await renderMarkdown(body, embedded.content, { path: embedded.path, api, follow, open, generation, valid, depth: depth + 1, visited: new Set([...visited, key]), state, readOnly, toggleTask });
      if(!valid(generation))return;
      if (embedded.truncated) slot.append('Cuplikan dibatasi. Buka sumber lengkap.');
    } catch (e) { slot.textContent = `Embed: ${e.message}`; }
  }
  for (const slot of container.querySelectorAll('[data-query-kind]')) {
    if(!valid(generation))return;
    if (++state.queries > 8) { slot.textContent = 'Batas query inline tercapai.'; continue; }
    try { const kind = slot.dataset.queryKind, input = slot.dataset.query; delete slot.dataset.queryKind; const result = await api(kind === 'base' ? '/api/base' : '/api/query', { method: 'POST', body: kind === 'base' ? { content: input } : { query: input } }); if (!valid(generation)) return; renderQueryResult(slot, result, { open, toggleTask, readOnly }); } catch (e) { slot.textContent = `Query: ${e.message}`; }
  }
}
