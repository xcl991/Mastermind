import { unzipSync } from 'fflate';
import { digest, fail } from './vault.mjs';

const ZIP_LIMIT = 8 * 1024 * 1024, EXPANDED_LIMIT = 16 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const table = Uint32Array.from({ length: 256 }, (_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ n >>> 1 : n >>> 1; return n >>> 0; });
const crc32 = bytes => { let n = 0xffffffff; for (const byte of bytes) n = table[(n ^ byte) & 255] ^ n >>> 8; return (n ^ 0xffffffff) >>> 0; };

export function parseRestoreArchive(vault, archiveBase64) {
  if (typeof archiveBase64 !== 'string' || !archiveBase64.length || archiveBase64.length > Math.ceil(ZIP_LIMIT / 3) * 4 || archiveBase64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(archiveBase64)) throw fail('ZIP harus base64 valid, maksimum 8 MiB.', 413);
  const zip = Buffer.from(archiveBase64, 'base64');
  if (zip.length > ZIP_LIMIT || zip.length < 22) throw fail('ZIP tidak valid atau terlalu besar.', 413);
  let end = -1;
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 65557); at--) if (zip.readUInt32LE(at) === 0x06054b50 && at + 22 + zip.readUInt16LE(at + 20) === zip.length) { end = at; break; }
  if (end < 0) throw fail('Direktori ZIP tidak ditemukan.');
  const count = zip.readUInt16LE(end + 10), centralSize = zip.readUInt32LE(end + 12), centralOffset = zip.readUInt32LE(end + 16);
  if (zip.readUInt16LE(end + 4) || zip.readUInt16LE(end + 6) || zip.readUInt16LE(end + 8) !== count || count > 301 || count === 0xffff || centralOffset + centralSize !== end) throw fail('ZIP multi-disk/ZIP64 atau jumlah file tidak didukung.');
  const members = [], names = new Set(); let offset = centralOffset, expanded = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || zip.readUInt32LE(offset) !== 0x02014b50) throw fail('Central directory ZIP tidak valid.');
    const flags = zip.readUInt16LE(offset + 8), method = zip.readUInt16LE(offset + 10), crc = zip.readUInt32LE(offset + 16), compressed = zip.readUInt32LE(offset + 20), size = zip.readUInt32LE(offset + 24), nameSize = zip.readUInt16LE(offset + 28), extraSize = zip.readUInt16LE(offset + 30), commentSize = zip.readUInt16LE(offset + 32), disk = zip.readUInt16LE(offset + 34), mode = zip.readUInt32LE(offset + 38) >>> 16, local = zip.readUInt32LE(offset + 42);
    if (offset + 46 + nameSize + extraSize + commentSize > end || flags & 1 || ![0, 8].includes(method) || disk || compressed === 0xffffffff || size === 0xffffffff || local === 0xffffffff) throw fail('Enkripsi atau kompresi ZIP tidak didukung.');
    const rawName = zip.subarray(offset + 46, offset + 46 + nameSize);
    if (!(flags & 0x800) && [...rawName].some(b => b >= 128)) throw fail('Nama ZIP non-ASCII harus UTF-8.');
    let name; try { name = decoder.decode(rawName); } catch { throw fail('Nama file ZIP bukan UTF-8 valid.'); }
    const folded = name.normalize('NFC').toLowerCase(); if (names.has(folded)) throw fail('Path ZIP duplikat atau berbeda kapitalisasi.'); names.add(folded);
    const directory = name.endsWith('/'), id = directory ? name.slice(0, -1) : name;
    vault.validate(id);
    if (mode && (mode & 0xf000) !== (directory ? 0x4000 : 0x8000) && (mode & 0xf000) !== 0) throw fail('Symlink dan tipe file khusus ZIP ditolak.', 403);
    if (!directory && !/\.md$/i.test(name) && name !== 'mastermind-backup-manifest.json') throw fail('Restore ZIP hanya menerima catatan .md dan manifest Mastermind.');
    if (directory && size) throw fail('Direktori ZIP tidak boleh berisi data.');
    expanded += size; if (size > 2 * 1024 * 1024 || expanded > EXPANDED_LIMIT) throw fail('ZIP terurai melebihi 2 MiB/file atau 16 MiB total.', 413);
    if (local + 30 > centralOffset || zip.readUInt32LE(local) !== 0x04034b50 || zip.readUInt16LE(local + 6) !== flags || zip.readUInt16LE(local + 8) !== method) throw fail('Local header ZIP tidak cocok.');
    const localNameSize = zip.readUInt16LE(local + 26), localExtraSize = zip.readUInt16LE(local + 28), dataStart = local + 30 + localNameSize + localExtraSize;
    if (dataStart + compressed > centralOffset || !zip.subarray(local + 30, local + 30 + localNameSize).equals(rawName)) throw fail('Nama/rentang member ZIP tidak cocok.');
    members.push({ name, size, crc, directory, local, dataEnd: dataStart + compressed });
    offset += 46 + nameSize + extraSize + commentSize;
  }
  if (offset !== end) throw fail('Batas direktori ZIP tidak cocok.');
  const ordered = [...members].sort((a, b) => a.local - b.local);
  if (ordered.some((m, i) => i && ordered[i - 1].dataEnd > m.local)) throw fail('Member ZIP bertumpuk.');
  let unpacked; try { unpacked = unzipSync(zip, { filter: member => member.originalSize <= 2 * 1024 * 1024 }); } catch { throw fail('ZIP tidak dapat dibaca.'); }
  const files = []; let manifest;
  for (const member of members) {
    const bytes = unpacked[member.name]; if (!bytes || bytes.length !== member.size || crc32(bytes) !== member.crc) throw fail('Ukuran/CRC ZIP tidak cocok: ' + member.name);
    if (member.directory) continue;
    let content; try { content = decoder.decode(bytes); } catch { throw fail('Isi catatan bukan UTF-8 valid: ' + member.name); }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content)) throw fail('Isi binary/control character tidak didukung.');
    if (member.name === 'mastermind-backup-manifest.json') { try { manifest = JSON.parse(content); } catch { throw fail('Manifest backup bukan JSON valid.'); } }
    else files.push({ path: member.name, content, bytes: bytes.length, revision: digest(bytes) });
  }
  if (!files.length || files.length > 300) throw fail('ZIP harus memiliki 1–300 catatan Markdown.');
  if (manifest) {
    if (!Array.isArray(manifest.files) || manifest.files.length !== files.length) throw fail('Jumlah file manifest tidak cocok.');
    const wanted = new Map();
    for (const item of manifest.files) { if (!item || typeof item.path !== 'string' || typeof item.revision !== 'string' || wanted.has(item.path)) throw fail('Manifest file tidak valid.'); wanted.set(item.path, item.revision); }
    for (const file of files) if (wanted.get(file.path) !== file.revision) throw fail('Checksum manifest tidak cocok: ' + file.path, 409);
  }
  return { archiveHash: digest(zip), files: files.sort((a, b) => a.path.localeCompare(b.path)), bytes: expanded };
}
