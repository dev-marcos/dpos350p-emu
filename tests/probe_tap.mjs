// Which functions run because of a tap? Boots to the main screen, runs the tap sequence and, for
// the last tap, prints the functions called more often than during an idle window of the same
// length. Research helper.
// Usage (decomp root): node tools/sim/tests/probe_tap.mjs "150,575;534,85" [--watch 0x102,0x105]
import fs from 'node:fs';
import { Machine, symbolTable } from '../web/core/machine.js';

const args = process.argv.slice(2);
const taps = (args[0] || '').split(';').filter(Boolean).map((s) => s.split(',').map(Number));
const wi = args.indexOf('--watch');
const watch = wi > 0 ? args[wi + 1].split(',').map((x) => parseInt(x, 16)) : [];
const rows = fs.readFileSync('symbols/symbols_2025-06-19.csv', 'utf8').split('\n').slice(1).map((l) => l.split(',')).filter((r) => r[3] && r[3].startsWith('function'));
const symbols = symbolTable(rows.map((r) => [parseInt(r[0], 16), r[2]]));
const m = new Machine(fs.readFileSync('build/extract/app.bin'), { symbols });
let counts = new Map();
for (const r of rows) {
  const a = parseInt(r[0], 16);
  if (r[3] !== 'function_arm' || m.cpu.hooks.has(a) || m.cpu.prehooks.has(a)) continue;   // keep the boot shortcuts
  m.cpu.prehooks.set(a, () => counts.set(a, (counts.get(a) || 0) + 1));
}
const SYS = 0x40544E68;
m.boot(1700e6);
const window = (fn) => { counts = new Map(); fn(); return counts; };
const run = (x, y) => { m.dev.touch.event('down', x, y); m.boot(30e6); m.dev.touch.event('up', x, y); m.boot(120e6); };
const idle = window(() => m.boot(150e6));
for (let k = 0; k < taps.length; k++) {
  const [x, y] = taps[k];
  const before = watch.map((o) => m.r8(SYS + o));
  const c = window(() => run(x, y));
  const after = watch.map((o) => m.r8(SYS + o));
  const extra = [...c.entries()].filter(([a, n]) => n > (idle.get(a) || 0) * 1.5 + 2).sort((a, b) => a[0] - b[0]);
  console.log(`== tap ${k} (${x},${y}) watch ${watch.map((o, i) => `+0x${o.toString(16)}:${before[i]}->${after[i]}`).join(' ')}`);
  console.log(`   (${c.size} functions called, idle ${idle.size})`);
  console.log('   extra calls: ' + extra.map(([a, n]) => `${m.sym(a)}x${n}`).join(' '));
}
