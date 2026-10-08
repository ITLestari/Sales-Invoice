(function () {
    // Tipe timbangan dipilih per PC (localStorage "tipeTimbangan"), default AND.
    const PROFILES = {
        AND: {
            label: "A&D",
            command: "S\n",
            parse: parseAngka,
            petunjuk: "Periksa kabel dan setelan timbangan.",
        },
        METTLER: {
            // MT-SICS (mis. JE5002GE): perintah wajib diakhiri CR LF
            label: "Mettler Toledo",
            command: "S\r\n",
            parse: parseMtSics,
            petunjuk:
                "Pastikan menu INT.FACE > RS232 = HOST, COM.SET = MT-SICS, BAUD = 9600, BIT.PAR. = 8/NO.",
        },
        O9: {
            label: "Lainnya (O9)",
            command: "O9\n",
            parse: parseAngka,
            petunjuk: "Periksa kabel dan setelan timbangan.",
        },
    };
    const TIMEOUT_MS = 10000;

    // Banyak tab: satu tab pemegang Web Lock membuka port, tab lain menitip
    // permintaan lewat BroadcastChannel. Bila tab itu ditutup, tab berikutnya mengambil alih.
    const tabId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const permintaan = new Map();
    let channel = null;
    let pemimpin = false;
    let pemimpinId = null;
    let terhubung = false;
    let menyambung = null;
    let nomor = 0;

    let port = null;
    let buffer = "";
    let pending = null;

    function getTipe() {
        const tipe = localStorage.getItem("tipeTimbangan");
        return PROFILES[tipe] ? tipe : "AND";
    }

    function mulai() {
        if (!("locks" in navigator) || typeof BroadcastChannel !== "function") {
            jadiPemimpin();
            return;
        }
        channel = new BroadcastChannel("timbangan");
        channel.onmessage = (e) => terimaPesan(e.data);
        kirimPesan({ type: "tanya-status" });
        navigator.locks
            .request("timbangan-port", () => {
                jadiPemimpin();
                return new Promise(() => {}); // dipegang sampai tab ditutup
            })
            .catch((e) => console.warn("Web Lock timbangan gagal:", e));
        window.addEventListener("pagehide", () => {
            if (pemimpin) kirimPesan({ type: "pergi" });
        });
    }

    function jadiPemimpin() {
        pemimpin = true;
        pemimpinId = tabId;
        console.info("Timbangan: tab ini menjadi pemegang port");
        kirimPesan({ type: "pemimpin" });
        sambung().catch((e) => console.log("Auto connect gagal:", e.message));

        // Permintaan tab ini yang belum dijawab pemegang lama dilayani sendiri.
        permintaan.forEach((req, id) => {
            permintaan.delete(id);
            clearTimeout(req.timer);
            jalankan(req.aksi, req.tipe).then(req.resolve, req.reject);
        });
    }

    function kirimPesan(msg) {
        if (channel) channel.postMessage({ ...msg, dari: tabId });
    }

    function terimaPesan(msg) {
        switch (msg.type) {
            case "tanya-status":
                if (pemimpin) kirimPesan({ type: "status", terhubung });
                break;
            case "pemimpin":
                pemimpinId = msg.dari;
                permintaan.forEach((req, id) =>
                    kirimPesan({ type: "minta", id, aksi: req.aksi, tipe: req.tipe })
                );
                break;
            case "status":
                pemimpinId = msg.dari;
                terhubung = msg.terhubung;
                setTombol();
                break;
            case "pergi":
                if (msg.dari === pemimpinId) {
                    terhubung = false;
                    setTombol();
                }
                break;
            case "minta":
                if (pemimpin) layani(msg);
                break;
            case "hasil":
                if (msg.untuk === tabId) terimaHasil(msg);
                break;
        }
    }

    async function layani(msg) {
        let hasil;
        try {
            hasil = { ok: true, nilai: await jalankan(msg.aksi, msg.tipe) };
        } catch (e) {
            hasil = { ok: false, pesan: e.message };
        }
        kirimPesan({ type: "hasil", id: msg.id, untuk: msg.dari, ...hasil });
    }

    function jalankan(aksi, tipe) {
        return aksi === "sambung" ? sambung() : timbang(tipe);
    }

    function mintaKePemimpin(aksi) {
        const id = tabId + "-" + ++nomor;
        const tipe = getTipe();
        return new Promise((resolve, reject) => {
            const req = { aksi, tipe, resolve, reject };
            req.timer = setTimeout(() => {
                permintaan.delete(id);
                reject(new Error("Tab pemegang timbangan tidak menjawab. Coba lagi."));
            }, TIMEOUT_MS + 5000);
            permintaan.set(id, req);
            console.debug("Timbangan: minta ke tab pemegang port:", aksi);
            kirimPesan({ type: "minta", id, aksi, tipe });
        });
    }

    function terimaHasil(msg) {
        const req = permintaan.get(msg.id);
        if (!req) return;
        permintaan.delete(msg.id);
        clearTimeout(req.timer);
        if (msg.ok) req.resolve(msg.nilai);
        else req.reject(new Error(msg.pesan));
    }

    function umumkanStatus() {
        terhubung = !!port;
        setTombol();
        kirimPesan({ type: "status", terhubung });
    }

    async function connectSerial(auto = false) {
        if (auto) {
            if (pemimpin) sambung().catch((e) => console.log("Auto connect gagal:", e.message));
            return;
        }
        if (terhubung) return;
        if (!("serial" in navigator)) {
            alert("Browser ini tidak mendukung koneksi timbangan (Web Serial). Gunakan Chrome atau Edge.");
            return;
        }

        try {
            const dipilih = await navigator.serial.requestPort();
            localStorage.setItem("savedPort", JSON.stringify(dipilih.getInfo()));
            if (pemimpin) await sambung(dipilih);
            else await mintaKePemimpin("sambung");
        } catch (e) {
            if (e.name !== "NotFoundError") {
                alert(
                    "Timbangan gagal terhubung. Pastikan port tidak dipakai aplikasi atau browser lain.\nPesan: " +
                        (e.message || e)
                );
            }
        }
    }

    // Fungsi port di bawah ini hanya berjalan di tab pemegang port.
    async function sambung(dipilih) {
        if (menyambung) await menyambung.catch(() => {});
        if (port) return;
        if (!menyambung) {
            menyambung = bukaPort(dipilih).finally(() => {
                menyambung = null;
                umumkanStatus();
            });
        }
        return menyambung;
    }

    async function bukaPort(dipilih) {
        if (!("serial" in navigator)) {
            throw new Error("Browser ini tidak mendukung koneksi timbangan (Web Serial). Gunakan Chrome atau Edge.");
        }
        const p = dipilih || (await cariPortTersimpan());

        // Port bisa masih ditutup oleh tab pemegang sebelumnya, jadi dicoba ulang.
        for (let coba = 1; ; coba++) {
            try {
                await p.open({ baudRate: 9600 });
                break;
            } catch (e) {
                if (coba === 8) throw e;
                await new Promise((r) => setTimeout(r, 400));
            }
        }
        port = p;
        listenToPort(p);
    }

    async function cariPortTersimpan() {
        const saved = JSON.parse(localStorage.getItem("savedPort"));
        if (!saved) throw new Error("Belum ada timbangan yang dipilih. Klik tombol Hubungkan.");

        const ports = await navigator.serial.getPorts();
        const p = ports.find((x) => {
            const info = x.getInfo();
            return info.usbVendorId === saved.usbVendorId && info.usbProductId === saved.usbProductId;
        });
        if (!p) throw new Error("Port timbangan tidak ditemukan. Periksa kabel USB.");
        return p;
    }

    async function listenToPort(p) {
        const textDecoder = new TextDecoderStream();
        const pipe = p.readable.pipeTo(textDecoder.writable).catch(() => {});
        const reader = textDecoder.readable.getReader();

        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                terimaData(value);
            }
        } catch (e) {
            console.warn("Koneksi timbangan terputus:", e);
        } finally {
            reader.releaseLock();
            await pipe;
            if (port === p) {
                port = null;
                buffer = "";
                selesai(new Error("Koneksi timbangan terputus. Klik tombol Hubungkan."));
                umumkanStatus();
                p.close().catch(() => {});
            }
        }
    }

    // Data serial datang terpotong-potong, jadi dikumpulkan dulu per baris.
    function terimaData(text) {
        buffer += text;
        const lines = buffer.split(/\r\n|\r|\n/);
        buffer = lines.pop();
        if (buffer.length > 256) {
            console.debug("Timbangan <- (tanpa akhir baris)", JSON.stringify(buffer));
            buffer = "";
        }
        lines.forEach(prosesBaris);
    }

    // Log komunikasi tampil di Console level "Verbose" untuk diagnosa.
    function prosesBaris(raw) {
        const line = raw.replace(/[\x00-\x1F\x7F]/g, " ").trim();
        if (!line) return;
        console.debug("Timbangan <-", JSON.stringify(raw));
        if (!pending) return;

        try {
            const berat = pending.parse(line);
            if (berat !== null) selesai(null, berat);
        } catch (e) {
            selesai(e);
        }
    }

    // A&D dan format lain: ambil angka pertama, contoh "ST,+00012.34  g"
    function parseAngka(line) {
        if (/^OL\b/.test(line)) throw new Error("Beban melebihi kapasitas timbangan.");
        if (/^EC\b/.test(line)) throw new Error("Timbangan mengirim kode error: " + line);

        const m = line.match(/([-+]?)\s*(\d+(?:\.\d+)?)\s*([a-zA-Z]*)/);
        if (!m) return null;
        return cekBerat(Number(m[1] + m[2]), m[3]);
    }

    // MT-SICS, contoh balasan perintah S: "S S     123.45 g"
    function parseMtSics(line) {
        const m = line.match(/^S\s+S\s+(-?)\s*(\d+(?:\.\d+)?)\s+(\S+)/);
        if (m) return cekBerat(Number(m[1] + m[2]), m[3]);

        if (/^S\s+I\b/.test(line)) {
            throw new Error("Timbangan belum stabil atau sedang sibuk. Coba lagi.");
        }
        if (/^S\s+\+/.test(line)) throw new Error("Beban melebihi kapasitas timbangan.");
        if (/^S\s+-/.test(line)) {
            throw new Error("Beban di bawah batas. Pastikan piringan terpasang lalu tekan Zero.");
        }
        if (/^E[STL]\b/.test(line)) {
            throw new Error("Perintah ditolak timbangan (" + line + "). " + PROFILES.METTLER.petunjuk);
        }
        return null;
    }

    function cekBerat(berat, satuan) {
        if (satuan && satuan.toLowerCase() !== "g") {
            throw new Error("Satuan timbangan '" + satuan + "', harus gram (g). Ubah satuan di timbangan.");
        }
        if (berat < 0) {
            throw new Error("Berat negatif (" + berat + " g). Kosongkan piringan lalu tekan Zero.");
        }
        return Number(berat.toFixed(2));
    }

    async function timbang(tipe) {
        if (menyambung) await menyambung.catch(() => {});
        if (pending) return pending.promise;
        if (!port) throw new Error("Timbangan belum terhubung. Klik tombol Hubungkan.");

        const profile = PROFILES[tipe] || PROFILES[getTipe()];
        const req = { parse: profile.parse };
        req.promise = new Promise((resolve, reject) => {
            req.resolve = resolve;
            req.reject = reject;
        });
        req.timer = setTimeout(
            () => selesai(new Error("Timbangan tidak merespons. " + profile.petunjuk)),
            TIMEOUT_MS
        );
        pending = req;

        kirim(profile.command).catch((e) => selesai(e));
        return req.promise;
    }

    function kliktimbang() {
        return pemimpin ? timbang(getTipe()) : mintaKePemimpin("timbang");
    }

    function selesai(err, berat) {
        const req = pending;
        if (!req) return;
        pending = null;
        clearTimeout(req.timer);
        if (err) req.reject(err);
        else req.resolve(berat);
    }

    async function kirim(text) {
        console.debug("Timbangan ->", JSON.stringify(text));
        const writer = port.writable.getWriter();
        try {
            await writer.write(new TextEncoder().encode(text));
        } finally {
            writer.releaseLock();
        }
    }

    function setTombol() {
        const conscale = document.getElementById("conscale");
        if (!conscale) return;
        conscale.classList.toggle("disabled", terhubung);
        conscale.innerHTML =
            "<i class='fa-solid fa-scale-balanced'></i> : " + (terhubung ? "Terhubung" : "Hubungkan");
    }

    function initPilihanTipe() {
        const select = document.getElementById("tipeTimbangan");
        if (!select) return;
        Object.keys(PROFILES).forEach((tipe) => select.add(new Option(PROFILES[tipe].label, tipe)));
        select.value = getTipe();
        select.addEventListener("change", () => localStorage.setItem("tipeTimbangan", select.value));
        // Pilihan yang diubah di tab lain ikut tampil di tab ini.
        window.addEventListener("storage", (e) => {
            if (e.key === "tipeTimbangan") select.value = getTipe();
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initPilihanTipe);
    } else {
        initPilihanTipe();
    }
    mulai();

    // Expose ke global window
    window.connectSerial = connectSerial;
    window.kliktimbang = kliktimbang;
    // Diagnosa di Console: ketik statusTimbangan()
    window.statusTimbangan = () => ({ tab: tabId, pemegangPort: pemimpin, pemimpin: pemimpinId, terhubung });
})();
