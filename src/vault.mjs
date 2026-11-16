import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import ignore from 'ignore';
import { validateDocument } from './formats.mjs';
import { parseNote } from './markdown.mjs';
export { parseNote } from './markdown.mjs';
export const digest = text => createHash('sha256').update(text).digest('hex');
export const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const MAX_FILE = 2 * 1024 * 1024;
const CODE = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py']);
const DOCUMENT = new Set(['.txt', '.mdx', '.html', '.css', '.json', '.yaml', '.yml', '.base', '.canvas']);
const SKIP = new Set(['node_modules', 'vendor', 'dist', 'build', '__pycache__', 'coverage']);
const PRIVATE = /^(?:credentials(?:\.[^.]+)?|secrets?\.(?:json|ya?ml|ini|toml|env)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx))$/i;
const VERSION = /^\d{10,}-[a-f0-9-]{36}\.md$/i;
const ITEM = /^\d{10,}-[a-f0-9-]{36}$/i;
const utf8 = buffer => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
const folded = id => id.normalize('NFC').toLowerCase();
const itemId = () => `${Date.now()}-${randomUUID()}`;
const absent = e => e.code === 'ENOENT';
async function exists(file) { try { return await fs.lstat(file); } catch (e) { if (absent(e)) return null; throw e; } }
async function readOptional(file) { try { return await fs.readFile(file); } catch (e) { if (absent(e)) return undefined; throw e; } }
function alive(owner) {
  if (!owner || owner.hostname !== os.hostname() || !Number.isSafeInteger(owner.pid) || owner.pid < 1) return null;
  try { process.kill(owner.pid, 0); return true; } catch (e) { return e.code === 'ESRCH' ? false : true; }
}
async function canonicalCandidate(file) {
  const pending = []; let current = path.resolve(file);
  while (!(await exists(current))) { const parent = path.dirname(current); if (parent === current) break; pending.unshift(path.basename(current)); current = parent; }
  return path.join(await fs.realpath(current), ...pending);
}

