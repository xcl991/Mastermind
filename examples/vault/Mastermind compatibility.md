---
tags: [markdown, interoperability]
---
# Mastermind compatibility

Gunakan folder vault Markdown sebagai direktori data Mastermind. Tidak perlu memindahkan atau mengonversi file Markdown.

## Didukung

- File .md dan folder bersarang.
- Frontmatter YAML dipertahankan di file sumber.
- Wikilinks, aliases, tautan Markdown, tags, dan backlinks.
- Lampiran gambar lokal pada path eksplisit.
- Impor/ekspor JSON Canvas sebagai graph dan editor kartu/edge `.canvas`.
- Heading/block retrieval dan embed, callout, highlights/comments, rumus KaTeX, reference links, serta pemulihan riwayat.
- Subset Dataview TABLE/LIST/TASK dan Bases table/list.
- Template, properti, rename dengan backlink preview dan jurnal rollback.

## Belum didukung

Runtime plugin JavaScript eksternal, DataviewJS, seluruh fungsi Dataview/Bases, Sync, Publish, serta seluruh variasi resolusi link editor lain.

Kesehatan membaca daftar ID plugin pada pengaturan editor asal untuk inventaris saja; kode plugin tidak dijalankan. Seluruh metadata asli tetap berada di vault. File yang diubah disimpan dengan riwayat lokal.

Baca [[Welcome]] dan [[Architecture/Local-first]].

