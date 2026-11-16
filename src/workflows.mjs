import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Lexer } from 'marked';
import { parseDocument, isMap } from 'yaml';
import { digest, fail } from './vault.mjs';
import { parseRestoreArchive } from './workflow-archive.mjs';
import { resolveLink } from './graph.mjs';

const MAX_CHANGES = 300;
const MAX_JOURNAL = 16 * 1024 * 1024;
const WORKFLOW_ID = /^\d{10,}-[a-f0-9-]{36}$/i;
const fold = value => value.normalize('NFC').toLowerCase();
const missing = e => e.code === 'ENOENT' || e.status === 404;
const now = () => new Date().toISOString();
const asMarkdown = (vault, id) => { vault.validate(id); if (!/\.md$/i.test(id)) throw fail('Workflow ini hanya mendukung Markdown.'); return id; };
async function current(vault, id) { try { return await vault.read(id); } catch (e) { if (missing(e)) return null; throw e; } }
const checkRevision = (note, expected) => { if (typeof expected !== 'string' || note.revision !== expected) throw fail('Konflik: revisi sumber berubah.', 409); };

function replacement(ref, target, from, lexer) {
  const fragment = ref.fragment ? '#' + ref.fragment : '';
  if (ref.kind === 'wiki') {
    const match = /^(!?)\[\[([^\]\n]+)\]\]$/.exec(ref.raw); if (!match) return null;
    const alias = match[2].includes('|') ? '|' + match[2].split('|').slice(1).join('|') : '';
    return `${match[1]}[[${target.replace(/\.md$/i, '')}${fragment}${alias}]]`;
  }
  // Preserve labels; normalize both inline and reference-style occurrences into
  // an explicit inline destination, leaving the original reference definition intact.
  const label = /^(!?\[(?:\\.|[^\]])*\])(?:\(|\[|$)/.exec(ref.raw)?.[1];
  if (!label) return null;
  let relative = path.posix.relative(path.posix.dirname(from), target);
  if (!relative) relative = path.posix.basename(target);
  const destination = relative.split('/').map(encodeURIComponent).join('/') + (ref.fragment ? '#' + encodeURIComponent(ref.fragment) : '');
  const title = lexer?.inlineTokens(ref.raw)?.find(t => t.type === 'link' || t.type === 'image')?.title;
  return `${label}(<${destination}>${title ? ' ' + JSON.stringify(title) : ''})`;
}

async function linkDestination(vault, ref, from, entries) {
  const note = resolveLink(ref.target, from, entries, ref.kind); if (note) return note;
  // Attachments may not be indexed. Preserve an existing direct relative asset
  // when its containing note moves; never inspect paths outside the vault.
  if (!path.posix.extname(ref.target)) return null;
  const relative = path.posix.normalize(path.posix.join(path.posix.dirname(from), ref.target));
  const candidates = ref.kind === 'markdown' ? [relative, ref.target] : [ref.target, relative];
  for (const candidate of candidates) try { const file = await vault.safe(candidate), stat = await fs.lstat(file); if (stat.isFile() && !stat.isSymbolicLink()) return candidate; } catch {}
  return null;
}

async function renamePlan(vault, args) {
  const source = await vault.canonicalId(asMarkdown(vault, args.path));
  const target = asMarkdown(vault, args.targetPath);
  if (source === target) throw fail('Path baru sama dengan sumber.');
  if (fold(source) === fold(target)) throw fail('Rename yang hanya mengubah kapitalisasi/normalisasi harus melalui nama perantara.', 409);
  const note = await vault.read(source); checkRevision(note, args.expectedRevision);
  try { await fs.lstat(await vault.safe(target)); throw fail('Tujuan sudah ada; rename tidak menimpa file.', 409); } catch (e) { if (!missing(e)) throw e; }
  await vault.refresh(true);
  if (vault.entries.get(source)?.revision !== note.revision) throw fail('Sumber berubah saat preview.', 409);
  if (!vault.entries.has(source)) throw fail('Sumber tidak termasuk indeks yang diizinkan.', 409);
  const warnings = [{reason:'Hanya link Markdown aktif pada file yang masuk indeks diperiksa; frontmatter string, HTML, file tersembunyi/diabaikan, dan aplikasi lain berada di luar cakupan rewrite.'}], blocked = [], changes = [];
  let bytes = Buffer.byteLength(note.content);
  const updates = args.updateLinks !== false;
  for (const record of vault.entries.values()) {
    if (record.type !== 'note' || (!updates && record.id !== source)) continue;
    const edits = []; let lexer;
    for (const ref of record.links) {
      const destination = await linkDestination(vault, ref, record.id, vault.entries);
      if (destination !== source && record.id !== source) continue;
      if (!destination) {
        if (record.id === source && (ref.target.startsWith('.') || ref.kind === 'markdown')) blocked.push({ path: record.id, line: ref.line, reason: 'Relative link tidak dapat dipastikan; perbaiki sebelum memindahkan catatan.' });
        continue;
      }
      if (!updates && destination === source && record.id !== source) continue;
      const nextTarget = destination === source ? target : destination;
      const nextFrom = record.id === source ? target : record.id;
      if (ref.kind === 'markdown' && !lexer) { lexer = new Lexer({ gfm: true }); lexer.lex(record.content); }
      const text = replacement(ref, nextTarget, nextFrom, lexer);
      if (text === null || record.content.slice(ref.start, ref.end) !== ref.raw) { blocked.push({ path: record.id, line: ref.line, reason: 'Span atau sintaks link kompleks belum dapat direwrite dengan aman.' }); continue; }
      if (text !== ref.raw) edits.push({ start: ref.start, end: ref.end, before: ref.raw, after: text, line: ref.line });
      if (ref.kind === 'markdown' && !/^!?\[[\s\S]*\]\(/.test(ref.raw)) warnings.push({ path: record.id, line: ref.line, reason: 'Reference link occurrence dinormalisasi menjadi inline link; definisi asli dipertahankan.' });
    }
    edits.sort((a, b) => a.start - b.start);
    if (edits.some((e, i) => i && edits[i - 1].end > e.start)) blocked.push({ path: record.id, reason: 'Link span bertumpuk.' });
    let content = record.content;
    for (const edit of [...edits].reverse()) content = content.slice(0, edit.start) + edit.after + content.slice(edit.end);
    if (edits.length || record.id === source) {
      const result = { path: record.id, targetPath: record.id === source ? target : record.id, revision: record.revision, newRevision: digest(content), replacements: edits.length, before: record.content, after: content };
      changes.push(result); bytes += Buffer.byteLength(result.before) + Buffer.byteLength(result.after);
      if (changes.length > MAX_CHANGES || bytes > MAX_JOURNAL) throw fail('Rename terlalu besar: maksimum 300 catatan / 16 MiB snapshot.', 413);
    }
  }
  if (!updates) warnings.push({ reason: 'Backlink eksternal tidak diperbarui karena updateLinks=false.' });
  if (vault.warnings.length) warnings.push({ reason: 'Indeks memiliki file yang dilewati; backlink pada file di luar indeks tidak diperiksa.', count: vault.warnings.length });
  const fingerprint = { source, target, changes: changes.map(({ before, after, ...c }) => c), blocked, updateLinks: updates };
  return { ...fingerprint, changes, warnings, planHash: digest(JSON.stringify(fingerprint)) };
}

export async function previewRename(vault, args) {
  const plan = await renamePlan(vault, args);
  return { ...plan, changes: plan.changes.map(({ before, after, ...c }) => c), dryRun: true };
}

async function persist(vault, journal) { journal.updatedAt = now(); if (Buffer.byteLength(JSON.stringify(journal)) > MAX_JOURNAL * 2 - 65536) throw fail('Snapshot journal terlalu besar.', 413); await vault.writeState(['workflows', `${journal.id}.json`], journal); }
export async function applyRename(vault, args) {
  vault.assertWritable();
  if (typeof args.planHash !== 'string' || !/^[a-f0-9]{64}$/.test(args.planHash)) throw fail('Preview planHash diperlukan.');
  return vault.lock('workflow:mutations', async () => {
    const plan = await renamePlan(vault, args);
    if (plan.planHash !== args.planHash) throw fail('Rencana berubah sejak preview. Muat preview baru.', 409);
    if (plan.blocked.length) throw fail('Rename diblokir oleh link yang tidak dapat direwrite dengan aman.', 409);
    const journal = { id: `${Date.now()}-${randomUUID()}`, operation: 'rename', root: vault.root, createdAt: now(), phase: 'prepared', source: plan.source, target: plan.target, planHash: plan.planHash, changes: plan.changes, completed: [], warnings: plan.warnings };
    await persist(vault, journal);
    const source = plan.changes.find(c => c.path === plan.source);
    try {
      // Destination exists before any backlinks change; the original is retained
      // until all updates succeed. Each file remains revision-checked independently.
      await vault.write(plan.target, source.after, null); journal.completed.push(plan.target); journal.phase = 'applying'; await persist(vault, journal);
      for (const change of plan.changes) {
        if (change.path === plan.source) continue;
        await vault.write(change.path, change.after, change.revision); journal.completed.push(change.path); await persist(vault, journal);
      }
      journal.trash = await vault.trash(plan.source, source.revision);
      journal.phase = 'committed'; await persist(vault, journal);
      return { workflowId: journal.id, path: plan.target, updated: journal.completed, trashId: journal.trash.trashId, warnings: plan.warnings };
    } catch (e) {
      journal.phase = 'interrupted'; journal.error = e.message; await persist(vault, journal).catch(() => {});
      e.workflowId = journal.id; e.message += ` Workflow ${journal.id} menyimpan snapshot pemulihan.`; throw e;
    }
  });
}

async function readWorkflow(vault, id) {
  if (!WORKFLOW_ID.test(String(id))) throw fail('Workflow ID tidak valid.');
  const file = await vault.stateFile(['workflows', `${id}.json`]), stat = await fs.stat(file);
  if (stat.size > MAX_JOURNAL * 2) throw fail('Journal workflow terlalu besar.');
  const value = JSON.parse(await fs.readFile(file, 'utf8'));
  if (value.root !== vault.root) throw fail('Journal berasal dari vault lain.', 409);
  if (value.id !== id || !['rename', 'restore'].includes(value.operation) || !Array.isArray(value.completed) || value.completed.some(p => typeof p !== 'string') || !Array.isArray(value.changes) || value.changes.length > MAX_CHANGES) throw fail('Journal workflow tidak valid.');
  if (value.operation === 'rename') { asMarkdown(vault, value.source); asMarkdown(vault, value.target); }
  for (const change of value.changes) {
    asMarkdown(vault, change.path);
    if ((value.operation === 'rename' ? typeof change.before !== 'string' || digest(change.before) !== change.revision : change.before !== null || change.revision !== null) || typeof change.after !== 'string' || digest(change.after) !== change.newRevision) throw fail('Checksum snapshot workflow tidak cocok.', 409);
  }
  if (value.operation === 'rename' && !value.changes.some(c => c.path === value.source)) throw fail('Snapshot sumber hilang.');
  return value;
}
export async function listWorkflows(vault) {
  const dir = await vault.statePath(['workflows']); let names;
  try { names = await fs.readdir(dir); } catch (e) { if (missing(e)) return []; throw e; }
  const result = [];
  for (const name of names.filter(n => WORKFLOW_ID.test(n.replace(/\.json$/, '')) && n.endsWith('.json')).sort().reverse().slice(0, 100)) {
    try { const j = await readWorkflow(vault, name.slice(0, -5)); result.push({ workflowId: j.id, operation: j.operation, source: j.source, target: j.target, phase: j.phase, updatedAt: j.updatedAt, changedFiles: j.changes.length, error: j.error, conflicts: j.conflicts }); }
    catch (e) { result.push({ workflowId: name.slice(0, -5), phase: 'unreadable', error: e.message }); }
  }
  return result;
}
export async function recoverWorkflow(vault, { workflowId, action = 'rollback' }) {
  vault.assertWritable(); if (action !== 'rollback') throw fail('Hanya rollback eksplisit didukung.');
  return vault.lock('workflow:mutations', async () => {
    const j = await readWorkflow(vault, workflowId);
    if (j.phase === 'rolled-back') return { workflowId, phase: j.phase, conflicts: [] };
    if (j.operation === 'restore') return rollbackRestore(vault, j);
    const source = j.changes.find(c => c.path === j.source), conflicts = [];
    // Preserve the original before reversing backlinks. New/externally edited
    // content is never replaced merely because a journal exists.
    const original = await current(vault, j.source);
    if (!original) await vault.write(j.source, source.before, null);
    else if (original.revision !== source.revision) conflicts.push({ path: j.source, reason: 'Sumber asli berubah; rollback berhenti.' });
    if (conflicts.length) { j.phase = 'rollback-conflict'; j.conflicts = conflicts; await persist(vault, j); return { workflowId, phase: j.phase, conflicts }; }
    j.phase = 'rolling-back'; await persist(vault, j);
    for (const change of [...j.changes].reverse()) {
      if (change.path === j.source) continue;
      const note = await current(vault, change.path);
      if (note?.revision === change.revision) continue;
      if (!j.completed.includes(change.path)) { conflicts.push({ path: change.path, reason: 'Penyelesaian penulisan tidak tercatat; file dipertahankan.' }); continue; }
      if (note?.revision !== change.newRevision) { conflicts.push({ path: change.path, reason: 'File berubah/hilang; tidak ditimpa.' }); continue; }
      try { await vault.write(change.path, change.before, change.newRevision); } catch (e) { conflicts.push({ path: change.path, reason: e.message }); }
    }
    const destination = await current(vault, j.target);
    if (destination && !j.completed.includes(j.target)) conflicts.push({path:j.target,reason:'Pembuatan tujuan tidak tercatat; file dipertahankan.'});
    if (destination && destination.revision !== source.newRevision) conflicts.push({ path: j.target, reason: 'Tujuan berubah; tetap dipertahankan.' });
    await vault.refresh(true);
    for (const note of vault.entries.values()) if (note.id !== j.target && note.links?.some(ref => resolveLink(ref.target, note.id, vault.entries, ref.kind) === j.target)) conflicts.push({path:note.id,reason:'Masih memiliki link ke tujuan; tujuan dipertahankan.'});
    if (destination && !conflicts.length) await vault.trash(j.target, source.newRevision);
    j.phase = conflicts.length ? 'rollback-conflict' : 'rolled-back'; j.conflicts = conflicts; await persist(vault, j);
    return { workflowId, phase: j.phase, conflicts };
  });
}

function activeMarkdown(source) {
  return source.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/, s => s.replace(/[^\r\n]/g, ' ')).replace(/%%[\s\S]*?%%/g, s => s.replace(/[^\r\n]/g, ' '));
}
export async function updateTask(vault, { path: id, line, completed, expectedRevision }) {
  vault.assertWritable(); asMarkdown(vault, id);
  if (!Number.isInteger(line) || line < 1 || typeof completed !== 'boolean') throw fail('line dan completed tidak valid.');
  const note = await vault.read(id); checkRevision(note, expectedRevision);
  const lines = note.content.split('\n'), original = lines[line - 1];
  if (original === undefined) throw fail('Baris task tidak ditemukan.', 404);
  const ending = original.endsWith('\r') ? '\r' : '', lineText = ending ? original.slice(0, -1) : original;
  const match = /^(\s*(?:>\s*)*(?:[-+*]|\d+[.)])\s+)\[([ xX])\](\s+.*)$/.exec(lineText);
  if (!match) throw fail('Baris bukan checkbox task yang didukung.');
  // Ask the Markdown parser whether this exact, uniquely marked line is a task;
  // this excludes fences, indented code, HTML/comments, and frontmatter reliably.
  const marker = `mastermindtask${randomUUID().replaceAll('-', '')}`, probe = [...lines]; probe[line - 1] = lineText + ' ' + marker + ending;
  let found = false;
  const walk = tokens => { for (const token of tokens || []) { if (['code', 'codespan', 'html'].includes(token.type)) continue; for (const item of token.items || []) { if (item.task && item.raw.split('\n')[0].includes(marker)) found = true; walk(item.tokens); } if (token.tokens) walk(token.tokens); } };
  walk(Lexer.lex(activeMarkdown(probe.join('\n')), { gfm: true }));
  if (!found) throw fail('Checkbox berada dalam kode/comment atau bukan task Markdown aktif.');
  lines[line - 1] = match[1] + `[${completed ? 'x' : ' '}]` + match[3] + ending;
  const saved = await vault.write(id, lines.join('\n'), expectedRevision);
  return { path: saved.id, revision: saved.revision, line, completed };
}

