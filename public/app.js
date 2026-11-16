import {renderMarkdown} from './markdown-view.js';
import {setupWorkspace} from './workspace-ui.js';
import {setupCanvas} from './canvas-editor.js';
import { createEditor } from './editor.bundle.js';
import { GraphView } from './graph-view.js';
const $ = id => document.getElementById(id);
const paths = { file: 'M6 3h8l4 4v14H6zM14 3v5h5M9 12h6M9 16h6', folder: 'M3 6h7l2 3h9v11H3z', graph: 'M6 6l12 3M6 6l3 13M18 9l-9 10M4 4h4v4H4zM16 7h4v4h-4zM7 17h4v4H7z', search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0', plus: 'M12 5v14M5 12h14', calendar: 'M4 5h16v16H4zM8 3v4M16 3v4M4 11h16', spark: 'M12 2l3 7 7 3-7 3-3 7-3-7-7-3 7-3z', settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2', upload: 'M12 16V3M7 8l5-5 5 5M4 16v5h16v-5', download: 'M12 3v13M7 11l5 5 5-5M4 17v4h16v-4', plug: 'M8 3v5M16 3v5M6 8h12v5a6 6 0 0 1-12 0zM12 19v3', layers: 'M3 7l9-5 9 5-9 5zM3 12l9 5 9-5M3 17l9 5 9-5', refresh: 'M20 7v5h-5M4 17v-5h5M5 8a8 8 0 0 1 13-4l2 3M4 17l2 3a8 8 0 0 0 13-4', book: 'M12 5v16M12 5C8 2 3 3 3 3v16s5-1 9 2c4-3 9-2 9-2V3s-5-1-9 2', split: 'M3 4h18v16H3zM12 4v16', edit: 'M14 5l5 5M4 20l5-1L21 7l-5-5L4 14z', trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7', expand: 'M3 9V3h6M15 3h6v6M21 15v6h-6M9 21H3v-6', menu: 'M3 6h18M3 12h18M3 18h18', route: 'M6 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4M18 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4M6 8v6h12v2', copy: 'M8 8h13v13H8zM16 8V3H3v13h5' };
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.file}"/></svg>`;
document.querySelectorAll('[data-icon]').forEach(e => e.innerHTML = icon(e.dataset.icon));
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let workspaceId = '', readOnly = false;
let notes = [], visibleNotes = [], current = null, graph = { nodes: [], links: [] }, activeView = 'notes', mode = 'read', saveTimer, saving = null, contextText = '', configText = '', loading = false;
const toast = message => { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('toast').hidden = true, 6500); };
const run = fn => async event => { try { await fn(event); } catch (e) { toast(e.message); } };
async function api(url, options) { const response = await fetch(url, options ? { ...options, headers: { 'Content-Type': 'application/json', 'X-Mastermind': 'local' }, body: options.body === undefined ? undefined : JSON.stringify(options.body) } : undefined); const result = await response.json(); if (!response.ok) throw Object.assign(new Error(result.error || 'Request gagal'), { status: response.status }); return result; }
const editor = createEditor($('code-editor'), value => { $('editor').value = value; $('editor').oninput?.(); }, () => notes.filter(n => n.type === 'note').map(n => n.id.replace(/\.md$/, '')));
const loadDraft = id => { try { return JSON.parse(localStorage.getItem(draftKey(id)) || 'null'); } catch { return null; } };
const dropDraft = id => { try { localStorage.removeItem(draftKey(id)); } catch {} };
const draftKey = id => `mastermind:draft:${workspaceId}:${id}`;
function keepDraft() { if (!current || readOnly || current.type !== 'note') return; try { localStorage.setItem(draftKey(current.id), JSON.stringify({ content: $('editor').value, revision: current.revision, updated: Date.now() })); } catch { toast('Draft browser tidak dapat disimpan; unduh perubahan Anda.'); } }
function setContent(content) { $('editor').value = content; editor.set(content, readOnly || current?.type !== 'note'); }
function recoveryDialog(title, entries) { $('recovery-title').textContent = title; $('recovery-list').replaceChildren(); for (const entry of entries) { const row = document.createElement('div'), label = document.createElement('p'), button = document.createElement('button'); label.textContent = entry.label; button.textContent = entry.action || 'Pulihkan'; button.onclick = run(entry.run); row.append(label, button); $('recovery-list').append(row); } if (!entries.length) $('recovery-list').textContent = 'Belum ada data pemulihan.'; $('recovery-dialog').showModal(); }
function resolve(target, from = current?.id || '', kind = 'wiki') {
  target = target.split('#')[0]; if (!target) return from;
  const suffix = /\.[a-z0-9]+$/i.test(target) ? target : target + '.md';
  const dir = from.split('/').slice(0, -1).join('/'), relative = new URL(suffix, `http://local/${dir ? dir + '/' : ''}`).pathname.slice(1);
  const direct = (kind === 'markdown' ? [relative, suffix] : [suffix, relative]).find(id => notes.some(n => n.id === id)); if (direct) return direct;
  const term = target.replace(/\.md$/, '').toLowerCase(), matches = notes.filter(n => n.id.split('/').pop().replace(/\.md$/, '').toLowerCase() === term || n.aliases?.some(a => a.toLowerCase() === term)); return matches.length === 1 ? matches[0].id : null;
}
let previewGeneration=0;
function renderPreview() {
  if(!current)return; const content=$('editor').value,generation=++previewGeneration,id=current.id;
  if(current.type!=='note')$('preview').innerHTML=`<h1>${esc(current.title)}</h1><pre><code>${esc(content)}</code></pre>`;
  else renderMarkdown($('preview'),content,{path:id,api,generation,valid:g=>g===previewGeneration,readOnly,open:openNote,follow:(target,from,kind)=>follow(target,kind,from).catch(e=>toast(e.message)),toggleTask:async(row,completed)=>{await save();await api('/api/task',{method:'PUT',body:{path:row.path,line:row.line,completed,expectedRevision:row.revision}});if(current?.id===row.path){current=null;await openNote(row.path);}else renderPreview();}}).then(()=>{if(generation===previewGeneration){$('preview').querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((h,i)=>h.id='heading-'+i);renderInspector();}}).catch(e=>toast(e.message));
  $('word-count').textContent=`${content.trim().split(/\s+/u).filter(Boolean).length} kata · ${content.length.toLocaleString('id-ID')} karakter`;
}
async function follow(target, kind = 'wiki', from = current?.id || '') {
  const result = await api('/api/resolve?target=' + encodeURIComponent(target) + '&from=' + encodeURIComponent(from) + '&kind=' + kind);
  if (result.path) { await openNote(result.path); if (result.section) { editor.line(result.section.startLine); const heading = result.selector.split('#').at(-1); [...$('preview').querySelectorAll('h1,h2,h3,h4,h5,h6')].find(h => h.textContent.toLowerCase() === heading.toLowerCase())?.scrollIntoView(); } }
  else if (!readOnly) newDialog(target.split('#')[0].replace(/\.md$/, '') + '.md');

}
function files() {
  const filtered = visibleNotes;
  const list = $('file-list'); list.replaceChildren(); let lastFolder;
  for (const n of filtered) {
    const folder = n.id.includes('/') ? n.id.split('/').slice(0, -1).join('/') : '';
    if (folder && folder !== lastFolder) { const label = document.createElement('div'); label.className = 'folder-label'; label.innerHTML = icon('folder') + esc(folder); list.append(label); } lastFolder = folder;
    const b = document.createElement('button'); b.className = 'file-item' + (current?.id === n.id ? ' active' : ''); b.title = n.id; b.innerHTML = icon('file') + `<span>${esc(n.title)}</span>`; b.onclick = run(() => openNote(n.id)); list.append(b);
  }
  if (!filtered.length) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'Tidak ada catatan ditemukan.'; list.append(p); }
  $('note-count').textContent = String(totalNotes); if(nextOffset!==null){const more=document.createElement('button');more.textContent='Muat lebih banyak';more.onclick=run(async()=>{const page=await api('/api/notes-page?q='+encodeURIComponent($('search').value)+'&offset='+nextOffset+'&limit=100');visibleNotes.push(...page.notes);notes=[...new Map([...notes,...page.notes].map(n=>[n.id,n])).values()];nextOffset=page.nextOffset;files();});list.append(more);}
}
let refreshSequence = 0, totalNotes=0, nextOffset=null, graphEpoch=-1;
async function refresh() { const sequence=++refreshSequence,page=await api('/api/notes-page?q='+encodeURIComponent($('search').value)+'&limit=100');if(sequence!==refreshSequence)return;notes=page.notes;visibleNotes=page.notes;totalNotes=page.total;nextOffset=page.nextOffset;files();if(current)await renderLocalGraph();if(activeView==='graph'){await loadGraph();renderGraph();} }
let graphSequence=0;async function loadGraph(){const seq=++graphSequence,result=await api('/api/graph-view?q='+encodeURIComponent($('graph-search').value)+'&type='+$('graph-filter').value);if(seq===graphSequence)graph=result;}
async function renderLocalGraph(){if(!current)return;const local=await api('/api/local-graph?path='+encodeURIComponent(current.id));if(activeView!=='graph')graph=local;renderInspector();}
async function save() {
  clearTimeout(saveTimer); if (saving) await saving;
  if (!current || readOnly || current.type !== 'note' || $('editor').value === current.content) return;
  const id = current.id, content = $('editor').value, expectedRevision = current.revision;
  $('save-status').textContent = 'Menyimpan…';
  saving = (async () => {
    try { const note = await api('/api/note', { method: 'PUT', body: { path: id, content, expectedRevision } }); if (current?.id === id) current = note; if ($('editor').value === content) dropDraft(id); else keepDraft(); $('save-status').textContent = 'Tersimpan di perangkat'; await refresh(); }
    catch (e) { $('save-status').textContent = e.status === 409 ? 'Konflik — draft disimpan di browser' : 'Belum tersimpan'; if (e.status === 409) { keepDraft(); $('conflict-dialog').showModal(); } throw e; }
  })();
  try { await saving; } finally { saving = null; }
  if ($('editor').value !== current.content) await save();
}
async function openNote(id) {
  if (id.endsWith('.canvas')) { await switchView('canvas'); await canvasWorkspace.open(id); return; }
  if (id.endsWith('.base')) { const note=await api('/api/note?path='+encodeURIComponent(id));await workspace.openBase(note.content);return; }
  if (loading) return; loading = true;
  try { await save(); const note = await api('/api/note?path=' + encodeURIComponent(id)); current = note; setContent(note.content); const draft = loadDraft(id); if (draft && draft.content !== note.content && !readOnly && note.type === 'note') { recoveryDialog('Draft belum tersimpan', [{ label: id + (draft.revision !== note.revision ? ' — sumber sudah berubah; simpan salinan untuk menghindari konflik.' : ''), action: 'Buka draft', run: async () => { setContent(draft.content); current.revision = draft.revision; renderPreview(); $('recovery-dialog').close(); $('save-status').textContent = 'Draft dipulihkan; Ctrl/Cmd+S untuk menyimpan'; } }, { label: 'Gunakan versi di disk', action: 'Buang draft browser', run: async () => { dropDraft(id); $('recovery-dialog').close(); } }]); } $('tab-title').textContent = note.title; $('note-path').textContent = note.id; $('editor-layout').hidden = false; $('empty-state').hidden = true; renderPreview(); rememberNote(note); files(); await switchView('notes'); await renderLocalGraph(); renderInspector(); $('sidebar').classList.remove('open'); $('save-status').textContent = readOnly || note.type !== 'note' ? 'Hanya baca' : 'Tersimpan di perangkat'; if (note.warning) toast(note.warning); }
  finally { loading = false; }
}
const mini = new GraphView($('mini-canvas'), run(n => selectNode(n)), true), full = new GraphView($('graph-canvas'), run(n => selectNode(n)));
function renderInspector() {
  if (!current) return; const incoming = graph.links.filter(e => e.target === current.id && !e.source.startsWith('tag:'));
  $('backlink-count').textContent = incoming.length; $('backlinks').replaceChildren();
  for (const edge of incoming) { const n = graph.nodes.find(n => n.id === edge.source); const b = document.createElement('button'); b.innerHTML = icon('file') + esc(n?.label || edge.source); b.onclick = run(() => selectNode(n)); $('backlinks').append(b); }
  if (!incoming.length) $('backlinks').innerHTML = '<span class="muted">Belum ada tautan masuk.</span>';
  $('outline').replaceChildren(); [...$('preview').querySelectorAll('h1,h2,h3')].forEach(h => { const b = document.createElement('button'); b.textContent = h.textContent; b.onclick = () => h.scrollIntoView({ behavior: 'smooth' }); $('outline').append(b); });
  $('tags').replaceChildren(); for (const tag of current.tags || []) { const b = document.createElement('button'); b.textContent = '#' + tag; b.onclick = run(async () => { $('search').value = '#' + tag; await refresh(); }); $('tags').append(b); }
  const links = graph.links.filter(e => e.source === current.id || e.target === current.id), ids = new Set([current.id, ...links.flatMap(e => [e.source, e.target])]); mini.setData({ nodes: graph.nodes.filter(n => ids.has(n.id)), links }, current.id);
}
async function switchView(view) { if (view !== 'notes') await save(); if(activeView==='canvas'&&view!=='canvas')await canvasWorkspace.save();activeView=view;for(const v of ['notes','graph','context','data','canvas','extensions','health'])$(v+'-view').hidden=v!==view;document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===view));$('view-label').textContent=({notes:'Catatan',graph:'Knowledge graph',context:'Konteks AI',data:'Data & tugas',canvas:'Canvas',extensions:'Ekstensi',health:'Kesehatan vault'})[view];$('sidebar').classList.remove('open');if(view==='graph'){await loadGraph();renderGraph();}if(view==='canvas')await canvasWorkspace.activate();await workspace.activate(view);}

