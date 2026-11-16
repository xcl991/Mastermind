---
tags: [ai, tokens, workflow]
aliases: [Hemat token]
---
# Token-efficient workflow

Mastermind mengurangi konteks yang perlu Anda kirim ke model: cari sumber secara lokal, pilih cuplikan, baru minta AI menjawab.

## Alur yang disarankan

1. Panggil get_context dengan pertanyaan spesifik dan budget 1000.
2. Gunakan kutipan path:line untuk memeriksa sumber.
3. Jika path/heading diketahui, gunakan get_section. Profil research menyediakan read_note untuk rentang baris.
4. Gunakan get_backlinks atau find_path untuk menelusuri hubungan.
5. Hindari membaca seluruh vault atau graph untuk setiap pertanyaan.

## Caching

Indeks mempertahankan hasil parsing file yang tidak berubah. Pencarian lokal memakai ranking BM25 sederhana dan menambahkan beberapa tetangga graph.

Caching indeks menghemat pekerjaan lokal; penghematan token API berasal dari konteks yang lebih kecil. Keduanya adalah hal yang berbeda.

## Pengukuran

Panel Konteks AI menampilkan estimasi ukuran konteks terpilih dan seluruh vault. Estimator byte UTF-8 dibagi tiga bukan tokenizer model, sehingga angka ini bukan tagihan.

Tidak ada embedding API, vector database, atau panggilan model dalam Mastermind. Client AI tetap dapat mengirim prompt sistem, histori percakapan, dan definisi tool yang ikut memakai token.

Terhubung dengan [[Knowledge graph]], [[Architecture/Local-first]], dan [[Projects/Mastermind roadmap]].


Delta hanya digunakan jika hasil sebelumnya masih ada dalam konteks agent. Reset sesi setelah compaction. Finding yang disimpan dengan source receipts dikeluarkan dari retrieval ketika revisi sumber berubah.
