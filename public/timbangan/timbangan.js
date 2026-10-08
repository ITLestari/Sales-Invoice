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

    // Koneksi dipilih per PC (localStorage "koneksiTimbangan") dan dibaca sekali saat halaman dimuat.
    // Mode bridge: WebApp Hardware Bridge memegang COM port, setiap tab terhubung lewat WebSocket.
    const KONEKSI = {
        serial: "Web Serial",
        bridge: "Bridge",
    };
    const BRIDGE_URL = "ws://127.0.0.1:12212/serial/TIMBANGAN";
    const PETUNJUK_BRIDGE =
        "Pastikan WebApp Hardware Bridge berjalan dengan pemetaan serial TIMBANGAN ke COM port timbangan.";
    const koneksi = KONEKSI[localStorage.getItem("koneksiTimbangan")]
        ? localStorage.getItem("koneksiTimbangan")
        : "serial";

    let port = null;
    let ws = null;
    let antreBridge = false;
    let sambungUlang = null;
    let diterima = 0;
    let buffer = "";
    let pending = null;

    function getTipe() {
        const tipe = localStorage.getItem("tipeTimbangan");
        return PROFILES[tipe] ? tipe : "AND";
    }

    // Bridge 0.14 bisa gagal mendaftarkan tab yang tersambung bersamaan (tab tidak pernah menerima data),
    // jadi tab-tab menyambung bergiliran lewat Web Lock.
    function hubungkanBridge() {
        if (ws || antreBridge) return;
        clearTimeout(sambungUlang);
        antreBridge = true;
        if ("locks" in navigator) {
            navigator.locks.request("timbangan-bridge", bukaBridge).catch(() => {});
        } else {
            bukaBridge();
        }
    }

    function bukaBridge() {
        antreBridge = false;
        return new Promise((lepas) => {
            const sock = new WebSocket(BRIDGE_URL);
            ws = sock;
            sock.onopen = () => {
                console.info("Timbangan: terhubung ke bridge");
                setTombol(true);
                setTimeout(lepas, 300); // beri waktu bridge selesai mendaftarkan tab ini
            };
            // Bridge meneruskan data serial per karakter ke semua tab yang terhubung.
            sock.onmessage = (e) => {
                diterima++;
                terimaData(e.data);
            };
            sock.onclose = () => {
                lepas();
                if (ws !== sock) return;
                ws = null;
                buffer = "";
                selesai(new Error("Koneksi ke bridge terputus. " + PETUNJUK_BRIDGE));
                setTombol(false);
                sambungUlang = setTimeout(hubungkanBridge, 3000);
            };
        });
    }

    // Tidak ada data sama sekali selama menunggu: tab ini mungkin tidak terdaftar di bridge.
    function segarkanBridge() {
        const lama = ws;
        ws = null;
        buffer = "";
        if (lama) lama.close();
        setTombol(false);
        hubungkanBridge();
    }

    async function connectSerial(auto = false) {
        if (koneksi === "bridge") {
            hubungkanBridge();
            return;
        }
        if (port) return;
        if (!("serial" in navigator)) {
            if (!auto) {
                alert("Browser ini tidak mendukung koneksi timbangan (Web Serial). Gunakan Chrome atau Edge.");
            }
            return;
        }

        try {
            if (auto) {
                const savedPortInfo = JSON.parse(localStorage.getItem("savedPort"));
                if (!savedPortInfo) return;

                const ports = await navigator.serial.getPorts();
                port =
                    ports.find((p) => {
                        const info = p.getInfo();
                        return (
                            info.usbVendorId === savedPortInfo.usbVendorId &&
                            info.usbProductId === savedPortInfo.usbProductId
                        );
                    }) || null;

                if (!port) {
                    console.log("Auto connect gagal: port tidak ditemukan.");
                    return;
                }
            } else {
                port = await navigator.serial.requestPort();
                localStorage.setItem("savedPort", JSON.stringify(port.getInfo()));
            }

            await port.open({ baudRate: 9600 });
            setTombol(true);
            listenToPort(port);
        } catch (e) {
            port = null;
            if (auto) {
                console.warn("Auto reconnect gagal:", e);
            } else if (e.name !== "NotFoundError") {
                alert(
                    "Harap tutup halaman lain yang pakai timbangan. Bila port dipegang WebApp Hardware Bridge, pilih koneksi Bridge.\nPesan: " +
                        e
                );
            }
        }
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
                setTombol(false);
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

    function siap() {
        return koneksi === "bridge" ? ws !== null && ws.readyState === WebSocket.OPEN : port !== null;
    }

    function kliktimbang() {
        if (pending) return pending.promise;
        if (!siap()) {
            const pesan =
                koneksi === "bridge"
                    ? "Bridge timbangan belum terhubung. " + PETUNJUK_BRIDGE
                    : "Timbangan belum terhubung. Klik tombol Hubungkan.";
            return Promise.reject(new Error(pesan));
        }

        const profile = PROFILES[getTipe()];
        const petunjuk = koneksi === "bridge" ? PETUNJUK_BRIDGE + " " + profile.petunjuk : profile.petunjuk;
        const req = { parse: profile.parse };
        req.promise = new Promise((resolve, reject) => {
            req.resolve = resolve;
            req.reject = reject;
        });
        req.diterimaAwal = diterima;
        req.timer = setTimeout(() => {
            if (koneksi === "bridge" && diterima === req.diterimaAwal) segarkanBridge();
            selesai(new Error("Timbangan tidak merespons. " + petunjuk));
        }, TIMEOUT_MS);
        pending = req;

        kirim(profile.command).catch((e) => selesai(e));
        return req.promise;
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
        if (koneksi === "bridge") {
            // Harus satu pesan utuh: bridge menimpa buffer tulisnya setiap pesan baru.
            ws.send(text);
            return;
        }
        const writer = port.writable.getWriter();
        try {
            await writer.write(new TextEncoder().encode(text));
        } finally {
            writer.releaseLock();
        }
    }

    function setTombol(terhubung) {
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
    }

    function initPilihanKoneksi() {
        const select = document.getElementById("koneksiTimbangan");
        if (!select) return;
        Object.keys(KONEKSI).forEach((k) => select.add(new Option(KONEKSI[k], k)));
        select.value = koneksi;
        select.addEventListener("change", () => {
            localStorage.setItem("koneksiTimbangan", select.value);
            alert(
                "Koneksi timbangan diubah ke " +
                    KONEKSI[select.value] +
                    ". Muat ulang semua halaman LMS yang terbuka agar berlaku."
            );
        });
    }

    function initPilihan() {
        initPilihanTipe();
        initPilihanKoneksi();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initPilihan);
    } else {
        initPilihan();
    }

    // Expose ke global window
    window.connectSerial = connectSerial;
    window.kliktimbang = kliktimbang;
})();
