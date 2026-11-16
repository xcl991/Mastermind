# Infrastruktur lokal Mastermind

Setup memakai Node langsung, tanpa Docker, database tambahan, atau akun cloud. Aplikasi dan MCP HTTP tetap bind `127.0.0.1`. Vault yang sudah ada dipertahankan; default state tetap `vault/.mastermind`, sehingga history/trash tidak terpisah dari data lama. Migrasi VPS menggunakan struktur yang sama dengan path absolut yang berbeda.

## Setup dan operasi harian

Dari direktori aplikasi:

```sh
npm ci --omit=dev --ignore-scripts
npm run infra:init
npm run infra:start
npm run infra:health
```

Buka http://127.0.0.1:6969. `init` membuat `infra/local.env` dengan permission privat dan tidak menimpa konfigurasi yang sudah ada. `start` menjalankan proses Node di background. Ini tidak memasang auto-start OS dan tidak membutuhkan terminal tetap terbuka. Mesin sleep/offline berarti server tidak dapat diakses.

```sh
npm run infra:status
npm run infra:logs
npm run infra:restart
npm run infra:stop
```

Perintah langsung yang setara: `node src/cli.mjs infra <command>`. Gunakan `--config /path/local.env` untuk instance terpisah. Setiap instance harus punya port/runtime/log/backup sendiri; semua penulis vault yang sama harus berbagi state directory yang sama.

`npm start` tetap tersedia sebagai server foreground lama. Jangan jalankan bersamaan pada port yang sama. Infrastruktur menolak konflik port dan tidak membunuh proses yang tidak dikelolanya. `infra run` adalah mode foreground untuk service manager Linux.

## Konfigurasi dan data persisten

