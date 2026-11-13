#!/usr/bin/env python3
"""DPOS350P emulator: web front end served from this process (local server; the emulator core
runs here, the browser is the interface). Structured so the core can later move to WebAssembly:
the page only talks to the JSON/binary API below.

  python3 -m tools.sim.server [--port 8350] [--image app.bin|firmware.iso] [--sd card.img]

Open http://localhost:8350 . The firmware is the user's own file (uploaded from the page or
given with --image); nothing from FNIRSI is stored in the repository.
"""
import argparse
import hashlib
import io
import json
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import numpy as np
from PIL import Image

from tools.sim import fat as fatmod
from tools.sim.sim import ROOT, Sim, load_snapshot, save_snapshot

WEB = Path(__file__).resolve().parent / "web"
STATE = ROOT / "build/sim"
ISO_SIZE = 0x2C0000


def frame_png(sim):
    attr, size, pitch, addr = (sim.r32(0x01104000 + o) for o in (0x00, 0x04, 0x0C, 0x10))
    w, h = (size & 0x1FFF) + 1, ((size >> 16) & 0x1FFF) + 1
    if not (attr & 1) or not (0x40000000 <= addr < 0x44000000) or w > 2048 or h > 2048:
        w, h, pitch, raw = 1022, 600, 2044, bytes(1022 * 600 * 2)
    else:
        raw = bytes(sim.uc.mem_read(addr, pitch * h))
    a = np.frombuffer(raw, dtype="<u2").reshape(h, pitch // 2)[:, :w]
    rgb = np.empty((h, w, 3), np.uint8)
    rgb[..., 0] = (a >> 11) << 3
    rgb[..., 1] = ((a >> 5) & 0x3F) << 2
    rgb[..., 2] = (a & 0x1F) << 3
    buf = io.BytesIO()
    Image.fromarray(rgb).save(buf, "PNG", compress_level=1)
    return buf.getvalue()


def app_from_upload(data, name):
    """ISO (container) -> application image; a raw app.bin is accepted as is."""
    if len(data) == ISO_SIZE or name.lower().endswith(".iso"):
        from tools.dposiso import split
        _, app = split(data)
        return bytes(app), "iso"
    if len(data) > 0x90000 and data[:4] == b"\x18\xf0\x9f\xe5":      # ldr pc,[pc,#0x18] vector table
        return bytes(data), "app.bin"
    raise ValueError("not a DPOS350P firmware (expected the .iso update file or app.bin)")


class Emulator:
    """Owns the Sim and runs it on its own thread; the HTTP threads take `lock` to touch it."""

    def __init__(self, image, sd_path):
        self.lock = threading.RLock()
        self.sd_path = sd_path
        self.sd = bytearray(sd_path.read_bytes()) if sd_path.exists() else bytearray(64 << 20)
        self.image, self.image_info = None, {}
        self.running = False
        self.paused = False
        self.png = frame_png_blank()
        self.status = {}
        self.factory_done = True
        self.t_last, self.i_last = time.time(), 0
        self.mips = 0.0
        self.error = None
        self.sim = None
        if image is not None:
            self.load_image(image, "startup")

    # ---------------------------------------------------------------- lifecycle
    def load_image(self, app, source):
        with self.lock:
            self.image = app
            self.image_info = {"source": source, "size": len(app), "sha256": hashlib.sha256(app).hexdigest()[:16]}
            self.reset()

    def reset(self):
        with self.lock:
            if self.image is None:
                return
            keep = self.sim.dev.frontend.ch if self.sim else None
            batt = (self.sim.dev.battery_mv, self.sim.dev.charging) if self.sim else (4100, False)
            self.sim = Sim(self.image, False, self.sd, factory_done=self.factory_done)
            if keep:
                self.sim.dev.frontend.ch = keep
            self.sim.dev.battery_mv, self.sim.dev.charging = batt
            self.error = None
            self.running = True

    def save_sd(self):
        with self.lock:
            self.sd_path.parent.mkdir(parents=True, exist_ok=True)
            self.sd_path.write_bytes(self.sd)

    def loop(self):
        while True:
            if not self.running or self.paused or self.sim is None:
                time.sleep(0.05)
                continue
            with self.lock:
                res = self.sim.boot(10_000_000, on_slice=self._slice)
                if res["error"]:
                    self.error = res["error"]
                    self.running = False

    def _slice(self, sim):
        now = time.time()
        if now - self.t_last >= 0.15:
            self.png = frame_png(sim)
            self.mips = (sim.insns - self.i_last) / (now - self.t_last) / 1e6
            self.t_last, self.i_last = now, sim.insns
        return False

    # ---------------------------------------------------------------- views
    def snapshot_status(self):
        s = self.sim
        if s is None:
            return {"loaded": False, "image": self.image_info}
        return {"loaded": True, "running": self.running and not self.paused, "paused": self.paused,
                "error": self.error, "insns": s.insns, "mips": round(self.mips, 1), "irqs": getattr(s, "irqs", 0),
                "csi_frames": s.dev.csi.frames, "pc": s.sym(s.pc()), "image": self.image_info,
                "battery_mv": s.dev.battery_mv, "charging": s.dev.charging, "factory_done": self.factory_done,
                "channels": s.dev.frontend.ch, "audio_buffer": len(s.dev.frontend.audio),
                "touch": getattr(s.dev.touch, "last", None), "touch_reads": s.dev.touch.reads}

    def dev_info(self):
        s = self.sim
        if s is None:
            return {}
        top = sorted(s.unmodelled.items(), key=lambda kv: -kv[1])[:40]
        return {"unmodelled": [{"op": op, "addr": f"0x{a:08X}", "size": sz * 8, "count": c,
                                "first": s.sym(s.first_seen.get((op, a), 0))} for (op, a, sz), c in top],
                "hot": [{"where": k, "samples": v} for k, v in s.hot.most_common(12)],
                "gic": {str(k): v for k, v in s.dev.gic.counts.items()},
                "fpga_reads": {f"0x{k:02X}": v for k, v in sorted(s.dev.fpga.reads.items())},
                "fpga_writes": {f"0x{k:02X}": list(v[-4:]) for k, v in sorted(s.dev.fpga.writes.items()) if k is not None},
                "flash_reads": len(s.dev.flash.reads), "sd_commands": len(s.dev.mmc0.log),
                "uart": s.dev.uart_text()[-4000:]}


def frame_png_blank():
    buf = io.BytesIO()
    Image.new("RGB", (1022, 600), (0, 0, 0)).save(buf, "PNG")
    return buf.getvalue()


def make_handler(emu):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, body, ctype="application/json", code=200, extra=None):
            if isinstance(body, (dict, list)):
                body = json.dumps(body).encode()
            elif isinstance(body, str):
                body = body.encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def _body(self):
            n = int(self.headers.get("Content-Length", 0))
            return self.rfile.read(n) if n else b""

        def _json(self):
            b = self._body()
            return json.loads(b) if b else {}

        def _fat(self):
            return fatmod.Fat(emu.sd)

        def do_GET(self):
            u = urlparse(self.path)
            q = {k: v[0] for k, v in parse_qs(u.query).items()}
            try:
                if u.path == "/frame.png":
                    return self._send(emu.png, "image/png")
                if u.path == "/api/status":
                    return self._send(emu.snapshot_status())
                if u.path == "/api/dev":
                    with emu.lock:
                        return self._send(emu.dev_info())
                if u.path == "/api/peek":                       # dev: read memory (hex dump)
                    a, n = int(q["addr"], 0), min(int(q.get("n", "64"), 0), 4096)
                    with emu.lock:
                        data = bytes(emu.sim.uc.mem_read(a, n))
                    return self._send({"addr": f"0x{a:08X}", "hex": data.hex()})
                if u.path == "/api/fs":
                    with emu.lock:
                        return self._send({"path": q.get("path", "/"), "entries": self._fat().listdir(q.get("path", "/"))})
                if u.path == "/api/fs/file":
                    with emu.lock:
                        data = self._fat().read(q["path"])
                    name = q["path"].rsplit("/", 1)[-1]
                    return self._send(data, "application/octet-stream",
                                      extra={"Content-Disposition": f'attachment; filename="{name}"'})
                f = (WEB / (u.path.lstrip("/") or "index.html")).resolve()
                if WEB in f.parents or f == WEB / "index.html":
                    if f.is_file():
                        ctype = {".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
                                 ".svg": "image/svg+xml"}.get(f.suffix, "application/octet-stream")
                        return self._send(f.read_bytes(), ctype)
                return self._send({"error": "not found"}, code=404)
            except fatmod.FatError as e:
                return self._send({"error": str(e)}, code=400)
            except Exception as e:
                traceback.print_exc()
                return self._send({"error": str(e)}, code=500)

        def do_POST(self):
            u = urlparse(self.path)
            q = {k: v[0] for k, v in parse_qs(u.query).items()}
            try:
                if u.path == "/api/touch":
                    ev = self._json()
                    with emu.lock:
                        if emu.sim:
                            emu.sim.dev.touch.event(ev.get("kind"), int(ev.get("x", 0)), int(ev.get("y", 0)))
                            emu.sim.dev.touch.last = f"{ev.get('kind')} ({ev.get('x')}, {ev.get('y')})"
                    return self._send({"ok": True})
                if u.path == "/api/firmware":
                    data = self._body()
                    app, kind = app_from_upload(data, q.get("name", ""))
                    STATE.mkdir(parents=True, exist_ok=True)
                    (STATE / "uploaded_app.bin").write_bytes(app)
                    emu.load_image(app, f"{q.get('name', 'upload')} ({kind})")
                    return self._send(emu.snapshot_status())
                if u.path == "/api/control":
                    body = self._json()
                    a = body.get("action")
                    with emu.lock:
                        if a == "pause": emu.paused = True
                        elif a == "resume": emu.paused = False
                        elif a == "reset": emu.reset(); emu.paused = False
                        elif a == "save_sd": emu.save_sd()
                        elif a == "snapshot_save": save_snapshot(emu.sim, STATE / "web.snap")
                        elif a == "snapshot_load":
                            load_snapshot(emu.sim, STATE / "web.snap")
                        elif a == "factory_done":
                            emu.factory_done = bool(body.get("value", True))
                    return self._send(emu.snapshot_status())
                if u.path == "/api/channel":
                    ev = self._json()
                    with emu.lock:
                        if emu.sim:
                            c = int(ev.pop("ch"))
                            emu.sim.dev.frontend.ch[c].update({k: v for k, v in ev.items() if k in emu.sim.dev.frontend.ch[c]})
                    return self._send(emu.snapshot_status())
                if u.path == "/api/poke":                       # dev: write memory {addr, hex}
                    ev = self._json()
                    with emu.lock:
                        emu.sim.uc.mem_write(int(ev["addr"], 0), bytes.fromhex(ev["hex"]))
                    return self._send({"ok": True})
                if u.path == "/api/battery":
                    ev = self._json()
                    with emu.lock:
                        if emu.sim:
                            if "mv" in ev: emu.sim.dev.battery_mv = int(ev["mv"])
                            if "charging" in ev: emu.sim.dev.charging = bool(ev["charging"])
                    return self._send(emu.snapshot_status())
                if u.path == "/api/audio":
                    pcm = np.frombuffer(self._body(), dtype="<f4")
                    with emu.lock:
                        if emu.sim:
                            fe = emu.sim.dev.frontend
                            fe.audio.extend(pcm.tolist())
                            del fe.audio[:-48000]
                            if "volts" in q:
                                fe.audio_volts = float(q["volts"])
                    return self._send({"ok": True, "n": len(pcm)})
                if u.path == "/api/fs/file":
                    data = self._body()
                    with emu.lock:
                        self._fat().write(q["path"], data)
                        emu.save_sd()
                    return self._send({"ok": True})
                if u.path == "/api/fs/format":
                    with emu.lock:
                        info = fatmod.mkfs_fat32(emu.sd)
                        emu.save_sd()
                    return self._send({"ok": True, **info})
                if u.path == "/api/fs/mkdir":
                    with emu.lock:
                        self._fat().mkdir(q["path"])
                        emu.save_sd()
                    return self._send({"ok": True})
                if u.path == "/api/fs/delete":
                    with emu.lock:
                        self._fat().delete(q["path"])
                        emu.save_sd()
                    return self._send({"ok": True})
                return self._send({"error": "not found"}, code=404)
            except (fatmod.FatError, ValueError, KeyError) as e:
                return self._send({"error": str(e)}, code=400)
            except Exception as e:
                traceback.print_exc()
                return self._send({"error": str(e)}, code=500)
    return H


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8350)
    ap.add_argument("--image", help="app.bin or the firmware .iso (default: build/extract/app.bin if present)")
    ap.add_argument("--sd", default=str(STATE / "sdcard.img"), help="SD card image (created blank if missing)")
    a = ap.parse_args()
    img = None
    p = Path(a.image) if a.image else (ROOT / "build/extract/app.bin")
    if p.exists():
        img, _ = app_from_upload(p.read_bytes(), p.name)
    emu = Emulator(img, Path(a.sd))
    threading.Thread(target=emu.loop, daemon=True).start()
    srv = ThreadingHTTPServer(("0.0.0.0", a.port), make_handler(emu))
    print(f"DPOS350P emulator: http://localhost:{a.port}  (firmware: {emu.image_info or 'none, upload it from the page'})", flush=True)
    try:
        srv.serve_forever()
    finally:
        emu.save_sd()


if __name__ == "__main__":
    main()
