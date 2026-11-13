#!/usr/bin/env python3
"""Reference cases for the JavaScript CPU core (web/core/cpu.js), produced with Unicorn.

Every distinct instruction of the firmware's functions (ARM and Thumb, from the symbol table) runs
once from a random state; the state before and after goes to a JSON-lines file that
tests/cpu_test.mjs replays against the JS core.

Usage (inside dpos-re, from the decomp repository root):
  python3 tools/sim/tests/gen_cpu_cases.py [--image build/extract/app.bin] [--out build/cpu_cases.jsonl]
"""
import argparse
import csv
import json
import random
import struct
from pathlib import Path

from capstone import Cs, CS_ARCH_ARM, CS_MODE_ARM, CS_MODE_THUMB
from unicorn import Uc, UcError, UC_ARCH_ARM, UC_MODE_ARM
from unicorn import arm_const as R

DRAM, DRAM_SIZE = 0x40000000, 64 << 20
SCRATCH, SCRATCH_SIZE = 0x40800000, 0x10000
REGS = [getattr(R, f"UC_ARM_REG_R{i}") for i in range(13)] + [R.UC_ARM_REG_SP, R.UC_ARM_REG_LR]
DREGS = [getattr(R, f"UC_ARM_REG_D{i}") for i in range(32)]
SKIP = ("mcr", "mrc", "svc", "cdp", "ldc", "stc", "bkpt", "udf", "wfi", "wfe", "sev", "srs", "rfe", "cps",
        "msr", "mrs", "ldrt", "strt", "ldrbt", "strbt", "ldrht", "strht", "ldrsbt", "ldrsht", "smc", "hvc", "eret")


def instructions(image, symfile):
    seen = {}
    mds = {"function_arm": Cs(CS_ARCH_ARM, CS_MODE_ARM), "function_thumb": Cs(CS_ARCH_ARM, CS_MODE_THUMB)}
    for r in csv.DictReader(open(symfile)):
        md = mds.get(r["type"])
        if not md:
            continue
        a, n = int(r["address"], 16), int(r["size"])
        thumb = r["type"] == "function_thumb"
        for i in md.disasm(image[a - DRAM:a - DRAM + n], a):
            mn = i.mnemonic.split(".")[0]
            if any(mn.startswith(s) for s in SKIP):
                continue
            key = (thumb, bytes(i.bytes))
            if key not in seen:
                seen[key] = (i.address, f"{i.mnemonic} {i.op_str}")
    return seen


def fvals(rng):
    pick = rng.random()
    if pick < 0.3:
        return float(rng.randint(-1000, 1000))
    if pick < 0.6:
        return rng.uniform(-1e4, 1e4)
    if pick < 0.8:
        return rng.uniform(-2, 2)
    return rng.choice([0.0, -0.0, 1.0, 0.5, 1e-300, 3e9, -3e9, 4.5e9, 1e20])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", default="build/extract/app.bin")
    ap.add_argument("--symbols", default="symbols/symbols_2025-06-19.csv")
    ap.add_argument("--out", default="build/cpu_cases.jsonl")
    ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args()
    image = Path(a.image).read_bytes().ljust(0x100000, bytes(1))
    rng = random.Random(a.seed)
    scratch = bytes(rng.getrandbits(8) for _ in range(SCRATCH_SIZE))
    Path(a.out).with_suffix(".scratch").write_bytes(scratch)

    uc = Uc(UC_ARCH_ARM, UC_MODE_ARM)
    try:
        from unicorn.arm_const import UC_CPU_ARM_CORTEX_A7
        uc.ctl_set_cpu_model(UC_CPU_ARM_CORTEX_A7)
    except Exception:
        pass
    uc.mem_map(DRAM, DRAM_SIZE)
    uc.mem_write(DRAM, image)
    uc.reg_write(R.UC_ARM_REG_C1_C0_2, 0x00F00000)        # CPACR: CP10/CP11 full access
    uc.reg_write(R.UC_ARM_REG_FPEXC, 0x40000000)          # FPEXC.EN

    insns = instructions(image, a.symbols)
    out = open(a.out, "w")
    stats = {"cases": 0, "faults": 0}
    for (thumb, raw), (addr, text) in sorted(insns.items(), key=lambda kv: kv[1][0]):
        for mode in ("ptr", "mix", "rand"):
            if mode == "ptr":
                regs = [SCRATCH + 0x4000 + 8 * rng.randrange(0, 0x1000) for _ in range(15)]
            elif mode == "mix":
                regs = [SCRATCH + 0x4000 + 8 * rng.randrange(0, 0x1000) if rng.random() < 0.5 else rng.randrange(0, 256) for _ in range(15)]
            else:
                regs = [rng.getrandbits(32) if rng.random() < 0.7 else rng.randrange(0, 64) for _ in range(15)]
            flags = rng.getrandbits(4) << 28
            cpsr = flags | 0x1D3 | (0x20 if thumb else 0)
            spsr = rng.getrandbits(4) << 28 | 0x1D3
            dvals = [struct.unpack("<Q", struct.pack("<d", fvals(rng)))[0] for _ in range(32)]
            if rng.random() < 0.5:            # some cases with single-precision values in S0..S31
                for k in range(16):
                    lo, hi = (struct.unpack("<I", struct.pack("<f", fvals(rng)))[0] for _ in range(2))
                    dvals[k] = lo | (hi << 32)
            fpscr = rng.getrandbits(4) << 28
            uc.mem_write(SCRATCH, scratch)
            uc.mem_write(DRAM, image[:0x100000])
            for r_, v in zip(REGS, regs):
                uc.reg_write(r_, v)
            uc.reg_write(R.UC_ARM_REG_CPSR, cpsr)
            uc.reg_write(R.UC_ARM_REG_SPSR, spsr)
            for r_, v in zip(DREGS, dvals):
                uc.reg_write(r_, v)
            uc.reg_write(R.UC_ARM_REG_FPSCR, fpscr)
            err = None
            try:
                uc.emu_start(addr | (1 if thumb else 0), 0xFFFFFFFF, count=1)
            except UcError as e:
                err = str(e)
            if err:
                stats["faults"] += 1
                continue
            after = [uc.reg_read(r_) for r_ in REGS]
            mem = uc.mem_read(SCRATCH, SCRATCH_SIZE)
            diff = [[SCRATCH + i, mem[i]] for i in range(SCRATCH_SIZE) if mem[i] != scratch[i]] if mem != scratch else []
            cdiff = []
            code = uc.mem_read(DRAM, 0x100000)
            if code != image[:0x100000]:
                cdiff = [[DRAM + i, code[i]] for i in range(0x100000) if code[i] != image[i]]
            case = {
                "addr": addr, "thumb": thumb, "text": text, "mode": mode,
                "regs": regs, "cpsr": cpsr, "spsr": spsr, "d": [f"{v:016x}" for v in dvals], "fpscr": fpscr,
                "out": {
                    "regs": after, "pc": uc.reg_read(R.UC_ARM_REG_PC), "cpsr": uc.reg_read(R.UC_ARM_REG_CPSR),
                    "d": [f"{uc.reg_read(r_):016x}" for r_ in DREGS], "fpscr": uc.reg_read(R.UC_ARM_REG_FPSCR),
                    "mem": diff + cdiff,
                },
            }
            out.write(json.dumps(case) + "\n")
            stats["cases"] += 1
    print(f"{len(insns)} distinct instructions, {stats['cases']} cases, {stats['faults']} faulted (skipped) -> {a.out}")


if __name__ == "__main__":
    main()
