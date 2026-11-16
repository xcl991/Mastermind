---
tags: [architecture, privacy]
---
# Local-first

Markdown adalah sumber kebenaran. Tidak ada database eksternal, layanan cloud, login, atau API key yang diperlukan.

## Penyimpanan

Server membaca file langsung dari vault. Penulisan memakai file sementara dan rename. Hash revisi mencegah penimpaan perubahan yang sudah terlihat sebelum penyimpanan.

Riwayat ada di .mastermind/history. Catatan yang dibuang disimpan di .mastermind/trash.

## Performa

Frontend memakai JavaScript native dan Canvas 2D. Tidak ada bundel Electron atau framework frontend. Enam dependensi runtime langsung menyediakan parsing AST/Markdown/YAML, sanitasi, ignore rules, dan ZIP. CodeMirror dibundel sebagai editor lokal.

Graph dihitung dari indeks yang sama dengan [[Knowledge graph]] dan [[Token-efficient workflow]]. Graph komunitas pada UI dikelompokkan berdasarkan folder, bukan Leiden.

## Keterbatasan

Jangan menulis file yang sama secara serentak dengan editor lain saat save sedang berlangsung. Editor eksternal tidak mengikuti lock Mastermind. Klik muat ulang untuk membaca perubahan eksternal.

Lihat [[Projects/Mastermind roadmap]].

