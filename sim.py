#!/usr/bin/env python3
"""Whole-system simulator for the DPOS350P firmware (build 2025-06-19), prototype.

Boots an application image (the stock app.bin, the rebuilt one, or a TEST build with C
functions) from Reset_Handler on a Unicorn Cortex-A7. Peripherals are modelled in
tools/sim/devices.py; every access to an address without a model is logged, so the log
shows what to model next.

Usage (inside dpos-re):
  python3 -m tools.sim.sim [--image build/extract/app.bin] [--insns 50M] [--trace-mmio]
"""
import argparse
import collections
import csv
import struct
import sys
import time
from pathlib import Path

from unicorn import Uc, UcError, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_MEM_READ, UC_HOOK_MEM_WRITE, UC_HOOK_MEM_UNMAPPED
from unicorn import arm_const as R

from tools.sim import devices

ROOT = Path(__file__).resolve().parents[2]
DRAM, DRAM_SIZE = 0x40000000, 64 << 20        # V3s: 64 MiB DDR2 in package
SRAM, SRAM_SIZE = 0x00000000, 0x01000000      # SRAM A1 + low space: on the SoC unbacked reads do not fault
HIVEC = 0xFFFF0000
MMIO, MMIO_SIZE = 0x01000000, 16 << 20
RESET = 0x4008CB28


def load_symbols():
    syms = {}
    for fn in ("symbols/symbols_2025-06-19.csv", "symbols/manual.csv"):
        for r in csv.DictReader(open(ROOT / fn)):
            if "function" in r.get("type", "") or r.get("type") in ("function_arm", "function_thumb"):
                syms[int(r["address"], 16)] = r["name"]
    return sorted(syms.items())


