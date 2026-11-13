#!/usr/bin/env python3
"""Live view of the simulator in a web page: the emulated display updates continuously and
mouse clicks on it are passed to the emulated touch panel.

  python3 -m tools.sim.live [--image build/extract/app.bin] [--port 8350]

then open http://localhost:8350 . No GUI toolkit is needed (WSL has none installed).
"""
import argparse
import io
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
from PIL import Image

from tools.sim.sim import Sim, ROOT

PAGE = """<!doctype html><html><head><meta charset="utf-8"><title>DPOS350P simulator</title>
<style>
 body{background:#1b1d21;color:#ddd;font:14px system-ui,sans-serif;margin:16px}
 #wrap{display:inline-block;border:8px solid #333;border-radius:10px;background:#000;line-height:0}
 img{width:1022px;max-width:calc(100vw - 48px);height:auto;cursor:crosshair;image-rendering:pixelated}
 #st{margin-top:10px;font-family:ui-monospace,monospace;white-space:pre;color:#9ab}
 h1{font-size:16px;font-weight:600;margin:0 0 10px}
</style></head><body>
<h1>FNIRSI DPOS350P &mdash; firmware 2025-06-19 running in the simulator</h1>
<div id="wrap"><img id="scr" src="/frame.png" draggable="false"></div>
<div id="st">starting...</div>
<script>
const img=document.getElementById('scr'), st=document.getElementById('st');
function next(){ img.src='/frame.png?'+Date.now(); }
img.onload=()=>setTimeout(next,150); img.onerror=()=>setTimeout(next,1000);
function pos(e){const r=img.getBoundingClientRect();
  return [Math.round((e.clientX-r.left)*1022/r.width), Math.round((e.clientY-r.top)*600/r.height)];}
let down=false;
function send(kind,e){const [x,y]=pos(e);
  fetch('/touch',{method:'POST',body:JSON.stringify({kind,x,y})});}
img.addEventListener('mousedown',e=>{down=true;send('down',e);e.preventDefault();});
img.addEventListener('mousemove',e=>{if(down)send('move',e);});
window.addEventListener('mouseup',e=>{if(down){down=false;send('up',e);}});
setInterval(()=>fetch('/status').then(r=>r.json()).then(s=>{
  st.textContent=`${(s.insns/1e9).toFixed(2)} G instructions   ${s.mips.toFixed(1)} M/s   `+
  `IRQs ${s.irqs}   CSI frames ${s.frames}   pc ${s.pc}\\nlast touch: ${s.touch}`;}),500);
</script></body></html>"""


def frame_png(sim):
    """RGB565 UI layer of DE2 mixer 0 -> PNG bytes (numpy, fast)."""
    attr, size, pitch, addr = (sim.r32(0x01104000 + o) for o in (0x00, 0x04, 0x0C, 0x10))
    w, h = (size & 0x1FFF) + 1, ((size >> 16) & 0x1FFF) + 1
    if not (attr & 1) or not (0x40000000 <= addr < 0x44000000) or w > 2048 or h > 2048:
        w, h, raw = 1022, 600, bytes(1022 * 600 * 2)
        pitch = 2044
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


class Live:
    def __init__(self, sim):
        self.sim = sim
        self.png = frame_png(sim)
        self.want_frame = True
        self.lock = threading.Lock()
        self.status = {"insns": 0, "mips": 0.0, "irqs": 0, "frames": 0, "pc": "-", "touch": "none"}
        self.t_last, self.i_last = time.time(), 0

    def on_slice(self, sim):
        now = time.time()
        if now - self.t_last >= 0.2:
            png = frame_png(sim)
            mips = (sim.insns - self.i_last) / (now - self.t_last) / 1e6
            with self.lock:
                self.png = png
                self.status.update(insns=sim.insns, mips=mips, irqs=getattr(sim, "irqs", 0),
                                   frames=sim.dev.csi.frames, pc=sim.sym(sim.pc()))
            self.t_last, self.i_last = now, sim.insns
        return False

    def touch(self, kind, x, y):
        tp = getattr(self.sim.dev, "touch", None)
        if tp is not None:
            tp.event(kind, x, y)
        with self.lock:
            self.status["touch"] = f"{kind} ({x}, {y})" + ("" if tp is not None else "  [touch panel not modelled yet]")


def serve(live, port):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, body, ctype):
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path.startswith("/frame.png"):
                with live.lock:
                    body = live.png
                self._send(body, "image/png")
            elif self.path.startswith("/status"):
                with live.lock:
                    body = json.dumps(live.status).encode()
                self._send(body, "application/json")
            else:
                self._send(PAGE.encode(), "text/html; charset=utf-8")

        def do_POST(self):
            n = int(self.headers.get("Content-Length", 0))
            ev = json.loads(self.rfile.read(n) or b"{}")
            if self.path == "/touch":
                live.touch(ev.get("kind"), int(ev.get("x", 0)), int(ev.get("y", 0)))
            self._send(b"ok", "text/plain")

    srv = ThreadingHTTPServer(("0.0.0.0", port), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", default=str(ROOT / "build/extract/app.bin"))
    ap.add_argument("--port", type=int, default=8350)
    ap.add_argument("--sd", help="SD card image (raw); default: blank 64 MiB")
    a = ap.parse_args()
    sd = bytearray(Path(a.sd).read_bytes()) if a.sd else None
    sim = Sim(Path(a.image).read_bytes(), False, sd)
    live = Live(sim)
    serve(live, a.port)
    print(f"simulator running: open http://localhost:{a.port}", flush=True)
    while True:
        res = sim.boot(50_000_000, on_slice=live.on_slice)
        if res["error"]:
            print("stopped:", res["error"], flush=True)
            with live.lock:
                live.status["pc"] = "STOPPED: " + res["error"]
            while True:
                time.sleep(3600)


if __name__ == "__main__":
    main()
