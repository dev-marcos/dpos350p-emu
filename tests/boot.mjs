// Headless boot of the JS machine (same role as `python3 -m tools.sim.sim`).
// Usage (from the decomp repository root):
//   node tools/sim/tests/boot.mjs [--image build/extract/app.bin] [--insns 1500M] [--png build/sim/js_screen.png]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Machine, symbolTable } from '../web/core/machine.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i < 0 ? d : args[i + 1]; };
const image = fs.readFileSync(opt('--image', 'build/extract/app.bin'));
const nStr = opt('--insns', '1500M');
const n = parseFloat(nStr) * (nStr.endsWith('M') ? 1e6 : nStr.endsWith('K') ? 1e3 : 1);
const pngPath = opt('--png', 'build/sim/js_screen.png');

let symbols = null;
const csv = 'symbols/symbols_2025-06-19.csv';
if (fs.existsSync(csv)) {
  const rows = fs.readFileSync(csv, 'utf8').split('\n').slice(1).map((l) => l.split(',')).filter((r) => r[3] && r[3].startsWith('function'));
  symbols = symbolTable(rows.map((r) => [parseInt(r[0], 16), r[2]]));
}

const m = new Machine(image, { symbols, factoryDone: !args.includes('--no-factory-done'), bypassCalibration: args.includes('--bypass-calibration') });
// --ch1 / --ch2 'freq=20000,vpp=1,wave=square' set the virtual probe signals
for (const [flag, c] of [['--ch1', 0], ['--ch2', 1]]) {
  const v = opt(flag, null);
  if (v) for (const kv of v.split(',')) { const [k, x] = kv.split('='); m.dev.frontend.ch[c][k] = isNaN(+x) ? x : +x; }
}
const t0 = Date.now();
let last = t0, lastI = 0;
m.boot(n, 500000, (mm) => {
  const now = Date.now();
  if (now - last > 5000) {
    console.log(`  ${(mm.cpu.insns / 1e6).toFixed(0)} M insns, ${((mm.cpu.insns - lastI) / (now - last) / 1e3).toFixed(1)} MIPS, pc ${mm.sym(mm.cpu.pc)}`);
    last = now; lastI = mm.cpu.insns;
  }
  return false;
});
const dt = (Date.now() - t0) / 1000;
console.log(`== ran ${(m.cpu.insns / 1e6).toFixed(1)} M instructions in ${dt.toFixed(1)} s (${(m.cpu.insns / dt / 1e6).toFixed(1)} MIPS); pc = ${m.sym(m.cpu.pc)}; irqs ${m.irqs}; csi frames ${m.dev.csi.frames}`);
if (m.error) console.log(`== stopped: ${m.error}`);
console.log('== where time went:');
for (const [k, v] of [...m.hot.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`   ${String(v).padStart(4)}  ${k}`);
console.log('== unmodelled peripheral registers:');
for (const e of [...m.unmodelled.values()].sort((a, b) => a.addr - b.addr)) console.log(`   ${e.op}${String(e.size * 8).padEnd(2)} 0x${e.addr.toString(16).padStart(8, '0')} x${e.count} first at ${m.sym(e.first)}`);
const uart = m.dev.uartText();
if (uart) console.log('== UART output:\n' + uart);

function savePng(pngPath) {
const fb = m.framebuffer();
if (fb) {
  const raw = Buffer.alloc((fb.w * 3 + 1) * fb.h);
  for (let y = 0; y < fb.h; y++) {
    raw[y * (fb.w * 3 + 1)] = 0;
    for (let x = 0; x < fb.w; x++) {
      const v = fb.data[y * fb.pitch + 2 * x] | (fb.data[y * fb.pitch + 2 * x + 1] << 8);
      const o = y * (fb.w * 3 + 1) + 1 + 3 * x;
      raw[o] = (v >> 11) << 3; raw[o + 1] = ((v >> 5) & 0x3F) << 2; raw[o + 2] = (v & 0x1F) << 3;
    }
  }
  const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (b) => { let c = -1; for (const x of b) c = crcTable[(c ^ x) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(fb.w, 0); ihdr.writeUInt32BE(fb.h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  fs.mkdirSync(path.dirname(pngPath), { recursive: true });
  fs.writeFileSync(pngPath, png);
  console.log(`== screen ${fb.w}x${fb.h} saved to ${pngPath}`);
} else console.log('== no framebuffer configured yet');
}
savePng(pngPath);
const taps = opt('--tap', null);
if (taps) taps.split(';').forEach((xy, k) => {
  const [x, y] = xy.split(',').map(Number);
  const SYS = 0x40544E68, before = m.readBytes(SYS, 0x1000);
  m.dev.touch.event('down', x, y); m.boot(30e6); m.dev.touch.event('up', x, y); m.boot(150e6);
  const after = m.readBytes(SYS, 0x1000), diff = [];
  for (let i = 0; i < 0x1000; i++) if (before[i] !== after[i] && diff.length < 40) diff.push(`+0x${i.toString(16)}:${before[i]}->${after[i]}`);
  console.log(`== tap ${k} (${x},${y}) SYS changes: ${diff.join(' ')}`);
  savePng(pngPath.replace(/.png$/, `_tap${k}.png`));
});
