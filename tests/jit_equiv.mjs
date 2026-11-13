// Runs the machine with and without the block compiler side by side and compares registers, CPSR,
// VFP registers and a hash of all memory at every checkpoint. Both must stay identical.
// Usage (decomp root): node tools/sim/tests/jit_equiv.mjs [total, default 1800M] [step, default 100M]
import fs from 'node:fs';
import { Machine } from '../web/core/machine.js';

const total = parseFloat(process.argv[2] || '1800') * 1e6, step = parseFloat(process.argv[3] || '100') * 1e6;
const image = fs.readFileSync('build/extract/app.bin');
const a = new Machine(image, {}), b = new Machine(image, {});
a.cpu.jit = true; b.cpu.jit = false;
for (const m of [a, b]) m.dev.frontend.ch[0] = { on: true, wave: 'sine', freq: 20000, vpp: 1, offset: 0, probe: 1, source: 'gen' };

function digest(m) {
  let hsh = 0x811C9DC5;
  for (const region of [m.dram, m.sram, m.mmio]) {
    const w = new Int32Array(region.buffer, region.byteOffset, region.byteLength >> 2);
    for (let i = 0; i < w.length; i++) hsh = Math.imul(hsh ^ w[i], 16777619);
  }
  const c = m.cpu;
  return { regs: [...c.r].join(','), cpsr: c.cpsr, pc: c.pc, vfp: [...c.v32].join(','), mem: hsh >>> 0, insns: c.insns, irqs: m.irqs };
}
let ok = true;
const t0 = Date.now();
for (let done = 0; done < total && ok; done += step) {
  const ta = Date.now(); a.boot(step); const tja = Date.now() - ta;
  const tb = Date.now(); b.boot(step); const tjb = Date.now() - tb;
  const da = digest(a), db = digest(b);
  const diff = Object.keys(da).filter((k) => da[k] !== db[k]);
  console.log(`${((done + step) / 1e6).toFixed(0)}M  jit ${(step / tja / 1e3).toFixed(0)} MIPS  interp ${(step / tjb / 1e3).toFixed(0)} MIPS  ${diff.length ? 'DIFF ' + diff.join(',') : 'same'}`);
  if (diff.length) { ok = false; for (const k of diff) console.log(`  ${k}: jit ${String(da[k]).slice(0, 200)}\n      int ${String(db[k]).slice(0, 200)}`); }
}
console.log(ok ? `identical after ${(total / 1e6).toFixed(0)}M instructions (${((Date.now() - t0) / 1000).toFixed(0)} s)` : 'MISMATCH');
process.exit(ok ? 0 : 1);