function renderGraph() {
  const q = $('graph-search').value.toLowerCase(), type = $('graph-filter').value;
  const matches = graph.nodes.filter(n => (!q || `${n.label} ${n.id}`.toLowerCase().includes(q)) && (type === 'all' || n.type === type)); const nodes = matches.slice(0, 350), ids = new Set(nodes.map(n => n.id)), links = graph.links.filter(e => ids.has(e.source) && ids.has(e.target));
  full.setData({ nodes, links }, current?.id); $('graph-stats').textContent = `${nodes.length}/${graph.totalNodes ?? graph.nodes.length} nodes · ${links.length} edges`;
  $('graph-hint').textContent = matches.length > 350 ? '350 node ditampilkan. Persempit pencarian untuk graph besar.' : 'Drag untuk menggeser · Scroll untuk zoom · Klik node untuk menjelajah';
  $('node-heading').textContent = 'Node dalam graph'; $('graph-node-list').replaceChildren();
  for (const n of nodes) { const b = document.createElement('button'); b.textContent = n.label; b.onclick = run(() => selectNode(n)); $('graph-node-list').append(b); }
}
async function selectNode(n) {
  if (!n) return;
  if (['note', 'code', 'document'].includes(n.type)) return openNote(n.id);
  if (n.type === 'symbol' && n.source_file) { await openNote(n.source_file); document.querySelector('[data-mode=edit]').click(); editor.line(n.startLine || 1); return; }
  if (n.type === 'missing') return newDialog(n.label.endsWith('.md') ? n.label : n.label + '.md');
  await switchView('graph'); full.selected = n.id; full.draw(); $('node-heading').textContent = n.label; $('graph-node-list').replaceChildren();
  const p = document.createElement('p'); p.textContent = `${n.id}\n${n.source_file || ''}`; $('graph-node-list').append(p);
  for (const e of graph.links.filter(e => e.source === n.id || e.target === n.id).slice(0, 100)) { const target = graph.nodes.find(x => x.id === (e.source === n.id ? e.target : e.source)), b = document.createElement('button'); b.textContent = `${e.relation || 'link'} → ${target?.label || ''} (${e.confidence || 'unspecified'})`; b.onclick = run(() => selectNode(target)); $('graph-node-list').append(b); }
}
function newDialog(name = '') { $('new-path').value = name; $('new-error').textContent = ''; $('new-dialog').showModal(); $('new-path').focus(); }
for (const id of ['new-note', 'top-new', 'empty-new']) $(id).onclick = () => newDialog();
document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => $(b.dataset.close).close());
document.querySelectorAll('[data-view]').forEach(b => b.onclick = run(() => switchView(b.dataset.view)));
document.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { mode = b.dataset.mode; $('editor-layout').className = 'editor-layout ' + mode; document.querySelectorAll('[data-mode]').forEach(x => x.classList.toggle('active', x === b)); if (mode !== 'read') editor.focus(); });
$('editor').oninput = () => { keepDraft(); renderPreview(); $('save-status').textContent = 'Perubahan belum tersimpan'; clearTimeout(saveTimer); saveTimer = setTimeout(() => save().catch(e => toast(e.message)), 850); };
$('new-form').onsubmit = async e => { e.preventDefault(); try { await save(); let id = $('new-path').value.trim(); if (!id.endsWith('.md')) id += '.md'; await api('/api/note', { method: 'PUT', body: { path: id, content: '# ' + id.split('/').pop().slice(0, -3) + '\n\n', expectedRevision: null } }); $('new-dialog').close(); await refresh(); await openNote(id); document.querySelector('[data-mode="edit"]').click(); } catch (e) { $('new-error').textContent = e.message; } };
$('daily').onclick = run(async () => { await save(); const d = new Date(), date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, id = `Daily/${date}.md`; try { await api('/api/note?path=' + encodeURIComponent(id)); } catch (e) { if (e.status !== 404) throw e; await api('/api/note', { method: 'PUT', body: { path: id, content: `---\ntags: [daily]\n---\n# ${date}\n\n## Fokus hari ini\n\n- [ ] \n\n## Catatan\n\n`, expectedRevision: null } }); await refresh(); } await openNote(id); });
$('refresh').onclick = run(async () => { await save(); await refresh(); if (current) await openNote(current.id); toast('Vault dimuat ulang.'); });
let searchTimer; $('search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => refresh().catch(e => toast(e.message)), 180); };
$('menu').onclick = () => $('sidebar').classList.toggle('open');
$('expand-graph').onclick = run(() => switchView('graph'));
let graphSearchTimer; $('graph-search').oninput = () => {clearTimeout(graphSearchTimer);graphSearchTimer=setTimeout(()=>loadGraph().then(renderGraph).catch(e=>toast(e.message)),180);}; $('graph-filter').onchange = run(async()=>{await loadGraph();renderGraph();}); $('fit-graph').onclick = () => full.fit();
$('find-path').onclick = run(async () => { const r = await api(`/api/path?from=${encodeURIComponent($('path-from').value)}&to=${encodeURIComponent($('path-to').value)}`); $('path-result').textContent = r.found ? r.path.join(' → ') : 'Tidak ada jalur.'; });
async function settings() { const [status, config] = await Promise.all([api('/api/status'), api('/api/mcp-config?format='+$('mcp-client').value+'&transport='+$('mcp-transport').value)]); $('vault-path').textContent = status.vault; configText = typeof config === 'string' ? config : JSON.stringify(config, null, 2); $('mcp-config').textContent = configText; $('runtime-status').textContent = `Node ${status.node} · Proses server ${status.memoryMiB} MiB RSS · MCP stdio + HTTP · 0 panggilan API model`; if(!$('settings-dialog').open)$('settings-dialog').showModal(); }
$('mcp-client').onchange=run(settings);$('mcp-transport').onchange=run(settings);
$('settings').onclick = run(settings); $('connect').onclick = run(settings);
async function copy(text) { await navigator.clipboard.writeText(text); toast('Disalin ke clipboard.'); }
$('copy-config').onclick = run(() => copy(configText)); $('copy-context').onclick = run(() => copy(contextText));
$('context-form').onsubmit = run(async e => { e.preventDefault(); const b = e.currentTarget.querySelector('button'); b.disabled = true; try { const c = await api(`/api/context?q=${encodeURIComponent($('context-query').value)}&budget=${$('context-budget').value}`); contextText = c.text; $('context-output').textContent = c.text; $('context-tokens').textContent = c.estimatedTokens.toLocaleString('id-ID'); $('corpus-tokens').textContent = c.fullCorpusEstimatedTokens.toLocaleString('id-ID'); $('source-count').textContent = c.sources.length; $('copy-context').disabled = !c.sources.length; } finally { b.disabled = false; } });
$('import-graph').onclick = () => $('graph-file').click();
$('graph-file').onchange = run(async () => { const file = $('graph-file').files[0]; if (!file) return; try { if (file.size > 16 * 1024 * 1024) throw new Error('Graph maksimum 16 MiB.'); const data = JSON.parse(await file.text()), isCanvas = file.name.endsWith('.canvas') || data.nodes?.some(n => typeof n.x === 'number' && typeof n.y === 'number'); const result = await api(isCanvas ? '/api/import-canvas' : '/api/import-graph', { method: 'POST', body: data }); await refresh(); toast(`${result.nodes} nodes dan ${result.edges} edges diimpor.`); } finally { $('graph-file').value = ''; } });
$('import-notes').onclick = () => $('markdown-files').click();
$('markdown-files').onchange = run(async () => { await save(); let count = 0; const errors = []; for (const file of $('markdown-files').files) { try { if (file.size > 2 * 1024 * 1024) throw new Error('Maksimum 2 MiB.'); await api('/api/note', { method: 'PUT', body: { path: file.name, content: await file.text(), expectedRevision: null } }); count++; } catch (e) { errors.push(`${file.name}: ${e.message}`); } } $('markdown-files').value = ''; await refresh(); toast(`${count} catatan diimpor.${errors.length ? ' ' + errors.join(' ') : ''}`); });
$('delete-note').onclick = () => { if (!current || current.type !== 'note') return; $('trash-message').textContent = current.id; $('trash-dialog').showModal(); };
$('confirm-trash').onclick = run(async () => { await save(); await api('/api/note', { method: 'DELETE', body: { path: current.id, expectedRevision: current.revision } }); current = null; setContent(''); $('trash-dialog').close(); await refresh(); if (notes.length) await openNote(notes[0].id); else { $('empty-state').hidden = false; $('editor-layout').hidden = true; } toast('Catatan dipindahkan ke trash.'); });
$('download-note').onclick = () => { if (!current) return; const url = URL.createObjectURL(new Blob([$('editor').value], { type: 'text/markdown;charset=utf-8' })), a = document.createElement('a'); a.href = url; a.download = current.id.split('/').pop(); a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
window.addEventListener('beforeunload', e => { if (current && $('editor').value !== current.content) { e.preventDefault(); e.returnValue = ''; } });
document.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('sidebar').classList.add('open'); $('search').focus(); } if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save().catch(e => toast(e.message)); } });
async function init() { const status = await api('/api/status'); workspaceId = status.vault; readOnly = status.readOnly; for (const id of ['new-note', 'top-new', 'empty-new', 'daily', 'import-notes', 'delete-note', 'rename-note','template-note','restore-apply','canvas-new']) $(id).disabled = readOnly; $('vault-name').dataset.root=status.vault;drawBookmarks();$('vault-name').textContent = status.vault.split(/[\\/]/).pop(); await workspace.initialize();await refresh(); const welcome = notes.find(n => n.id === 'Welcome.md') || notes.find(n => n.type === 'note') || notes[0]; if (welcome) await openNote(welcome.id); else $('editor-layout').hidden = true; }
const workspace=setupWorkspace({api,run,toast,openNote,save,refresh,getCurrent:()=>current,clearCurrent:()=>{current=null;},isReadOnly:()=>readOnly,switchView});
const canvasWorkspace=setupCanvas({api,run,toast,openNote,isReadOnly:()=>readOnly});
init().catch(e => toast('Aplikasi tidak dapat dimuat: ' + e.message));

