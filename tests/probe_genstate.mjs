// Prints which words of the generator state block (0x42E42800..0x42E42900) change on each tap.
// Usage (decomp root): node tools/sim/tests/probe_genstate.mjs "690,575;500,199;823,157" [--png prefix]
import fs from 'node:fs';
import { Machine } from '../web/core/machine.js';

const args = process.argv.slice(2);
const taps = (args[0] || '').split(';').filter(Boolean).map((s) => s.split(',').map(Number));
const m = new Machine(fs.readFileSync('build/extract/app.bin'), {});
m.boot(1700e6);
const B = 0x42E42840, N = 64;
const read = () => Array.from({ length: N }, (_, i) => m.r32(B + 4 * i) | 0);
for (let k = 0; k < taps.length; k++) {
  const [x, y] = taps[k];
  const before = read();
  m.dev.touch.event('down', x, y); m.boot(20e6); m.dev.touch.event('up', x, y); m.boot(130e6);
  const after = read();
  const ch = [];
  for (let i = 0; i < N; i++) if (before[i] !== after[i]) ch.push(`+0x${(4 * i + 0x40).toString(16)}: ${before[i]} -> ${after[i]}`);
  console.log(`== tap ${k} (${x},${y}) ${ch.join('  ')}`);
}
