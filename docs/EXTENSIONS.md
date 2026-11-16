# Ekstensi dan format workspace

Mastermind menjalankan ekstensi deklaratif lokal. Import manifest JSON melalui halaman **Ekstensi**, periksa daftar command/permission, lalu aktifkan. Import selalu disabled. Enable/disable/remove mengubah state Mastermind; file vault tidak berubah sampai pengguna menjalankan command template dan menyimpan catatan baru.

Contoh tersedia di [research-workspace.json](../examples/extensions/research-workspace.json):

```json
{
  "schemaVersion": 1,
  "id": "my-workspace",
  "name": "My workspace",
  "version": "1.0.0",
  "commands": [
    {"id":"tasks","name":"Tugas terbuka","type":"query","query":"TASK WHERE !completed"},
    {"id":"meeting","name":"Rapat baru","type":"template","template":"# {{title}}\nDate: {{date}}\n"}
  ],
  "theme": {"accent":"#91d5b5"}
}
```

Manifest menerima `schemaVersion`, `id`, `name`, `version`, `description`, `commands`, dan `theme`. Field lain ditolak. ID string huruf kecil/angka/tanda hubung, command ID unik; maksimal 20 command, 50 instalasi, dan registry 1 MiB. Query dibatasi 4.096 karakter; template 16.000 karakter. Tema hanya warna hex `accent`, `background`, `text`; tidak ada CSS/URL arbitrer. Permission `vault:read` dan `vault:create` diturunkan dari tipe command. Tidak ada permission shell, network, filesystem luar vault, script, atau runtime `main.js`.

State berada di `.mastermind/extensions.json` (atau `state-dir` pilihan). Registry ditulis dengan lock dan penyimpanan durable. Di vault read-only, perubahan registry dan template ditolak; query tetap tersedia. Command aktif muncul di halaman Ekstensi dan command palette. Jika beberapa tema aktif memberi field sama, nilai ekstensi yang diproses terakhir berlaku; nonaktifkan tema lain untuk pilihan yang deterministik dari pengguna.

Halaman **Kesehatan** membaca `community-plugins.json` dari maksimal 32 direktori pengaturan tersembunyi pada root workspace, tanpa memuat kode plugin. ID yang sama digabung; maksimal 200 plugin ditampilkan melalui field `pluginInventory`. Dataview ditandai tersedia sebagai subset query asli; ID lainnya membutuhkan runtime editor asal. Manifest dan JavaScript plugin editor lain bukan manifest Mastermind. Tidak ada janji binary/API compatibility plugin editor eksternal.

## Markdown dan lampiran

Preview mendukung wikilink, heading/block embeds, callout (termasuk lipat `+`/`-`), `==highlight==`, komentar `%%…%%`, matematika `$…$`/`$$…$$` melalui KaTeX lokal, serta fenced `dataview` dan `base`. Skrip DataviewJS tidak dieksekusi. Untuk block ID, gunakan ID pada akhir paragraf yang berisi bukti; sintaks block kompleks dari editor lain tidak seluruhnya setara.

Embed dibatasi kedalaman 3, 12 embed dan 8 query per render; siklus dihentikan. Bagian sumber maksimum 24.000 karakter dan ditandai saat dipotong. File media harus berada dalam vault, dengan MIME/ekstensi yang didukung. SVG/HTML tidak disajikan sebagai lampiran aktif. Audio/video menggunakan streaming HTTP Range; PDF dibuka melalui browser, bukan diparsing menjadi pengetahuan. Maksimal 128 MiB per lampiran. Berkas tersembunyi/symlink/traversal ditolak. Gambar remote tidak dimuat otomatis.

## Canvas dan Bases

File `.canvas` menggunakan JSON Canvas: kartu teks/file/link/group dan edges. Editor menyediakan create/open, edit teks, drag, hapus kartu, tambah edge, dan simpan dengan pemeriksaan revision. Metadata tambahan dipertahankan. Batas file 2 MiB, 5.000 nodes, 20.000 edges; editor menampilkan maksimal 200 kartu. Posisi negatif diperhitungkan, tetapi ini bukan editor Canvas lengkap (resize/group interactions/custom node extensions belum tersedia).

File `.base` diindeks sebagai dokumen dan ditampilkan melalui adapter query. Buat/edit melalui `write_document` MCP, API `/api/document`, atau editor YAML eksternal. Dukungan view/filter dijelaskan di [QUERY.md](QUERY.md). Formula, JavaScript, dan custom views tidak dijalankan. Validasi struktur file saat simpan bukan jaminan semua opsi dapat dievaluasi; interpreter melaporkan opsi tidak didukung.

Endpoint structured document hanya dapat menulis `.base`/`.canvas`. Penulisan file kode arbitrer tetap ditolak. Untuk update, kirim `expectedRevision` terkini; `null` hanya untuk create. History restore menggunakan validator format yang sama.