$('conflict-disk').onclick = run(async () => { const id = current.id; current = null; $('conflict-dialog').close(); await openNote(id); });
$('conflict-copy').onclick = run(async () => { const id = current.id.replace(/\.md$/, '') + '-draft-' + Date.now() + '.md', content = $('editor').value; await api('/api/note', { method: 'PUT', body: { path: id, content, expectedRevision: null } }); dropDraft(current.id); current = null; $('conflict-dialog').close(); await refresh(); await openNote(id); });
$('show-history').onclick = run(async () => { if (!current) return; const id = current.id, history = await api('/api/history?path=' + encodeURIComponent(id)); recoveryDialog('Riwayat ' + id, history.map(h => ({ label: h.version, action: 'Lihat versi', run: async () => { const old = await api('/api/history?path=' + encodeURIComponent(id) + '&version=' + encodeURIComponent(h.version)); $('history-preview').textContent = old.content; $('restore-history').disabled = readOnly; $('restore-history').onclick = run(async () => { const latest = await api('/api/note?path=' + encodeURIComponent(id)); await api('/api/history/restore', { method: 'POST', body: { path: id, version: h.version, expectedRevision: latest.revision } }); $('history-dialog').close(); $('recovery-dialog').close(); current = null; await refresh(); await openNote(id); }); $('history-dialog').showModal(); } }))); });
$('show-trash').onclick = run(async () => { const rows = await api('/api/trash'); recoveryDialog('Trash', rows.map(h => ({ label: h.path || h.id, run: async () => { await api('/api/trash/restore', { method: 'POST', body: { trashId: h.trashId || h.id } }); $('recovery-dialog').close(); await refresh(); toast('Catatan dipulihkan.'); } }))); });