function safeValue(value, depth = 0) {
  if (depth > 12) throw fail('Properti terlalu dalam.');
  if (value === null || ['string', 'boolean'].includes(typeof value) || typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { if (value.length > 1000) throw fail('Array properti terlalu besar.'); for (const v of value) safeValue(v, depth + 1); return; }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) { for (const [key, val] of Object.entries(value)) { if (['__proto__', 'prototype', 'constructor'].includes(key)) throw fail('Nama properti tidak aman.'); safeValue(val, depth + 1); } return; }
  throw fail('Nilai properti harus JSON biasa.');
}
export async function updateProperties(vault, { path: id, properties = {}, remove = [], expectedRevision }) {
  vault.assertWritable(); asMarkdown(vault, id); safeValue(properties);
  if (!properties || Array.isArray(properties) || typeof properties !== 'object' || !Array.isArray(remove) || remove.some(k => typeof k !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(k))) throw fail('Properti/remove tidak valid.');
  if (Object.keys(properties).length > 100 || remove.length > 100 || Buffer.byteLength(JSON.stringify(properties)) > 65536) throw fail('Perubahan properti terlalu besar.');
  const note = await vault.read(id); checkRevision(note, expectedRevision);
  const front = /^(\uFEFF?)(---\r?\n)([\s\S]*?)(\r?\n)(---|\.\.\.)(\r?\n|$)/.exec(note.content);
  const doc = parseDocument(front ? front[3] : '{}', { uniqueKeys: true });
  if (doc.errors.length || doc.contents && !isMap(doc.contents)) throw fail('Frontmatter harus YAML mapping valid; isi tidak diubah.');
  doc.toJS({ maxAliasCount: 30 });
  for (const key of remove) doc.delete(key);
  for (const [key, value] of Object.entries(properties)) { if (!key || key.length > 200 || /[\r\n]/.test(key)) throw fail('Nama properti tidak valid.'); doc.set(key, value); }
  const eol = front?.[4] || (note.content.includes('\r\n') ? '\r\n' : '\n');
  const yaml = doc.toString().replace(/\r?\n/g, eol).replace(/(?:\r?\n)+$/, '');
  const body = front ? note.content.slice(front[0].length) : note.content.replace(/^\uFEFF/, '');
  const bom = note.content.startsWith('\uFEFF') ? '\uFEFF' : '';
  const content = `${bom}---${eol}${yaml}${eol}${front?.[5] || '---'}${front?.[6] || eol}${body}`;
  const saved = await vault.write(id, content, expectedRevision);
  return { path: saved.id, revision: saved.revision, properties: saved.properties };
}