class Sim:
    def __init__(self, image, trace_mmio=False, sd_image=None):
        self.sd_image = sd_image if sd_image is not None else bytearray(64 << 20)   # blank 64 MiB card
        uc = Uc(UC_ARCH_ARM, UC_MODE_ARM)
        try:
            from unicorn.arm_const import UC_CPU_ARM_CORTEX_A7
            uc.ctl_set_cpu_model(UC_CPU_ARM_CORTEX_A7)
        except Exception:
            pass
        uc.mem_map(DRAM, DRAM_SIZE)
        uc.mem_map(SRAM, SRAM_SIZE)
        uc.mem_map(HIVEC, 0x10000)
        uc.mem_map(MMIO, MMIO_SIZE)
        uc.mem_write(DRAM, image)
        self.uc = uc
        self.trace = trace_mmio
        self.unmodelled = collections.Counter()      # (op, addr, size) -> count
        self.first_seen = {}                         # (op, addr) -> pc of first access
        self.insns = 0
        self.dev = devices.Board(self)
        uc.hook_add(UC_HOOK_MEM_READ, self._mmio_read, None, MMIO, MMIO + MMIO_SIZE - 1)
        uc.hook_add(UC_HOOK_MEM_WRITE, self._mmio_write, None, MMIO, MMIO + MMIO_SIZE - 1)
        uc.hook_add(UC_HOOK_MEM_UNMAPPED, self._unmapped)
        self.syms = load_symbols()
        self._sym_addrs = [a for a, _ in self.syms]

    # ---------------------------------------------------------------- helpers
    def r32(self, a): return struct.unpack("<I", bytes(self.uc.mem_read(a, 4)))[0]
    def w32(self, a, v): self.uc.mem_write(a, struct.pack("<I", v & 0xFFFFFFFF))
    def pc(self): return self.uc.reg_read(R.UC_ARM_REG_PC)

    def sym(self, a):
        import bisect
        i = bisect.bisect_right(self._sym_addrs, a) - 1
        if i < 0:
            return hex(a)
        base, name = self.syms[i]
        return f"{name}+0x{a - base:x}" if a != base else name

    # ---------------------------------------------------------------- MMIO
    def _mmio_read(self, uc, access, addr, size, value, user):
        v = self.dev.read(addr, size)
        if v is None:
            self._note("R", addr, size)
        else:
            uc.mem_write(addr, (v & ((1 << (8 * size)) - 1)).to_bytes(size, "little"))
        if self.trace:
            print(f"  R{size * 8} {addr:#010x} @ {self.sym(self.pc())}")

    def _mmio_write(self, uc, access, addr, size, value, user):
        if not self.dev.write(addr, size, value & ((1 << (8 * size)) - 1)):
            self._note("W", addr, size)
        if self.trace:
            print(f"  W{size * 8} {addr:#010x}={value:#x} @ {self.sym(self.pc())}")

    def _note(self, op, addr, size):
        k = (op, addr, size)
        self.unmodelled[k] += 1
        if (op, addr) not in self.first_seen:
            self.first_seen[(op, addr)] = self.pc()

    def _unmapped(self, uc, access, addr, size, value, user):
        print(f"!! unmapped access {addr:#010x} (size {size}) at {self.sym(self.pc())}")
        return False

    # ---------------------------------------------------------------- run
    def boot(self, max_insns, chunk=1_000_000):
        uc = self.uc
        uc.reg_write(R.UC_ARM_REG_CPSR, 0x1D3)          # SVC, IRQ/FIQ masked, ARM
        pc = RESET
        hot = collections.Counter()
        t0 = time.time()
        err = None
        while self.insns < max_insns:
            try:
                uc.emu_start(pc, 0xFFFFFFFF, count=chunk)
            except UcError as e:
                err = f"{e} at {self.sym(self.pc())}"
                break
            self.insns += chunk
            pc = self.pc() | (1 if uc.reg_read(R.UC_ARM_REG_CPSR) & 0x20 else 0)
            hot[f"{self.sym(self.pc())}  <- {self.sym(uc.reg_read(R.UC_ARM_REG_LR))}"] += 1
            self.dev.tick(chunk)
        dt = time.time() - t0
        return {"insns": self.insns, "seconds": dt, "pc": self.sym(self.pc()), "error": err, "hot": hot}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", default=str(ROOT / "build/extract/app.bin"))
    ap.add_argument("--insns", default="800M")
    ap.add_argument("--screenshot", default=str(ROOT / "build/sim/screen.png"),
                    help="PNG of the emulated display at the end of the run")
    ap.add_argument("--trace-mmio", action="store_true")
    ap.add_argument("--sd", help="SD card image (raw); default: blank 64 MiB")
    a = ap.parse_args()
    n = int(float(a.insns.rstrip("MK")) * (1e6 if a.insns.endswith("M") else 1e3 if a.insns.endswith("K") else 1))
    sd = bytearray(Path(a.sd).read_bytes()) if a.sd else None
    sim = Sim(Path(a.image).read_bytes(), a.trace_mmio, sd)
    res = sim.boot(n)
    Path(a.screenshot).parent.mkdir(parents=True, exist_ok=True)
    info = screenshot(sim, a.screenshot)
    print(f"== screen ({info['w']}x{info['h']}) saved to {a.screenshot}")
    print(f"\n== ran {res['insns'] / 1e6:.1f} M instructions in {res['seconds']:.1f} s; pc = {res['pc']}")
    if res["error"]:
        print(f"== stopped: {res['error']}")
    print("== where time went (1 sample per 1M instructions):")
    for s, c in res["hot"].most_common(8):
        print(f"   {c:4d}  {s}")
    print("== unmodelled peripheral registers (first access site):")
    for (op, addr, size), c in sorted(sim.unmodelled.items(), key=lambda kv: kv[0][1]):
        print(f"   {op}{size * 8:<2} {addr:#010x} x{c:<7} first at {sim.sym(sim.first_seen[(op, addr)])}")
    fl = sim.dev.flash
    print(f"== SPI flash: commands {sorted(set(fl.cmds))}, {len(fl.reads)} reads")
    for addr, n in fl.reads[:40]:
        print(f"   read {addr:#08x} +{n:#x}")
    print(f"== SD commands: {[c for c, _ in sim.dev.mmc0.log][:40]}")
    out = sim.dev.uart_text()
    if out:
        print("== UART output:\n" + out)




def screenshot(sim, path):
    """Render DE2 mixer 0 UI channel 1 (0x01104000): RGB565 layer with size/pitch/address."""
    from PIL import Image
    attr, size, pitch, addr = (sim.r32(0x01104000 + o) for o in (0x00, 0x04, 0x0C, 0x10))
    w, h = (size & 0x1FFF) + 1, ((size >> 16) & 0x1FFF) + 1
    fmt = (attr >> 8) & 0x1F
    raw = bytes(sim.uc.mem_read(addr, pitch * h))
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        row = raw[y * pitch:(y + 1) * pitch]
        for x in range(w):
            v = row[2 * x] | row[2 * x + 1] << 8
            px[x, y] = ((v >> 11) << 3, ((v >> 5) & 0x3F) << 2, (v & 0x1F) << 3)
    img.save(path)
    return {"attr": hex(attr), "w": w, "h": h, "pitch": pitch, "addr": hex(addr), "fmt": fmt}


if __name__ == "__main__":
    sys.exit(main())
