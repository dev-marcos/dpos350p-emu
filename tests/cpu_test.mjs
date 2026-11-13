// Replays the Unicorn reference cases (tests/gen_cpu_cases.py) against web/core/cpu.js.
// Usage (from the decomp repository root):
//   node tools/sim/tests/cpu_test.mjs [build/cpu_cases.jsonl] [build/extract/app.bin] [--max-fail N] [--filter text]
import fs from 'node:fs';
import readline from 'node:readline';
import { Cpu } from '../web/core/cpu.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const maxFail = +opt('--max-fail', 40);
const filter = opt('--filter', '');
const casesPath = args[0] || 'build/cpu_cases.jsonl';
const imagePath = args[1] || 'build/extract/app.bin';

const DRAM = 0x40000000, SCRATCH = 0x40800000, SCRATCH_SIZE = 0x10000;
const image = new Uint8Array(0x100000); image.set(fs.readFileSync(imagePath));
const scratch = new Uint8Array(fs.readFileSync(casesPath.replace(/\.jsonl$/, '.scratch')));
const dram = new Uint8Array(64 << 20);
const bus = {
  dram,
  read(a, size) { throw new Error(`unmapped read 0x${a.toString(16)}`); },
  write(a, size, v) { throw new Error(`unmapped write 0x${a.toString(16)}`); },
};
const cpu = new Cpu(bus);
cpu.cp15.set(0x1002, 0x00F00000);
cpu.fpexc = 0x40000000;
const scr32 = new Uint32Array(dram.buffer, SCRATCH - DRAM, SCRATCH_SIZE / 4);
const ref32 = new Uint32Array(scratch.buffer, scratch.byteOffset, SCRATCH_SIZE / 4);

const hex = (v) => '0x' + (v >>> 0).toString(16).padStart(8, '0');
let n = 0, fails = 0, faults = 0;
const byText = new Map();
const rl = readline.createInterface({ input: fs.createReadStream(casesPath), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line) continue;
  const k = JSON.parse(line);
  if (filter && !k.text.includes(filter)) continue;
  // Unicorn runs a whole IT block as one step (count=1); architecturally IT is its own instruction
  if (k.thumb && /^it[te]* /.test(k.text)) continue;
  n++;
  dram.set(image, 0);
  dram.set(scratch, SCRATCH - DRAM);
  cpu.mode = 0x13;
  cpu.setCpsr(k.cpsr, 0xF);
  cpu.it = 0;
  cpu.spsr = k.spsr;
  for (let i = 0; i < 15; i++) cpu.r[i] = k.regs[i];
  for (let i = 0; i < 32; i++) { const s = k.d[i]; cpu.v32[2 * i] = parseInt(s.slice(8), 16); cpu.v32[2 * i + 1] = parseInt(s.slice(0, 8), 16); }
  cpu.fpscr = k.fpscr;
  cpu.pc = k.addr; cpu.T = k.thumb ? 1 : 0;
  const diffs = [];
  try {
    cpu.run(1);
  } catch (e) {
    diffs.push(`exception: ${e.message}`);
    faults++;
  }
  const o = k.out;
  if (!diffs.length) {
    for (let i = 0; i < 15; i++) if ((cpu.r[i] >>> 0) !== (o.regs[i] >>> 0)) diffs.push(`r${i}=${hex(cpu.r[i])} want ${hex(o.regs[i])}`);
    if ((cpu.pc >>> 0) !== (o.pc >>> 0)) diffs.push(`pc=${hex(cpu.pc)} want ${hex(o.pc)}`);
    const cm = 0xF80F03FF;                         // NZCVQ, GE, IT, mode/T/AIF (ignore E)
    const mine = cpu.cpsr & ~0x200, wantc = o.cpsr & ~0x200;
    if ((mine >>> 0) !== (wantc >>> 0)) diffs.push(`cpsr=${hex(mine)} want ${hex(wantc)}`);
    for (let i = 0; i < 32; i++) {
      const s = o.d[i]; const lo = parseInt(s.slice(8), 16), hi = parseInt(s.slice(0, 8), 16);
      if ((cpu.v32[2 * i] >>> 0) !== lo || (cpu.v32[2 * i + 1] >>> 0) !== hi) diffs.push(`d${i}=${(cpu.v32[2 * i + 1] >>> 0).toString(16)}${(cpu.v32[2 * i] >>> 0).toString(16).padStart(8, '0')} want ${s}`);
    }
    if ((cpu.fpscr >>> 28) !== (o.fpscr >>> 28)) diffs.push(`fpscr=${hex(cpu.fpscr)} want ${hex(o.fpscr)}`);
    const want = new Map(o.mem.map(([a, v]) => [a, v]));
    for (const [a, v] of want) if (dram[a - DRAM] !== v) diffs.push(`mem ${hex(a)}=${dram[a - DRAM]} want ${v}`);
    for (let i = 0; i < scr32.length; i++) if (scr32[i] !== ref32[i]) {
      for (let b = 0; b < 4; b++) { const a = SCRATCH + 4 * i + b; if (dram[a - DRAM] !== scratch[4 * i + b] && !want.has(a)) diffs.push(`unexpected store ${hex(a)}=${dram[a - DRAM]}`); }
    }
  }
  if (diffs.length) {
    fails++;
    const key = (k.thumb ? 'T ' : 'A ') + k.text.split(' ')[0];
    byText.set(key, (byText.get(key) || 0) + 1);
    if (fails <= maxFail) console.log(`FAIL ${hex(k.addr)} ${k.thumb ? 'T' : 'A'} ${k.text} [${k.mode}]\n    ${diffs.slice(0, 6).join('\n    ')}`);
  }
}
console.log(`\n${n} cases, ${fails} failed (${faults} exceptions)`);
if (fails) console.log('failures by mnemonic:', [...byText.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, v]) => `${k}:${v}`).join('  '));
process.exit(fails ? 1 : 0);
