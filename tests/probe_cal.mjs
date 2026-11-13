// Boots to the main screen and prints the state used by the calibrated sample conversion
// (calibration_gain_baseline_clamp_conversion 0x4004073C, selector 0x4004C544). Research helper.
// Usage (decomp root): node tools/sim/tests/probe_cal.mjs [insns, default 1700M]
import fs from 'node:fs';
import { Machine } from '../web/core/machine.js';

const n = parseFloat(process.argv[2] || '1700') * 1e6;
const m = new Machine(fs.readFileSync('build/extract/app.bin'), {});
const calls = { conv: 0, sel: 0, load: 0 };
const convArgs = [];
m.cpu.prehooks.set(0x4004073C, (c) => { calls.conv++; if (convArgs.length < 6) convArgs.push([...c.r.slice(0, 4)].map((v) => v >>> 0)); });
m.cpu.prehooks.set(0x4004C544, () => calls.sel++);
m.cpu.prehooks.set(0x400446B4, () => calls.load++);
m.boot(n);
const SYS = 0x40544E68, CAL = 0x42E53A0C;
const u8 = (o) => m.r8(SYS + o), u16 = (o) => m.r16(SYS + o), u32 = (o) => m.r32(SYS + o) >>> 0, s32 = (o) => m.r32(SYS + o) | 0;
const hex = (v) => '0x' + (v >>> 0).toString(16);
console.log('insns', m.cpu.insns / 1e6, 'M; error', m.error, '; calls', calls);
console.log('conversion args (r0 lane, r1 channel, r2 dst, r3):', convArgs.map((a) => a.map(hex).join(' ')).join(' | '));
console.log('literal magic at 0x400413C0:', hex(m.r32(0x400413C0)), ' SYS literal check', hex(m.r32(0x40040b18)));
console.log({
  vdivIdx1_41: u8(0x41), vdivIdx2_105: u8(0x105), off1_60: s32(0x60), off2_120: s32(0x120),
  r1c0: s32(0x1C0), e0: s32(0xE0), a0: s32(0x1A0), b8: u8(0x1B8), shift264: s32(0x264), max_a: u16(0x0A), centre_0e: u16(0x0E),
  sel588: u8(0x588), sel6ed: u8(0x6ED), sel6ec: u8(0x6EC), mode100: u8(0x100), pos6f2: u16(0x6F2), x7e0: hex(u32(0x7E0)),
});
console.log('gain table CH1 (+0x1C4):', Array.from({ length: 16 }, (_, i) => s32(0x1C4 + 4 * i)).join(' '));
console.log('gain table CH2 (+0x214):', Array.from({ length: 16 }, (_, i) => s32(0x214 + 4 * i)).join(' '));
const cal = (o) => m.r32(CAL + o) >>> 0;
console.log('cal head +0..+0x0c:', [0, 4, 8, 12].map((o) => hex(cal(o))).join(' '));
console.log('A (+0x10):', Array.from({ length: 8 }, (_, i) => hex(cal(0x10 + 4 * i))).join(' '));
console.log('B (+0x30):', Array.from({ length: 8 }, (_, i) => hex(cal(0x30 + 4 * i))).join(' '));
let nz = 0; for (let o = 0x50; o < 0x190 + 32 * 0xC8; o += 4) if (cal(o)) nz++;
console.log('non-zero words in aux+matrix (32 cols):', nz);
console.log('flash 0x1FB000:', Array.from(m.dev.flash.mem.subarray(0x1FB000, 0x1FB010)).map((b) => b.toString(16)).join(' '));
