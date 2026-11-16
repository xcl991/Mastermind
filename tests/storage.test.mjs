import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Vault, digest } from '../src/vault.mjs';
const moduleURL = new URL('../src/vault.mjs', import.meta.url).href;
async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'mastermind-storage-')), root = path.join(base, 'vault');
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const vault = await new Vault(root).init(); return { base, root, vault };
}
async function snapshot(root) {
  const result = {};
  async function walk(directory) {
    for (const e of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, e.name), s = await fs.lstat(file), id = path.relative(root, file);
      result[id] = { mode: s.mode, mtime: s.mtimeMs, size: s.size, hash: e.isFile() ? digest(await fs.readFile(file)) : null };
      if (e.isDirectory()) await walk(file);
    }
  }
  await walk(root); return result;
}
function child(t, script) {
  const p = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = ''; p.stdout.on('data', b => output += b); p.stderr.on('data', b => errors += b);
  const completion = once(p, 'close').then(([code]) => ({ code, output, errors }));
  t.after(async () => { if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL'); await completion; });
  return { p, completion, ready: async () => {
    const until = Date.now() + 10000;
    while (!output.includes('READY')) { if (p.exitCode !== null || p.signalCode !== null) throw new Error(errors || output); if (Date.now() > until) throw new Error('child ready timeout'); await new Promise(r => setTimeout(r, 10)); }
  } };
}
test('read-only source remains byte-for-byte unchanged; state is external and missing roots are never created', async t => {
  const { base, root } = await fixture(t);
  await fs.writeFile(path.join(root, 'Note.md'), '# Source\n');
  const before = await snapshot(root), external = path.join(base, 'state');
  const vault = await new Vault(root, { readOnly: true, stateDir: external }).init();
  await vault.list(); await vault.read('Note.md'); await vault.internal('index'); await vault.writeState(['index', 'cache.json'], { ok: true }); await vault.doctor();
  for (const op of [() => vault.write('New.md', 'x', null), () => vault.trash('Note.md', digest('# Source\n')), () => vault.restoreHistory('Note.md', 'invalid', null), () => vault.restoreTrash('invalid')]) await assert.rejects(op(), { status: 403 });
  await assert.rejects(vault.durableFile(path.join(root, 'Note.md'), 'forbidden'), { status: 403 });
  assert.deepEqual(await snapshot(root), before);
  const plain = await new Vault(root, { readOnly: true }).init(); await plain.internal('no-create'); await plain.doctor();
  await assert.rejects(plain.writeState(['x.json'], { x: 1 }), { status: 403 });
  assert.deepEqual(await snapshot(root), before);
  const missing = path.join(base, 'missing'); await assert.rejects(new Vault(missing, { readOnly: true }).init(), { code: 'ENOENT' });
  await assert.rejects(fs.stat(missing), { code: 'ENOENT' });
  await assert.rejects(new Vault(root, { readOnly: true, stateDir: path.join(root, 'state') }).init(), { status: 403 });
});
test('ignore files, explicit excludes and credential filters constrain a mixed document index', async t => {
  const { root } = await fixture(t); await fs.mkdir(path.join(root, 'nested'));
  const files = {
    '.gitignore': '*.txt\n', '.mastermindignore': '!keep.txt\nhidden.json\n', 'keep.txt': 'keep', 'ignored.txt': 'ignored',
    'Note.md': '# Note', 'page.mdx': '# MDX', 'page.html': '<h1>HTML</h1>', 'style.css': 'body {}', 'data.json': '{}',
    'config.yaml': 'a: 1', 'config.yml': 'a: 1', 'code.js': 'export const x=1', 'private.json': '{}', 'hidden.json': '{}',
    'credentials.json': 'secret', 'secrets.yaml': 'secret', 'bundle.min.js': 'minified',
    'nested/.gitignore': '!child.txt\n!private.json\n', 'nested/child.txt': 'child', 'nested/private.json': 'secret'
  };
  for (const [id, content] of Object.entries(files)) await fs.writeFile(path.join(root, id), content);
  const vault = await new Vault(root, { exclude: ['**/private.json'] }).init();
  assert.deepEqual([...vault.entries.keys()].sort(), ['Note.md', 'code.js', 'config.yaml', 'config.yml', 'data.json', 'keep.txt', 'nested/child.txt', 'page.html', 'page.mdx', 'style.css'].sort());
  assert.equal(vault.entries.get('Note.md').type, 'note'); assert.equal(vault.entries.get('code.js').type, 'code'); assert.equal(vault.entries.get('page.mdx').type, 'document');
  await assert.rejects(vault.read('credentials.json'), { status: 403 }); await assert.rejects(vault.read('nested/private.json'), { status: 403 });
  await assert.rejects(vault.write('data.json', '{}', null));
});
test('real processes serialize case aliases on case-insensitive filesystems', async t => {
  const { root, vault } = await fixture(t), original = await vault.write('Note.md', 'original', null);
  try { await fs.stat(path.join(root, 'note.md')); } catch { t.skip('Filesystem is case-sensitive'); return; }
  const processes = ['Note.md', 'note.md'].map((id, i) => child(t, `import { Vault } from ${JSON.stringify(moduleURL)}; const v = await new Vault(${JSON.stringify(root)}).init(); console.log('READY'); await new Promise(r=>process.stdin.once('data',r)); try { await v.write(${JSON.stringify(id)},'writer-${i}',${JSON.stringify(original.revision)}); console.log('OK'); } catch(e) { console.log('ERROR '+e.status); } process.stdin.destroy();`));
  await Promise.all(processes.map(p => p.ready())); for (const p of processes) p.p.stdin.end('GO');
  const results = await Promise.all(processes.map(p => p.completion)); assert.ok(results.every(r => r.code === 0), JSON.stringify(results));
  assert.equal(results.filter(r => r.output.includes('OK')).length, 1); assert.equal(results.filter(r => r.output.includes('ERROR 409')).length, 1);
  assert.match((await vault.read('Note.md')).content, /^writer-[01]$/);
});
test('live owner is never expired; killed child owner is safely recovered', async t => {
  const { root, vault } = await fixture(t), original = await vault.write('Note.md', 'original', null);
  const worker = child(t, `import { Vault } from ${JSON.stringify(moduleURL)}; const v = await new Vault(${JSON.stringify(root)}).init(); process.stdin.resume(); await v.lock('Note.md', async()=>{ console.log('READY'); await new Promise(()=>{}); });`);
  await worker.ready();
  if (worker.p.exitCode !== null) throw new Error('Lock child exited prematurely');
  const locks = (await vault.doctor()).locks; assert.equal(locks.length, 1);
  const ownerFile = path.join(vault.stateRoot, 'locks', locks[0].id, 'owner.json'), owner = JSON.parse(await fs.readFile(ownerFile, 'utf8'));
  owner.createdAt = '2000-01-01T00:00:00Z'; await fs.writeFile(ownerFile, JSON.stringify(owner));
  await assert.rejects(vault.write('note.md', 'blocked', original.revision), { status: 409 });
  worker.p.kill('SIGKILL'); await worker.completion;
  assert.equal((await vault.doctor()).locks[0].state, 'dead-owner-recoverable');
  await vault.write('Note.md', 'recovered', original.revision); assert.equal((await vault.read('Note.md')).content, 'recovered'); assert.deepEqual((await vault.doctor()).locks, []);
});
test('history restores with revision checks, checksum validation, and retained originals', async t => {
  const { vault } = await fixture(t); const initial = await vault.write('Note.md', '\uFEFF# Initial\r\n', null), next = await vault.write('Note.md', '# Next', initial.revision);
  const [version] = await vault.history('Note.md'); assert.equal(version.revision, initial.revision); assert.equal(version.bytes, Buffer.byteLength(initial.content));
  assert.equal((await vault.historyRead('Note.md', version.version)).content, initial.content);
  await assert.rejects(vault.restoreHistory('Note.md', version.version, initial.revision), { status: 409 });
  const restored = await vault.restoreHistory('Note.md', version.version, next.revision); assert.equal(restored.content, initial.content); assert.equal((await vault.history('Note.md')).length, 2);
  const historyFile = path.join(vault.stateRoot, 'history', digest('Note.md'), version.version); await fs.writeFile(historyFile, 'corrupt');
  await assert.rejects(vault.restoreHistory('Note.md', version.version, restored.revision), /Checksum/); assert.equal((await vault.read('Note.md')).content, initial.content);
});
test('trash restore cannot overwrite a new note and can restore to another path while retaining original', async t => {
  const { vault } = await fixture(t); const old = await vault.write('Note.md', '# Preserve\r\n', null), deleted = await vault.trash('Note.md', old.revision);
  assert.equal((await vault.listTrash())[0].status, 'trashed'); await vault.write('Note.md', '# New', null);
  await assert.rejects(vault.restoreTrash(deleted.trashId), { status: 409 });
  assert.equal((await vault.read('Note.md')).content, '# New'); assert.equal((await vault.restoreTrash(deleted.trashId, 'Recovered/Note.md')).content, old.content);
  const [record] = await vault.listTrash(); assert.equal(record.restoredTo[0].path, 'Recovered/Note.md');
  const trashFile = path.join(vault.stateRoot, 'trash', deleted.trashId, 'note.md'); assert.equal(await fs.readFile(trashFile, 'utf8'), old.content);
  await fs.writeFile(trashFile, 'corrupt'); await assert.rejects(vault.restoreTrash(deleted.trashId, 'Again.md'), /Checksum/);
});
test('revision recheck preserves external edits and archives conflicting drafts', async t => {
  const { vault, root } = await fixture(t), original = await vault.write('Note.md', 'original', null), realWriteState = vault.writeState.bind(vault);
  let injected = false;
  vault.writeState = async (parts, value) => { const result = await realWriteState(parts, value); if (parts[0] === 'transactions' && value.phase === 'prepared' && !injected) { injected = true; await fs.writeFile(path.join(root, 'Note.md'), 'external'); } return result; };
  await assert.rejects(vault.write('Note.md', 'draft', original.revision), { status: 409 }); assert.equal((await vault.read('Note.md')).content, 'external');
  const doctor = await vault.doctor(); assert.equal(doctor.conflicts.length, 1); assert.equal(doctor.incompleteTransactions[0].phase, 'conflict');
  assert.equal(await fs.readFile(path.join(vault.stateRoot, 'conflicts', `${doctor.conflicts[0].draftId}.md`), 'utf8'), 'draft');
  assert.equal((await vault.historyRead('Note.md', (await vault.history('Note.md'))[0].version)).content, 'original');
});
test('interrupted prepared write leaves a discoverable recoverable draft and source intact', async t => {
  const { vault, root } = await fixture(t), original = await vault.write('Note.md', 'original', null), realWriteState = vault.writeState.bind(vault);
  vault.writeState = async (parts, value) => { await realWriteState(parts, value); if (parts[0] === 'transactions' && value.phase === 'prepared') throw new Error('simulated interruption'); };
  await assert.rejects(vault.write('Note.md', 'recover me', original.revision), /simulated interruption/);
  const [transaction] = (await vault.doctor()).incompleteTransactions; assert.equal(transaction.phase, 'prepared'); assert.equal(transaction.targetMatchesPrepared, false);
  assert.equal(await fs.readFile(path.join(root, transaction.temporary), 'utf8'), 'recover me'); assert.equal((await vault.read('Note.md')).content, 'original');
});
test('forced refresh during an active scan queues a subsequent pass', async t => {
  const { vault, root } = await fixture(t); const scan = vault.scan.bind(vault); let entered, release, calls = 0;
  const enteredPromise = new Promise(r => entered = r), gate = new Promise(r => release = r);
  vault.scan = async () => { calls++; await scan(); if (calls === 1) { entered(); await gate; } };
  const first = vault.refresh(true); await enteredPromise; await fs.writeFile(path.join(root, 'Late.md'), 'late');
  const second = vault.refresh(true); release(); await Promise.all([first, second]); assert.equal(calls, 2); assert.equal(vault.entries.get('Late.md').content, 'late');
});
test('directory rename/removal during scan yields warnings and preserves readable entries', async t => {
  const { root, vault } = await fixture(t); await fs.writeFile(path.join(root, 'a.md'), 'a'); await fs.mkdir(path.join(root, 'z')); await fs.writeFile(path.join(root, 'z', 'b.md'), 'b');
  const readdir = fs.readdir; let removed = false;
  fs.readdir = async (...args) => { const result = await readdir(...args); if (args[0] === vault.root && !removed) { removed = true; await fs.rm(path.join(root, 'z'), {recursive: true}); } return result; };
  try { await vault.refresh(true); assert.equal(vault.entries.get('a.md').content, 'a'); assert.ok(vault.warnings.some(w => w.includes('z:') && w.includes('ENOENT'))); } finally { fs.readdir = readdir; }
});
test('retention only plans eligible versions and never deletes history', async t => {
  const { vault } = await fixture(t), directory = await vault.internal('history', digest('Note.md'));
  const versions = [120, 110, 100].map(days => `${Date.now() - days * 86400000}-${randomUUID()}.md`);
  for (const version of versions) await fs.writeFile(path.join(directory, version), version);
  const plan = await vault.retentionPlan({ olderThanDays: 90, keepPerNote: 1 }); assert.equal(plan.dryRun, true); assert.equal(plan.deletesNothing, true); assert.equal(plan.candidates.length, 2); assert.deepEqual((await fs.readdir(directory)).sort(), versions.sort());
});
