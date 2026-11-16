---
tags: [knowledge, graph]
---
# Knowledge graph

Graph menghubungkan catatan melalui wikilinks, tautan Markdown, dan tags. Setiap koneksi mempertahankan jenis hubungannya.

[[Welcome]] adalah pintu masuk. [[Token-efficient workflow]] menggunakan hubungan graph untuk menambahkan konteks dari catatan tetangga.

## Bukti dan inferensi

Wikilink eksplisit ditandai EXTRACTED. Import kode yang ditemukan oleh pemindai teks ditandai INFERRED, karena bukan hasil resolusi AST.

File graph.json dari workspace lain dapat diimpor melalui tab Knowledge graph. Metadata sumber, confidence, dan arah edge dipertahankan. JSON Canvas dapat diekspor untuk dibuka di editor Canvas yang kompatibel.

## Batas tampilan

Canvas membatasi tampilan ke 350 node agar tetap responsif. Pencarian mempersempit node yang ditampilkan. Seluruh graph tetap dapat diekspor.

Lihat [[Architecture/Local-first]] dan [[Mastermind compatibility]].