export async function createFromTemplate(vault, { path: id, templatePath, template, title, date, time, expectedTemplateRevision }) {
  vault.assertWritable(); asMarkdown(vault, id);
  if ((templatePath === undefined) === (template === undefined)) throw fail('Pilih templatePath atau template, bukan keduanya.');
  let source;
  if (templatePath !== undefined) { asMarkdown(vault, templatePath); source = await vault.read(templatePath); if (expectedTemplateRevision !== undefined) checkRevision(source, expectedTemplateRevision); template = source.content; }
  if (typeof template !== 'string' || Buffer.byteLength(template) > 16384) throw fail('Template maksimum 16 KiB.');
  title ??= path.posix.basename(id, '.md'); date ??= new Date().toISOString().slice(0, 10); time ??= new Date().toISOString().slice(11, 16);
  const parsedDate = typeof date === 'string' ? new Date(date + 'T00:00:00Z') : new Date(NaN);
  if (typeof title !== 'string' || title.length > 240 || /[\r\n]/.test(title) || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date || typeof time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw fail('Title/date/time tidak valid.');
  const substitutions = { title, date, time, path: id };
  const unknown = [...template.matchAll(/\{\{([^{}]+)\}\}/g)].map(m => m[1].trim()).filter(key => !Object.hasOwn(substitutions, key));
  if (unknown.length) throw fail('Placeholder template tidak didukung: ' + [...new Set(unknown)].join(', '));
  const content = template.replace(/\{\{\s*(title|date|time|path)\s*\}\}/g, (_, key) => substitutions[key]);
  const note = await vault.write(id, content, null);
  return { ...note, path: note.id, template: source ? { path: source.id, revision: source.revision } : { type: 'inline', revision: digest(template) } };
}

async function restorePlan(vault, archiveBase64) {
  const archive = parseRestoreArchive(vault, archiveBase64), conflicts = [];
  for (const file of archive.files) {
    try { await fs.lstat(await vault.safe(file.path)); conflicts.push({ path: file.path, reason: 'Tujuan sudah ada; tidak ditimpa.' }); }
    catch (e) { if (!missing(e)) throw e; }
  }
  const publicFiles = archive.files.map(({ content, ...file }) => file);
  return { ...archive, conflicts, planHash: digest(JSON.stringify({ archiveHash: archive.archiveHash, files: publicFiles, conflicts })) };
}
export async function previewRestore(vault, { archiveBase64 }) {
  const result = await restorePlan(vault, archiveBase64);
  return { ...result, files: result.files.map(({ content, ...file }) => file), dryRun: true, blocked: result.conflicts.length > 0 };
}
export async function applyRestore(vault, { archiveBase64, planHash }) {
  vault.assertWritable();
  return vault.lock('workflow:mutations', async () => {
    const plan = await restorePlan(vault, archiveBase64);
    if (!planHash || planHash !== plan.planHash) throw fail('Rencana restore berubah. Muat preview baru.', 409);
    if (plan.conflicts.length) throw fail('Restore diblokir: file tujuan sudah ada.', 409);
    const journal = { id: `${Date.now()}-${randomUUID()}`, root: vault.root, operation: 'restore', createdAt: now(), phase: 'prepared', archiveHash: plan.archiveHash, changes: plan.files.map(file => ({ path: file.path, before: null, after: file.content, revision: null, newRevision: file.revision })), completed: [] };
    await persist(vault, journal);
    try {
      for (const file of plan.files) { await vault.write(file.path, file.content, null); journal.completed.push(file.path); journal.phase = 'applying'; await persist(vault, journal); }
      journal.phase = 'committed'; await persist(vault, journal);
      return { workflowId: journal.id, restored: journal.completed, phase: journal.phase };
    } catch (e) { journal.phase = 'interrupted'; journal.error = e.message; await persist(vault, journal).catch(() => {}); e.workflowId = journal.id; e.message += ` Workflow ${journal.id} menyimpan snapshot pemulihan.`; throw e; }
  });
}
async function rollbackRestore(vault, journal) {
  const conflicts = []; journal.phase = 'rolling-back'; await persist(vault, journal);
  for (const change of [...journal.changes].reverse()) {
    const note = await current(vault, change.path); if (!note) continue;
    if (!journal.completed.includes(change.path)) { conflicts.push({path:change.path,reason:'Pembuatan file tidak tercatat; kepemilikan tidak diasumsikan.'}); continue; }
    if (note.revision !== change.newRevision) { conflicts.push({ path: change.path, reason: 'Catatan berubah sejak restore; tidak dipindahkan.' }); continue; }
    try { await vault.trash(change.path, change.newRevision); } catch (e) { conflicts.push({ path: change.path, reason: e.message }); }
  }
  journal.phase = conflicts.length ? 'rollback-conflict' : 'rolled-back'; journal.conflicts = conflicts; await persist(vault, journal);
  return { workflowId: journal.id, phase: journal.phase, conflicts };
}