Salin acuan dari [local.env.example](../infra/local.env.example). Path relatif dihitung dari direktori aplikasi, bukan current working directory shell. Environment `MASTERMIND_*` mengalahkan nilai file. Parser mengikuti [format .env Node](https://nodejs.org/api/util.html#utilparseenvcontent); tidak ada shell expansion/interpolasi `$HOME`/`$(...)`.

| Lokasi default | Fungsi |
| --- | --- |
| `infra/local.env` | Path vault/state, port, profil MCP, exclusion, bearer opsional |
| `vault/` | Markdown, Canvas/Bases, lampiran dan pengaturan vault |
| `vault/.mastermind/` | History, trash, cache, graph imports, workflow journals, extensions |
| `.local/run/` | Record/lock instance dan credential control sementara |
| `.local/logs/` | Log lifecycle dan kegagalan startup |
| `.local/backups/` | Snapshot lengkap, manifest ukuran/SHA-256 |

Runtime/log/backup tidak boleh bersarang di dalam sumber vault/state atau satu sama lain. Path diselesaikan secara kanonis untuk mendeteksi overlap melalui symlink. Konfigurasi lokal, runtime, logs, backup dan vault tidak disertakan paket source atau Git. Jangan mengganti `STATE_DIR` pada vault aktif tanpa memindahkan state lama secara terencana.

`MASTERMIND_PROFILE=minimal` adalah default hemat schema. Pilih `research` untuk query/task/health atau `full` untuk mutation tools. `MASTERMIND_READ_ONLY=true` membutuhkan state di luar vault. `MASTERMIND_EXCLUDE_JSON` berisi JSON array pola; contoh `["vendor/**","generated/**"]`. Token opsional hanya melindungi endpoint MCP, bukan login UI atau otorisasi multiuser.

## Health, shutdown, dan pemulihan proses

`infra health` memeriksa control identity dan `/api/status`; exit 0 berarti server responsif pada vault yang benar, exit nonzero berarti gagal. Ini liveness dan identitas, bukan audit semua isi vault. Audit sumber memakai Kesehatan vault di UI atau CLI `doctor`.

Layanan menyimpan PID serta token acak dalam record mode 0600. Control HTTP berada pada port loopback acak, memerlukan bearer token, menolak browser Origin, dan tidak tersedia lewat UI. Stop tidak mengirim kill ke PID dari file; ia memverifikasi identitas melalui request status terlebih dahulu, baru meminta shutdown lewat control endpoint. Respons control dibatasi 16 KiB dan redirect ditolak. Token tidak dicetak dalam status/log.

Shutdown menunggu request aktif, menutup server/control, lalu menghapus lock. Batas 15 detik mencegah shutdown menggantung; bila batas terlampaui proses keluar gagal dan record tetap untuk inspeksi. SIGTERM/SIGINT melakukan shutdown yang sama. Crash/SIGKILL dapat menyisakan lock. Periksa log dan gunakan:

```sh
node src/cli.mjs infra unlock
```

Unlock hanya berhasil bila PID owner terbukti sudah tidak ada dan control port tidak aktif. PID hidup/identitas ambigu tidak ditimpa. Lock tanpa record valid memerlukan inspeksi manual; tidak otomatis dihapus. Jangan menjalankan dua operator maintenance secara bersamaan. Mode background lokal tidak memiliki supervisor auto-restart; setelah crash, inspeksi/unlock lalu start kembali.

`service.log` dirotasi saat event ditulis, sekitar 5 MiB dengan dua file lama. `startup.log` dirotasi saat start bila melampaui 1 MiB, satu file lama. Symlink pada file log/record ditolak. Log tidak menyimpan teks catatan atau token. Untuk diagnosa, `infra logs` mencetak maksimum 32 KiB terakhir per file.

## Backup lengkap dan latihan restore

Backup ini berbeda dari ekspor ZIP Markdown di UI: lampiran, pengaturan editor asal, history/trash dan state turut disalin. Lock penulisan sementara tidak disalin. Symlink dan file khusus ditolak, bukan diikuti. Maksimum 100.000 file / 20 GiB total; data disalin/di-hash melalui stream sehingga file media tidak dimuat seluruhnya ke RAM. Direktori kosong selain root data tidak dijamin dipertahankan.

**Hentikan semua penulis terlebih dahulu:** server, proses MCP stdio, editor eksternal, serta sinkronisasi. Command memeriksa managed-service lock, port aplikasi, dan state write locks; ia tidak dapat mendeteksi semua editor/proses di luar kendalinya. Jangan menjalankan server/penulis lain sampai backup selesai.

```sh
npm run infra:stop
npm run infra:backup
npm run infra:start
```

Output backup berisi path snapshot, jumlah file, dan byte. Backup memeriksa hash sumber sebelum/sesudah salinan dan memverifikasi snapshot sebelum memindahkan staging menjadi snapshot final. Perubahan yang terdeteksi membatalkan backup; ini bukan filesystem snapshot atomik terhadap editor lain. Startup, backup, restore, dan unlock memakai gate maintenance bersama. Jika proses mati paksa selama maintenance, lock maintenance dapat tertinggal; periksa owner/proses di `.local/run/maintenance.lock/owner.json` sebelum pemulihan manual. Jangan menghapus lock proses yang masih hidup. File snapshot dan manifest menjalani fsync sebelum selesai; directory fsync dilakukan bila filesystem mendukung. Nama reserved Windows, alternate-stream colon, dan collision kapitalisasi/normalisasi ditolak agar restore tidak mengubah arti path lintas OS.

Snapshot belum dienkripsi dan dapat berisi konfigurasi/credential plugin editor eksternal. Simpan salinan privat di media berbeda dari komputer/VPS; backup pada disk yang sama tidak melindungi dari kehilangan disk. Tidak ada upload, jadwal, atau penghapusan retention otomatis.

Verifikasi dapat dilakukan saat server hidup karena hanya membaca snapshot:

```sh
npm run infra:verify -- --snapshot /path/snapshot
```

Latihan restore (server harus berhenti) hanya menerima direktori tujuan yang **belum ada**, terpisah dari data aktif dan backup:

```sh
npm run infra:stop
npm run infra:restore -- --snapshot /path/snapshot --target /path/new-restore-directory
npm run infra:start
```

Hasil restore memberi `vault` dan `state` tujuan; konfigurasi aktif tidak otomatis diubah. Restore tidak menimpa atau merge ke vault aktif. Jika gagal setelah mulai menyalin, direktori parsial dipertahankan untuk inspeksi. Periksa hasil sebelum mengganti path pada konfigurasi. Workflow journals mengandung identitas root lama; pemulihan workflow lintas root dapat ditolak dan harus ditinjau manual. SHA-256 mendeteksi korupsi/ketidakcocokan, bukan autentikasi terhadap penyerang yang dapat mengubah payload dan manifest sekaligus.

## Persiapan VPS

[mastermind.service.example](../infra/mastermind.service.example) dan [vps.env.example](../infra/vps.env.example) disiapkan untuk Linux. Template belum dipasang/diaktifkan dan belum diuji pada VPS. Rencana layout: aplikasi `/opt/mastermind`, konfigurasi `/etc/mastermind/local.env`, data persisten `/var/lib/mastermind/`. Tinjau path executable Node, buat user service, install dependency, dan atur ownership sebelum memasang unit. `Restart=on-failure` mengikuti [systemd](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html); hard crash yang menyisakan lock tetap memerlukan inspeksi/unlock, sehingga start-rate limit menghindari restart tanpa batas.

Server tetap privat melalui SSH tunnel. Contoh setelah VPS tersedia dan port lokal 6969 bebas:

```sh
ssh -N -L 6969:127.0.0.1:6969 user@vps
```

Buka `http://127.0.0.1:6969` atau gunakan MCP HTTP `http://127.0.0.1:6969/mcp`. Gunakan port lokal yang sama dengan port server karena validasi Host/Origin. Tidak membuka port 6969 ke internet atau menyediakan reverse proxy publik. Hosting publik/multiuser memerlukan autentikasi/otorisasi dan desain deployment tambahan.

## Verifikasi

`node --test tests/infra.test.mjs` menguji proses anak nyata, health/authenticated shutdown, duplicate start, konflik port tanpa menghentikan proses asing, snapshot lengkap/eksternal, korupsi/traversal/symlink, read-only konfigurasi dan restore tanpa overwrite. Uji ini memakai data sementara. Batas pengujian dijelaskan di [VALIDATION.md](VALIDATION.md); status platform tersedia melalui workflow CI.
