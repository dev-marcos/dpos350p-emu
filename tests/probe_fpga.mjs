// Logs FPGA bus writes (selector, bytes) caused by a sequence of taps. Research helper.
// Usage (decomp root): node tools/sim/tests/probe_fpga.mjs "690,575;823,157" [--sel 0x14,0x15]
import fs from 'node:fs';
import { Machine } from '../web/core/machine.js';

const args = process.argv.slice(2);
const taps = (args[0] || '').split(';').filter(Boolean).map((s) => s.split(',').map(Number));
const si = args.indexOf('--sel');
const only = si > 0 ? new Set(args[si + 1].split(',').map((x) => parseInt(x, 16))) : null;
const m = new Machine(fs.readFileSync('build/extract/app.bin'), {});
m.boot(1700e6);
const f = m.dev.fpga;
let log = [];
const origCmd = f.command.bind(f), origWr = f.write.bind(f);
let cur = null, bytes = [];
const flush = () => { if (cur !== null && bytes.length && (!only || only.has(cur))) log.push(`${cur.toString(16).padStart(2, '0')}:${bytes.map((b) => b.toString(16).padStart(2, '0')).join('')}`); bytes = []; };
f.command = (v) => { flush(); cur = v; origCmd(v); };
f.write = (v) => { bytes.push(v); origWr(v); };
const window = (fn) => { log = []; fn(); flush(); const counts = new Map(); for (const e of log) counts.set(e, (counts.get(e) || 0) + 1); return counts; };
const idle = window(() => m.boot(150e6));
for (let k = 0; k < taps.length; k++) {
  const [x, y] = taps[k];
  const c = window(() => { m.dev.touch.event('down', x, y); m.boot(20e6); m.dev.touch.event('up', x, y); m.boot(130e6); });
  const fresh = [...c.keys()].filter((e) => !idle.has(e));
  console.log(`== tap ${k} (${x},${y}): ${fresh.length} new write patterns`);
  console.log('   ' + fresh.slice(0, 40).join(' '));
}