export class Vault {
  constructor(root, { readOnly = false, stateDir, exclude = [] } = {}) {
    this.root = path.resolve(root); this.readOnly = Boolean(readOnly); this.stateDir = stateDir ? path.resolve(stateDir) : null;
    this.stateRoot = this.stateDir || path.join(this.root, '.mastermind'); this.exclude = [...exclude]; this.excludeMatcher = ignore().add(this.exclude);
    this.entries = new Map(); this.lastScan = 0; this.epoch = 0; this.warnings = []; this.runtimeWarnings = [];
  }
  async init() {
    if (!this.readOnly) await fs.mkdir(this.root, { recursive: true });
    const s = await fs.stat(this.root); if (!s.isDirectory()) throw fail('Vault harus berupa direktori.');
    this.root = await fs.realpath(this.root);
    this.stateRoot = this.stateDir ? await canonicalCandidate(this.stateDir) : path.join(this.root, '.mastermind');
    if (this.readOnly && this.stateDir) {
      const relative = path.relative(this.root, this.stateRoot);
      if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) throw fail('State directory untuk vault read-only harus berada di luar sumber.', 403);
    }
    await this.refresh(true); return this;
  }
  assertWritable() { if (this.readOnly) throw fail('Vault read-only: perubahan sumber tidak diizinkan.', 403); }
  assertStateWritable() { if (this.readOnly && !this.stateDir) throw fail('Vault read-only membutuhkan stateDir eksternal untuk menyimpan state.', 403); }
  validate(id) {
    if (typeof id !== 'string' || id.length > 500 || !id || id.includes('\\') || id.startsWith('/') || /[\x00-\x1f<>:"|?*]/.test(id)) throw fail('Path file tidak valid.');
    if (id.split('/').some(p => !p || p.startsWith('.') || p.endsWith(' ') || p.endsWith('.') || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw fail('Path harus berada di dalam vault dan kompatibel lintas OS.');
    if (PRIVATE.test(path.posix.basename(id)) || this.excludeMatcher.ignores(id)) throw fail('Path dikecualikan dari vault.', 403);
    return id;
  }
  async safe(id, { parents = false } = {}) {
    this.validate(id); if (parents) this.assertWritable();
    let current = this.root; const parts = id.split('/');
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]); let s = await exists(current);
      if (!s && parents && i < parts.length - 1) { await fs.mkdir(current).catch(e => { if (e.code !== 'EEXIST') throw e; }); s = await fs.lstat(current); }
      if (s && (s.isSymbolicLink() || (i < parts.length - 1 && !s.isDirectory()))) throw fail('Symlink dan path di luar vault tidak didukung.', 403);
    }
    return current;
  }
  async canonicalId(id) {
    const file = await this.safe(id);
    try { return path.relative(this.root, await fs.realpath(file)).split(path.sep).join('/'); } catch (e) { if (absent(e)) return id; throw e; }
  }
  async statePath(parts = [], create = false) {
    if (parts.some(p => typeof p !== 'string' || !p || p === '.' || p === '..' || /[\\/\x00]/.test(p))) throw fail('Path state tidak valid.');
    if (create) this.assertStateWritable();
    let current = this.stateRoot;
    if (create) await fs.mkdir(current, { recursive: true });
    let s = await exists(current); if (s && (s.isSymbolicLink() || !s.isDirectory())) throw fail('Direktori internal tidak aman.', 403);
    for (const part of parts) {
      current = path.join(current, part);
      if (create) await fs.mkdir(current).catch(e => { if (e.code !== 'EEXIST') throw e; });
      s = await exists(current); if (s && (s.isSymbolicLink() || !s.isDirectory())) throw fail('Direktori internal tidak aman.', 403);
    }
    return current;
  }
  async internal(...parts) { return this.statePath(parts, !this.readOnly || Boolean(this.stateDir)); }
  async stateFile(parts) {
    const directory = await this.statePath(parts.slice(0, -1)); const name = parts.at(-1);
    if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\\/\x00]/.test(name)) throw fail('Path state tidak valid.');
    const file = path.join(directory, name), s = await exists(file);
    if (s && (s.isSymbolicLink() || !s.isFile())) throw fail('File state tidak aman.', 403);
    return file;
  }
  async syncDirectory(directory) {
    let handle;
    try { handle = await fs.open(directory, 'r'); await handle.sync(); }
    catch (e) { if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EBADF', 'EACCES'].includes(e.code)) throw e; const message = 'Directory fsync tidak tersedia pada filesystem ini; durability metadata terbatas.'; if (!this.runtimeWarnings.includes(message)) this.runtimeWarnings.push(message); }
    finally { await handle?.close(); }
  }
  async durableFile(file, content, { exclusive = false } = {}) {
    this.assertStateWritable();
    if (this.readOnly) { const relative = path.relative(this.stateRoot, path.resolve(file)); if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw fail('Vault read-only: durable writes hanya di stateDir eksternal.', 403); }
    if (exclusive) { const h = await fs.open(file, 'wx', 0o600); try { await h.writeFile(content); await h.sync(); } finally { await h.close(); } await this.syncDirectory(path.dirname(file)); return; }
    const s = await exists(file); if (s?.isSymbolicLink()) throw fail('File state berupa symlink.', 403);
    const temp = path.join(path.dirname(file), `.write-${randomUUID()}.tmp`);
    try { await this.durableFile(temp, content, { exclusive: true }); await fs.rename(temp, file); await this.syncDirectory(path.dirname(file)); }
    finally { await fs.unlink(temp).catch(e => { if (!absent(e)) throw e; }); }
  }
  async writeState(parts, value) {
    if (!parts.length || parts.some(p => typeof p !== 'string' || !p || p === '.' || p === '..' || /[\\/\x00]/.test(p))) throw fail('Path state tidak valid.');
    const dir = await this.internal(...parts.slice(0, -1)), file = path.join(dir, parts.at(-1));
    await this.durableFile(file, JSON.stringify(value, null, 2)); return file;
  }
  async lock(id, fn) {
    this.assertStateWritable();
    const locks = await this.internal('locks'), key = digest(`${folded(this.root)}\0${folded(id)}`), directory = path.join(locks, key), recovery = `${directory}.recovery`;
    const owner = { pid: process.pid, hostname: os.hostname(), token: randomUUID(), createdAt: new Date().toISOString(), path: id };
    let acquired = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await exists(recovery)) throw fail('Pemulihan lock sedang berlangsung. Periksa doctor bila tertinggal.', 409);
      try { await fs.mkdir(directory); await this.durableFile(path.join(directory, 'owner.json'), JSON.stringify(owner), { exclusive: true }); acquired = true; break; }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        let marker;
        try {
          marker = await fs.open(recovery, 'wx', 0o600); await marker.writeFile(JSON.stringify(owner)); await marker.sync();
          const current = await exists(directory); if (!current) continue;
          if (!current.isDirectory() || current.isSymbolicLink()) throw fail('Lock tidak aman.', 403);
          let prior; try { prior = JSON.parse(await fs.readFile(path.join(directory, 'owner.json'), 'utf8')); } catch { throw fail('Lock tanpa identitas pemilik; doctor diperlukan, tidak dihapus otomatis.', 409); }
          if (alive(prior) !== false) throw fail('File sedang ditulis oleh proses lain. Coba lagi.', 409);
          // Recovery mutex serializes read-owner/rename, so a contender cannot quarantine a new live owner.
          const quarantined = `${directory}.dead-${randomUUID()}`; await fs.rename(directory, quarantined);
          await fs.unlink(path.join(quarantined, 'owner.json')); await fs.rmdir(quarantined); await this.syncDirectory(locks);
        } catch (error) { if (error.code === 'EEXIST') throw fail('Pemulihan lock sedang berlangsung.', 409); throw error; }
        finally { if (marker) { await marker.close(); await fs.unlink(recovery); } }
        if (attempt === 2) throw fail('Lock belum dapat diperoleh.', 409);
      }
    }
    if (!acquired) throw fail('Lock belum dapat diperoleh.', 409);
    try { return await fn(); }
    finally {
      const current = JSON.parse(await fs.readFile(path.join(directory, 'owner.json'), 'utf8'));
      if (current.token !== owner.token) throw fail('Pemilik lock berubah; cleanup dihentikan.', 409);
      await fs.unlink(path.join(directory, 'owner.json')); await fs.rmdir(directory);
    }
  }
  async refresh(force = false) {
    if (this.scanning) { await this.scanning; if (force) return this.refresh(true); return; }
    if (!force && Date.now() - this.lastScan < 1000) return;
    this.scanning = this.scan(); try { await this.scanning; } finally { this.scanning = null; }
  }
  async scan() {
    const next = new Map(), warnings = [...this.runtimeWarnings]; let totalBytes = 0, changed = false, capped = false;
    const walk = async (folder = '', inherited = []) => {
      const directory = path.join(this.root, folder); let children;
      try { const s = await fs.lstat(directory); if (s.isSymbolicLink()) return; children = await fs.readdir(directory, { withFileTypes: true }); }
      catch (e) { warnings.push(`${folder || '.'}: tidak dapat dipindai (${e.code || e.message})`); return; }
      const matcher = ignore(); let hasRules = false;
      for (const name of ['.gitignore', '.mastermindignore']) {
        try { const file = path.join(directory, name), s = await fs.lstat(file); if (!s.isFile() || s.isSymbolicLink() || s.size > 1024 * 1024) continue; matcher.add(await fs.readFile(file, 'utf8')); hasRules = true; }
        catch (e) { if (!absent(e)) warnings.push(`${folder}/${name}: ${e.code || e.message}`); }
      }
      if (!folder && this.exclude.length) { matcher.add(this.exclude); hasRules = true; }
      const rules = hasRules ? [...inherited, { base: folder, matcher }] : inherited;
      for (const entry of children.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.') || SKIP.has(entry.name) || entry.isSymbolicLink() || PRIVATE.test(entry.name) || /\.min\.(?:js|css)$/i.test(entry.name)) continue;
        const id = folder ? `${folder}/${entry.name}` : entry.name;
        let excluded = false;
        for (const rule of rules) { const relative = rule.base ? id.slice(rule.base.length + 1) : id; const result = rule.matcher.test(relative + (entry.isDirectory() ? '/' : '')); if (result.ignored) excluded = true; if (result.unignored) excluded = false; }
        if (excluded || this.excludeMatcher.ignores(id + (entry.isDirectory() ? '/' : ''))) continue;
        if (next.size >= 20000) { capped = true; return; }
        if (entry.isDirectory()) { await walk(id, rules); continue; }
        const ext = path.extname(id).toLowerCase(); if (!entry.isFile() || (ext !== '.md' && !CODE.has(ext) && !DOCUMENT.has(ext))) continue;
        try {
          this.validate(id); const file = path.join(this.root, id), s = await fs.lstat(file); if (s.isSymbolicLink() || !s.isFile()) continue;
          if (s.size > MAX_FILE || totalBytes + s.size > 100 * 1024 * 1024) { warnings.push(`Dilewati (batas ukuran): ${id}`); continue; }
          totalBytes += s.size; const old = this.entries.get(id), signature = `${s.mtimeMs}:${s.ctimeMs}:${s.size}`;
          if (old?.signature === signature) { next.set(id, old); continue; }
          const content = utf8(await fs.readFile(file));
          if ((CODE.has(ext) || ext === '.css') && content.split('\n').some(line => line.length > 20000)) { warnings.push(`Dilewati (baris kode minified/generated): ${id}`); continue; }
          const record = this.record(id, content);
          next.set(id, { ...record, signature, modified: s.mtime.toISOString(), bytes: s.size }); changed = true;
        } catch (e) { warnings.push(`${id}: ${e.message}`); }
      }
    };
    await walk(); if (capped) warnings.push('Limiting index to 20,000 files.');
    if (changed || next.size !== this.entries.size || [...next.keys()].some(id => !this.entries.has(id))) this.epoch++;
    this.entries = next; this.warnings = warnings; this.lastScan = Date.now();
  }
  record(id, content) {
    const ext = path.extname(id).toLowerCase();
    return ext === '.md' ? parseNote(id, content) : { id, title: path.basename(id), content, body: content, bodyStartLine: 1, type: CODE.has(ext) ? 'code' : 'document', tags: [], links: [], aliases: [], headings: [], blocks: [], revision: digest(content) };
  }
  async list(query = '') {
    await this.refresh(); const q = String(query).toLowerCase().trim();
    return [...this.entries.values()].filter(n => !q || (q.startsWith('#') ? n.tags.some(t => t.toLowerCase().includes(q.slice(1))) : `${n.id}\n${n.content}`.toLowerCase().includes(q))).map(({ content, body, signature, ...n }) => {
      const at = q ? content.toLowerCase().indexOf(q) : -1;
      return { ...n, snippet: content.slice(Math.max(0, at - 45), Math.max(0, at - 45) + 170).replace(/\n/g, ' ') };
    }).sort((a, b) => a.id.localeCompare(b.id));
  }
  async read(id) {
    if (PRIVATE.test(path.posix.basename(String(id)))) throw fail('File kredensial/private key tidak tersedia.', 403);
    const file = await this.safe(id), ext = path.extname(id).toLowerCase();
    if (!['.md', ...CODE, ...DOCUMENT].includes(ext)) throw fail('Tipe file tidak didukung.');
    const stat = await fs.stat(file).catch(e => { if (absent(e)) throw fail('File tidak ditemukan.', 404); throw e; });
    if (!stat.isFile() || stat.size > MAX_FILE) throw fail('File terlalu besar atau bukan file biasa.');
    return this.record(id, utf8(await fs.readFile(file)));
  }
  async archive(id, content) {
    const version = `${itemId()}.md`, key = digest(id), directory = await this.internal('history', key);
    await this.durableFile(path.join(directory, version), content, { exclusive: true });
    await this.writeState(['history-meta', key, `${version}.json`], { version, path: id, revision: digest(content), date: new Date().toISOString(), bytes: Buffer.byteLength(content) });
    return version;
  }
  async conflict(id, content, expectedRevision, actualRevision, operation) {
    const draftId = itemId(), directory = await this.internal('conflicts');
    await this.durableFile(path.join(directory, `${draftId}.md`), content, { exclusive: true });
    await this.writeState(['conflicts', `${draftId}.json`], { id, draftId, expectedRevision, actualRevision, createdAt: new Date().toISOString(), operation });
    const error = fail(`Konflik: file telah berubah. Draft dipertahankan sebagai ${draftId} di state/conflicts.`, 409); error.draftId = draftId; return error;
  }
  async write(id, content, expectedRevision) {
    this.assertWritable(); this.validate(id);
    if (!id.toLowerCase().endsWith('.md') || typeof content !== 'string' || Buffer.byteLength(content) > MAX_FILE) throw fail('Tulisan harus file .md, maksimum 2 MiB.');
    return this.#writeContent(id, content, expectedRevision);
  }
  async writeDocument(id, content, expectedRevision) {
    this.assertWritable(); this.validate(id); validateDocument(id, content);
    return this.#writeContent(id, content, expectedRevision);
  }
  async #writeContent(id, content, expectedRevision) {
    if (expectedRevision !== null && typeof expectedRevision !== 'string') throw fail('expectedRevision wajib diisi: null untuk file baru, hash untuk update.');
    return this.lock(id, async () => {
      id = await this.canonicalId(id); const file = await this.safe(id, { parents: true }), old = await readOptional(file), actualRevision = old === undefined ? null : digest(old);
      if (actualRevision !== expectedRevision) throw await this.conflict(id, content, expectedRevision, actualRevision, 'write');
      if (old !== undefined && old.equals(Buffer.from(content))) return this.read(id);
      const version = old === undefined ? null : await this.archive(id, old), operationId = itemId(), newRevision = digest(content), temporary = path.join(path.dirname(file), `.mastermind-${randomUUID()}.tmp`);
      const journal = { id: operationId, operation: 'write', path: id, expectedRevision, newRevision, previousVersion: version, temporary: path.relative(this.root, temporary).split(path.sep).join('/'), phase: 'preparing', createdAt: new Date().toISOString() };
      await this.writeState(['transactions', `${operationId}.json`], journal);
      try {
        await this.durableFile(temporary, content, { exclusive: true });
        if (old !== undefined) await fs.chmod(temporary, (await fs.stat(file)).mode & 0o777);
        journal.phase = 'prepared'; await this.writeState(['transactions', `${operationId}.json`], journal);
        const latest = await readOptional(file), latestRevision = latest === undefined ? null : digest(latest);
        if (latestRevision !== expectedRevision) { journal.phase = 'conflict'; await this.writeState(['transactions', `${operationId}.json`], journal); throw await this.conflict(id, content, expectedRevision, latestRevision, operationId); }
        if (old === undefined) {
          try { await fs.link(temporary, file); }
          catch (e) { if (e.code === 'EEXIST') throw await this.conflict(id, content, expectedRevision, digest(await fs.readFile(file)), operationId); throw e; }
        } else await fs.rename(temporary, file);
        await this.syncDirectory(path.dirname(file)); journal.phase = 'committed'; journal.completedAt = new Date().toISOString(); await this.writeState(['transactions', `${operationId}.json`], journal);
      } catch (e) {
        if (journal.phase !== 'committed' && journal.phase !== 'conflict') { journal.error = e.message; await this.writeState(['transactions', `${operationId}.json`], journal).catch(() => {}); }
        throw e;
      } finally { if (journal.phase === 'committed' || journal.phase === 'conflict') await fs.unlink(temporary).catch(e => { if (!absent(e)) throw e; }); }
      this.lastScan = 0; await this.refresh(true); return this.read(id);
    });
  }
  async trash(id, expectedRevision) {
    this.assertWritable(); this.validate(id); if (!id.toLowerCase().endsWith('.md')) throw fail('Hanya catatan Markdown dapat dipindahkan ke trash.');
    return this.lock(id, async () => {
      id = await this.canonicalId(id); const note = await this.read(id); if (note.revision !== expectedRevision) throw fail('Konflik: file telah berubah.', 409);
      const trashId = itemId(), directory = await this.internal('trash', trashId), metadata = { id, deletedAt: new Date().toISOString(), revision: note.revision, bytes: Buffer.byteLength(note.content), status: 'prepared' };
      await this.durableFile(path.join(directory, 'note.md'), note.content, { exclusive: true }); await this.writeState(['trash', trashId, 'metadata.json'], metadata);
      if ((await this.read(id)).revision !== expectedRevision) { metadata.status = 'cancelled'; await this.writeState(['trash', trashId, 'metadata.json'], metadata); throw fail('Konflik: file berubah sebelum dipindahkan ke trash.', 409); }
      await fs.unlink(await this.safe(id)); await this.syncDirectory(path.dirname(path.join(this.root, id))); metadata.status = 'trashed'; await this.writeState(['trash', trashId, 'metadata.json'], metadata);
      this.lastScan = 0; await this.refresh(true); return { trashId, id };
    });
  }
  async history(id, { limit = 100 } = {}) {
    this.validate(id); const canonical = await this.canonicalId(id), keys = [...new Set([digest(canonical), digest(id)])], output = [];
    for (const key of keys) {
      const directory = await this.statePath(['history', key]); let names;
      try { names = await fs.readdir(directory); } catch (e) { if (absent(e)) continue; throw e; }
      for (const version of names.filter(n => VERSION.test(n))) {
        const file = await this.stateFile(['history', key, version]), s = await fs.stat(file); let metadata;
        try { metadata = JSON.parse(await fs.readFile(await this.stateFile(['history-meta', key, `${version}.json`]), 'utf8')); } catch { metadata = null; }
        output.push({ version, path: metadata?.path || id, revision: metadata?.revision || digest(await fs.readFile(file)), date: metadata?.date || new Date(Number(version.split('-')[0])).toISOString(), bytes: s.size });
      }
    }
    return output.sort((a, b) => b.version.localeCompare(a.version)).slice(0, Math.max(1, Math.min(1000, limit)));
  }
  async historyRead(id, version) {
    this.validate(id); if (!VERSION.test(String(version))) throw fail('Version ID tidak valid.');
    const canonical = await this.canonicalId(id), keys = [...new Set([digest(canonical), digest(id)])];
    for (const key of keys) {
      const file = await this.stateFile(['history', key, version]); const content = await readOptional(file); if (content === undefined) continue;
      if (content.length > MAX_FILE) throw fail('Versi riwayat terlalu besar.');
      let metadata; try { metadata = JSON.parse(await fs.readFile(await this.stateFile(['history-meta', key, `${version}.json`]), 'utf8')); } catch (e) { if (!absent(e)) throw e; }
      if (metadata?.revision && metadata.revision !== digest(content)) throw fail('Checksum riwayat tidak cocok; file tidak dipulihkan.', 409);
      return { ...this.record(id, utf8(content)), version, date: metadata?.date || new Date(Number(version.split('-')[0])).toISOString() };
    }
    throw fail('Versi riwayat tidak ditemukan.', 404);
  }
  async restoreHistory(id, version, expectedRevision) { this.assertWritable(); const old = await this.historyRead(id, version); return /\.(base|canvas)$/.test(id) ? this.writeDocument(id, old.content, expectedRevision) : this.write(id, old.content, expectedRevision); }
  async listTrash() {
    const directory = await this.statePath(['trash']); let entries; try { entries = await fs.readdir(directory); } catch (e) { if (absent(e)) return []; throw e; }
    const output = [];
    for (const trashId of entries.filter(n => ITEM.test(n))) {
      try { const metadata = JSON.parse(await fs.readFile(await this.stateFile(['trash', trashId, 'metadata.json']), 'utf8')); const s = await fs.stat(await this.stateFile(['trash', trashId, 'note.md'])); output.push({ ...metadata, trashId, bytes: s.size }); }
      catch (e) { output.push({ trashId, status: 'unreadable', error: e.message }); }
    }
    return output.sort((a, b) => b.trashId.localeCompare(a.trashId));
  }
  async restoreTrash(trashId, targetPath) {
    this.assertWritable(); if (!ITEM.test(String(trashId))) throw fail('Trash ID tidak valid.');
    return this.lock(`trash:${trashId}`, async () => {
      const metadata = JSON.parse(await fs.readFile(await this.stateFile(['trash', trashId, 'metadata.json']), 'utf8'));
      const buffer = await fs.readFile(await this.stateFile(['trash', trashId, 'note.md'])); if (buffer.length > MAX_FILE) throw fail('Trash terlalu besar.');
      if (metadata.revision && digest(buffer) !== metadata.revision) throw fail('Checksum trash tidak cocok.', 409);
      const restored = await this.write(targetPath || metadata.id, utf8(buffer), null);
      metadata.restoredTo = [...(Array.isArray(metadata.restoredTo) ? metadata.restoredTo : []), { path: restored.id, date: new Date().toISOString() }]; await this.writeState(['trash', trashId, 'metadata.json'], metadata);
      return restored;
    });
  }
  async doctor() {
    const result = { root: this.root, stateRoot: this.stateRoot, readOnly: this.readOnly, locks: [], incompleteTransactions: [], conflicts: [], warnings: [...this.warnings] };
    const names = async directory => fs.readdir(directory).catch(e => { if (absent(e)) return []; throw e; });
    for (const name of await names(await this.statePath(['locks']))) {
      if (name.endsWith('.recovery')) { result.locks.push({ id: name, state: 'recovery-marker', action: 'Inspect owning process before manual recovery.' }); continue; }
      try { const owner = JSON.parse(await fs.readFile(await this.stateFile(['locks', name, 'owner.json']), 'utf8')); result.locks.push({ id: name, owner, state: alive(owner) === false ? 'dead-owner-recoverable' : 'active-or-unknown' }); }
      catch (e) { result.locks.push({ id: name, state: 'unknown-owner', error: e.message }); }
    }
    for (const name of await names(await this.statePath(['transactions']))) {
      if (!name.endsWith('.json')) continue;
      try { const item = JSON.parse(await fs.readFile(await this.stateFile(['transactions', name]), 'utf8')); if (item.phase !== 'committed') { const current = await readOptional(await this.safe(item.path)); result.incompleteTransactions.push({ ...item, currentRevision: current === undefined ? null : digest(current), targetMatchesPrepared: current !== undefined && digest(current) === item.newRevision }); } }
      catch (e) { result.incompleteTransactions.push({ id: name, error: e.message }); }
    }
    for (const name of await names(await this.statePath(['conflicts']))) if (name.endsWith('.json')) { try { result.conflicts.push(JSON.parse(await fs.readFile(await this.stateFile(['conflicts', name]), 'utf8'))); } catch (e) { result.warnings.push(`${name}: ${e.message}`); } }
    return result;
  }
  async retentionPlan({ olderThanDays = 90, keepPerNote = 50 } = {}) {
    if (!Number.isFinite(olderThanDays) || olderThanDays < 1 || !Number.isInteger(keepPerNote) || keepPerNote < 1) throw fail('Parameter retention tidak valid.');
    const cutoff = Date.now() - olderThanDays * 86400000, candidates = [];
    const root = await this.statePath(['history']); const groups = await fs.readdir(root).catch(e => { if (absent(e)) return []; throw e; });
    for (const key of groups.filter(n => /^[a-f0-9]{64}$/.test(n))) {
      const directory = await this.statePath(['history', key]); const files = (await fs.readdir(directory)).filter(n => VERSION.test(n)).sort().reverse();
      for (const version of files.slice(keepPerNote)) if (Number(version.split('-')[0]) < cutoff) { const s = await fs.stat(await this.stateFile(['history', key, version])); candidates.push({ area: 'history', key, version, bytes: s.size }); }
    }
    return { dryRun: true, deletesNothing: true, olderThanDays, keepPerNote, candidates, bytes: candidates.reduce((n, c) => n + c.bytes, 0) };
  }
}