const readLocal=(key,fallback)=>{try{return JSON.parse(localStorage.getItem(key))??fallback;}catch{return fallback;}};
const writeLocal=(key,value)=>{try{localStorage.setItem(key,JSON.stringify(value));}catch{}};
function rememberNote(note){const key='mastermind:recent:'+workspaceId,recent=readLocal(key,[]).filter(n=>n.id!==note.id);recent.unshift({id:note.id,title:note.title});writeLocal(key,recent.slice(0,8));$('recent-tabs').replaceChildren();for(const n of recent.slice(0,8)){const b=document.createElement('button');b.textContent=n.title;b.classList.toggle('active',n.id===note.id);b.onclick=run(()=>openNote(n.id));$('recent-tabs').append(b);}drawBookmarks();}
function drawBookmarks(){const marks=readLocal('mastermind:bookmarks:'+workspaceId,[]);$('bookmark-list').replaceChildren();for(const n of marks){const b=document.createElement('button');b.textContent='★ '+n.title;b.onclick=run(()=>openNote(n.id));$('bookmark-list').append(b);}$('bookmark-note').textContent=marks.some(n=>n.id===current?.id)?'★ Bookmarked':'☆ Bookmark';}
$('bookmark-note').onclick=()=>{if(!current)return;const key='mastermind:bookmarks:'+workspaceId,marks=readLocal(key,[]),exists=marks.some(n=>n.id===current.id);writeLocal(key,exists?marks.filter(n=>n.id!==current.id):[...marks,{id:current.id,title:current.title}].slice(-50));drawBookmarks();};
let restoreInput=null,restorePlan=null;
$('restore-preview').onclick=run(async()=>{const file=$('restore-file').files[0];if(!file)throw new Error('Pilih backup ZIP.');if(file.size>8*1024*1024)throw new Error('ZIP maksimum 8 MiB.');const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));restoreInput=btoa(binary);restorePlan=await api('/api/restore/preview',{method:'POST',body:{archiveBase64:restoreInput}});$('restore-details').textContent=JSON.stringify({files:restorePlan.files,conflicts:restorePlan.conflicts},null,2);$('restore-apply').disabled=readOnly||restorePlan.blocked;});
$('restore-file').onchange=()=>{restorePlan=null;restoreInput=null;$('restore-apply').disabled=true;};
$('restore-apply').onclick=run(async()=>{if(!restorePlan)return;await api('/api/restore/apply',{method:'POST',body:{archiveBase64:restoreInput,planHash:restorePlan.planHash}});restorePlan=null;$('restore-apply').disabled=true;await refresh();toast('Backup dipulihkan tanpa menimpa file yang ada.');});
