# Query catatan dan tugas

Mastermind menyediakan interpreter query lokal **subset DQL** untuk metadata workspace. Query tidak mengeksekusi JavaScript, plugin, akses jaringan, atau perubahan file. Sintaks yang tidak didukung menghasilkan error, bukan hasil yang diam-diam mengabaikan bagian query.

```dataview
TABLE status, priority AS "Prioritas", file.folder
FROM "Projects" AND #project
WHERE status != "done" AND priority >= 2
SORT priority DESC, file.name ASC
LIMIT 50
```

```dataview
TASK
FROM #project
WHERE !completed AND due <= date("2026-12-01")
SORT due ASC
```

```dataview
LIST WITHOUT ID file.name
FROM #reference OR "Knowledge"
WHERE contains(file.tags, "#research")
```

## Cakupan sintaks

- `TABLE`: nol sampai 20 kolom, alias `AS "Nama"`, opsional `WITHOUT ID`.
- `LIST`: nol atau satu nilai tambahan, opsional `WITHOUT ID`.
- `TASK`: baris task dengan path, revision, nomor baris satu-based, teks, dan status. Query sendiri selalu read-only.
- `FROM`: quoted folder/file, `#tag` termasuk subtags, kombinasi `AND`/`OR`, negasi `-`, `!`, `NOT`, tanda kurung. Folder memakai batas segmen sehingga `"Foo"` tidak mencakup `Foobar`. Satu `FROM` harus berada sebelum command lain.
- `WHERE`: boolean, `=`, `==`, `!=`, `<`, `<=`, `>`, `>=`, `AND`, `OR`, `!`, `NOT`, tanda kurung. Perbandingan number/string tidak melakukan coercion; nilai hilang adalah null, dan ordering terhadap null bernilai false.
- `SORT`: sampai delapan ekspresi, `ASC`/`DESC`/`ASCENDING`/`DESCENDING`; null diletakkan terakhir. Tie mempertahankan urutan input.
- `LIMIT`: integer 0–50.000. `WHERE`, `SORT`, dan `LIMIT` berjalan sesuai urutan penulisan dan boleh diulang. Pagination API diterapkan setelah pipeline.
- Ekspresi: literal string/angka/boolean/null, field bertitik, `+ - * / %` untuk angka, `+` untuk dua string. Pembagian nol menghasilkan null. Identifier bertanda `-` adalah nama field; gunakan spasi untuk pengurangan (`a - b`).
- Fungsi: `contains`, `length`, `lower`, `upper`, `default`, `startswith`, `endswith`, `choice`, `date`. `date` hanya menerima tanggal ISO quoted `YYYY-MM-DD` yang valid, bukan `today`, duration, atau timezone calculations.

`GROUP BY`, `FLATTEN`, `CALENDAR`, JavaScript/DataviewJS, lambdas, regex functions, method arbitrary, bracket field access, link-source expressions, dan semua fungsi lain ditolak secara eksplisit. Field dengan nama keyword query belum bisa diakses melalui syntax bracket. `file.link` merupakan path string, bukan objek Link khusus editor lain.

## Metadata

Frontmatter YAML menjadi field biasa; nested object dapat ditelusuri dengan `thoughts.rating`. Key inline mendukung `Key:: value` pada baris sendiri dan `[key:: value]` dalam paragraf. Key formatting dihapus; alias lowercase dengan spasi menjadi `-` tersedia. Nilai berulang dikumpulkan sebagai array. Nilai inline sederhana mendukung boolean/null/angka, string, atau JSON array. Tanggal tetap string ISO.

Fenced/indented code, HTML, komentar workspace dan inline code tidak dianggap metadata. Task memiliki inline `[due:: ...]` sendiri; metadata task tidak bocor menjadi field page. Parenthetical inline field, emoji date shorthand, list non-task metadata, dan blockquote tidak termasuk subset saat ini.

Field implisit:

| Field | Isi |
| --- | --- |
| `file.name`, `file.path`, `file.folder`, `file.ext`, `file.link` | Identitas file Markdown |
| `file.size` | Byte UTF-8 |
| `file.mtime`, `file.mday` | Waktu modifikasi ISO dari indeks; null jika metadata waktunya tidak tersedia |
| `file.tags` | Tags `#...` dengan hierarki subtags |
| `file.etags` | Hanya tags eksplisit |
| `file.aliases`, `file.outlinks` | Alias dan target link lokal dari parser vault |
| `file.tasks` | Tasks standard `[ ]`/`[x]`/`[X]` beserta lokasi/revisi |

`file.ctime`, `file.inlinks`, `file.lists`, bookmark state, dan objek date/Link penuh tidak disediakan. Field yang tidak ada tetap null. `TASK` mengembalikan task secara datar: anak hanya lolos jika memenuhi predikatnya sendiri. Ini berbeda dari pewarisan hasil parent-child Dataview. Custom checkbox status dan blockquoted tasks tidak diindeks. Teks task yang ditampilkan adalah baris pertama.

## Adapter Bases

`queryBase(vault, yaml, viewName?, options?)` membaca subset YAML Bases:

```yaml
filters:
  and:
    - file.hasTag("project")
properties:
  note.status:
    displayName: Status
views:
  - type: table
    name: Active
    filters: 'note.status != "done" && file.inFolder("Projects")'
    order:
      - file.name
      - note.status
    limit: 50
```

Didukung: view `table`/`list`, filter string atau pohon `and`/`or`/`not`, properti `displayName`, urutan kolom `order`, dan `limit`. Filter global dan view digabung AND. `file.hasTag` dan `file.inFolder` merupakan fungsi yang diizinkan khusus untuk kebutuhan adapter ini; tidak ada method invocation umum. `note.*` mengacu hanya pada frontmatter. Semua data yang dikueri tetap catatan Markdown, bukan attachment.

Formulas, summaries, groupBy, kanban/map/custom views, `this`, arbitrary property/method access, dan opsi lain di luar subset ditolak. Adapter ini bukan runtime Bases lengkap. View yang hilang/bernama duplikat ditolak.

## API dan batas

```js
import { queryVault, queryBase, tasksOf } from './src/query.mjs';
const result = await queryVault(vault, 'TABLE status FROM #project', { limit: 100, offset: 0 });
```

Hasil: `{ type, columns:[{key,label}], rows:[{path,revision,values,line?,task?}], total, nextOffset, truncated, warnings, compatibility, scannedFiles }`. `compatibility` adalah `mastermind-dql-subset-v1` atau `mastermind-bases-subset-v1`. `total` adalah jumlah baris setelah command `LIMIT`; gunakan `nextOffset` sampai null untuk pagination. Renderer harus menampilkan nilai sebagai teks, bukan HTML.

Batas: query 8 KiB, 1.024 syntax tokens, 512 expression nodes, nesting 32, 24 commands, 20.000 note, 50.000 record, satu juta evaluation/sort steps, maksimal 500 baris per halaman, sekitar 256 KiB serialized rows. Setiap cell memiliki budget terpisah; nilai yang dipendekkan ditandai melalui `truncated` dan `warnings`. Metadata dalam objek sangat dalam/besar dibatasi saat sanitasi; jangan mengandalkan query pada struktur lebih dari 12 level atau array lebih dari 10.000 elemen. YAML Bases maksimum 64 KiB dengan alias/filter limits. Cache metadata berbasis revision dan mtime; source yang berubah atau hilang diperbarui pada refresh indeks.

Tidak ada jaminan hasil ekuivalen dengan seluruh bahasa Dataview. Dukungan di atas diuji terpisah dan tidak memuat source runtime Dataview.
