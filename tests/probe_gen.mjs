// Finds the generator settings in RAM: boots, opens the GEN menu, steps the frequency 1 kHz ->
// 101 kHz -> 201 kHz and lists the words that hold those values (u32, f32 or f64). Research helper.
import fs from 'node:fs';
import { Machine } from '../web/core/machine.js';

const m = new Machine(fs.readFileSync('build/extract/app.bin'), {});
m.boot(1700e6);
const tap = (x, y) => { m.dev.touch.event('down', x, y); m.boot(20e6); m.dev.touch.event('up', x, y); m.boot(130e6); };
tap(690, 575); tap(890, 232); tap(890, 232);
const snaps = [];
const snap = () => snaps.push(m.dram.slice(0, 48 << 20));
snap(); tap(823, 157); snap(); tap(823, 157); snap();
const want = [1000, 101000, 201000];
const dv = snaps.map((s) => new DataView(s.buffer));
const hits = [];
for (let o = 0; o + 8 <= snaps[0].length; o += 4) {
  const u = dv.map((d) => d.getUint32(o, true));
  if (u[0] === want[0] && u[1] === want[1] && u[2] === want[2]) hits.push(`u32 @${(0x40000000 + o).toString(16)}`);
  const f = dv.map((d) => d.getFloat32(o, true));
  if (f.every((x, i) => Math.abs(x - want[i]) < 1e-3)) hits.push(`f32 @${(0x40000000 + o).toString(16)}`);
  const g = dv.map((d) => d.getFloat64(o, true));
  if (g.every((x, i) => Math.abs(x - want[i]) < 1e-6)) hits.push(`f64 @${(0x40000000 + o).toString(16)}`);
  const mhz = dv.map((d) => d.getUint32(o, true));
  if (mhz[0] === want[0] * 1000 && mhz[1] === want[1] * 1000 && mhz[2] === want[2] * 1000) hits.push(`u32(mHz) @${(0x40000000 + o).toString(16)}`);
}
console.log(hits.join('\n') || 'no hits');
for (const hh of hits.slice(0, 6)) {
  const a = parseInt(hh.split('@')[1], 16), base = a - 0x40;
  const words = []; for (let i = 0; i < 48; i++) words.push((m.r32(base + 4 * i) >>> 0).toString(16));
  console.log(`around ${a.toString(16)} (from ${base.toString(16)}):`, words.join(' '));
}
