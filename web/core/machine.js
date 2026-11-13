// Whole machine: memory map, CPU, peripherals, fast paths, boot loop (port of sim.py).
import { Cpu, Fault, DRAM } from './cpu.js';
import { Board } from './board.js';

export const DRAM_SIZE = 64 << 20;               // V3s: 64 MiB DDR2 in package
export const SRAM_SIZE = 0x01000000;             // SRAM A1 + low space (unbacked reads do not fault on the SoC)
export const HIVEC = 0xFFFF0000;
export const MMIO = 0x01000000, MMIO_SIZE = 16 << 20;
export const RESET = 0x4008CB28;
export const FB_LAYER = 0x01104000;              // DE2 mixer 0, UI channel 1

export class Machine {
  constructor(image, opts = {}) {
    this.sdImage = opts.sdImage || new Uint8Array(64 << 20);
    this.dram = new Uint8Array(DRAM_SIZE);
    this.sram = new Uint8Array(SRAM_SIZE);
    this.hivec = new Uint8Array(0x10000);
    this.mmio = new Uint8Array(MMIO_SIZE);
    this.dram.set(image, 0);
    this.symbols = opts.symbols || null;         // {addr: Uint32Array (sorted), name: string[]}
    this.unmodelled = new Map();                 // "R|addr|size" -> {count, first}
    const self = this;
    this.bus = {
      dram: this.dram,
      read: (a, size) => self.busRead(a, size),
      write: (a, size, v) => self.busWrite(a, size, v),
    };
    this.cpu = new Cpu(this.bus);
    this.dev = new Board(this);
    this.cpu.prehooks = new Map();
    this.installHooks(opts);
    this.started = false;
    this.irqs = 0;
    this.hot = new Map();
    this.error = null;
  }

  // ---------------------------------------------------------------- raw memory (no device side effects)
  region(a) {
    if (a < SRAM_SIZE) return [this.sram, a];
    if (a >= MMIO && a < MMIO + MMIO_SIZE) return [this.mmio, a - MMIO];
    const o = (a - DRAM) >>> 0;
    if (o < DRAM_SIZE) return [this.dram, o];
    if (a >= HIVEC) return [this.hivec, a - HIVEC];
    return null;
  }
  r8(a) { const g = this.region(a >>> 0); return g ? g[0][g[1]] : 0; }
  r16(a) { return this.r8(a) | (this.r8(a + 1) << 8); }
  r32(a) {
    a >>>= 0;
    const g = this.region(a);
    if (g && !(a & 3) && g[1] + 3 < g[0].length) { const m = g[0], o = g[1]; return (m[o] | (m[o + 1] << 8) | (m[o + 2] << 16) | (m[o + 3] << 24)) >>> 0; }
    return (this.r8(a) | (this.r8(a + 1) << 8) | (this.r8(a + 2) << 16) | (this.r8(a + 3) << 24)) >>> 0;
  }
  w8(a, v) { const g = this.region(a >>> 0); if (g) g[0][g[1]] = v; }
  w32(a, v) { for (let i = 0; i < 4; i++) this.w8(a + i, v >>> (8 * i)); this.cpu.invalidate(a >>> 0, 4); }
  writeBytes(a, bytes) {
    a >>>= 0;
    const g = this.region(a);
    if (g && g[1] + bytes.length <= g[0].length) g[0].set(bytes, g[1]);
    else for (let i = 0; i < bytes.length; i++) this.w8(a + i, bytes[i]);
    this.cpu.invalidate(a, bytes.length);
  }
  readBytes(a, n) {
    a >>>= 0;
    const g = this.region(a);
    if (g && g[1] + n <= g[0].length) return g[0].slice(g[1], g[1] + n);
    const out = new Uint8Array(n); for (let i = 0; i < n; i++) out[i] = this.r8(a + i); return out;
  }

  // ---------------------------------------------------------------- bus (CPU accesses outside the DRAM fast path)
  busRead(a, size) {
    if (a >= MMIO && a < MMIO + MMIO_SIZE) {
      const v = this.dev.read(a, size);
      const o = a - MMIO, m = this.mmio;
      if (v === undefined) this.note('R', a, size);
      else for (let i = 0; i < size; i++) m[o + i] = (v >>> (8 * i)) & 0xFF;
      let r = 0; for (let i = 0; i < size; i++) r |= m[o + i] << (8 * i);
      return r >>> 0;
    }
    const g = this.region(a);
    if (!g) throw new Fault(`unmapped read 0x${a.toString(16)} (size ${size}) at ${this.sym(this.cpu.pc)}`);
    let r = 0; for (let i = 0; i < size; i++) r |= this.r8(a + i) << (8 * i);
    return r >>> 0;
  }
  busWrite(a, size, v) {
    if (a >= MMIO && a < MMIO + MMIO_SIZE) {
      const mask = size === 4 ? 0xFFFFFFFF : (1 << (8 * size)) - 1;
      if (!this.dev.write(a, size, (v & mask) >>> 0)) this.note('W', a, size);
      const o = a - MMIO;
      for (let i = 0; i < size; i++) this.mmio[o + i] = (v >>> (8 * i)) & 0xFF;     // the store lands in the backing RAM
      return;
    }
    const g = this.region(a);
    if (!g) throw new Fault(`unmapped write 0x${a.toString(16)} (size ${size}) at ${this.sym(this.cpu.pc)}`);
    for (let i = 0; i < size; i++) this.w8(a + i, v >>> (8 * i));
  }
  note(op, addr, size) {
    const k = `${op}|${addr}|${size}`;
    const e = this.unmodelled.get(k);
    if (e) e.count++; else this.unmodelled.set(k, { op, addr, size, count: 1, first: this.cpu.pc });
  }

  // ---------------------------------------------------------------- fast paths and boot shortcuts
  installHooks(opts) {
    const c = this.cpu, dev = this.dev;
    const ret = (cpu) => cpu.bxWrite(cpu.r[14]);
    c.hooks.set(0x4006A550, ret);                          // clean+invalidate D-cache by set/way: no caches modelled
    // the bit-banged FPGA bus primitives, the timer-polling delays and the GT911 register accessors
    c.hooks.set(0x4004927C, (cpu) => { dev.fpga.command(cpu.r[0] & 0xFF); ret(cpu); });
    c.hooks.set(0x40049214, (cpu) => { dev.fpga.write(cpu.r[0] & 0xFF); ret(cpu); });
    c.hooks.set(0x400491B8, (cpu) => { cpu.r[0] = dev.fpga.read(); ret(cpu); });
    c.hooks.set(0x40042D0C, (cpu) => { dev.tickUs(cpu.r[0] >>> 0); ret(cpu); });
    c.hooks.set(0x40042CF0, (cpu) => { dev.tickUs((cpu.r[0] >>> 0) * 1000); ret(cpu); });
    const gt = (write) => (cpu) => {                       // (reg, addr_len, buf, len)
      const r0 = cpu.r[0] >>> 0;
      const reg = cpu.r[1] === 2 ? r0 : r0 & 0xFF;
      const buf = cpu.r[2] >>> 0, n = cpu.r[3] >>> 0;
      if (n > 0 && n < 0x1000) {
        if (write) dev.touch.write(reg, this.readBytes(buf, n));
        else this.writeBytes(buf, dev.touch.read(reg, n));
      }
      ret(cpu);
    };
    c.hooks.set(0x40049700, gt(false));
    c.hooks.set(0x40049688, gt(true));
    // POST checks that need calibrated measurements (only reached when the factory flow runs)
    if (opts.bypassCalibration) {
      c.prehooks.set(0x400513DC, () => this.w8(0x42E68B01, 1));
      c.prehooks.set(0x4005141C, () => this.w8(0x42E68AF3, 1));
      c.prehooks.set(0x400514D8, () => this.w8(0x42E68B1F, 1));
    }
    // a shipped unit has finished the factory flow: saved state 0x42E68AE0 = 0x5A5555A5
    if (opts.factoryDone !== false) c.prehooks.set(0x40051CF0, () => this.w32(0x42E68AE0, 0x5A5555A5));
  }

  // ---------------------------------------------------------------- run
  // Runs in slices; between slices device time advances and pending IRQs are delivered.
  boot(maxInsns, chunk = 500000, onSlice = null) {
    const c = this.cpu;
    if (!this.started) {
      c.mode = 0x13; c.setCpsr(0x1D3, 0xF);
      c.pc = RESET;
      this.started = true;
    }
    const end = c.insns + maxInsns;
    while (c.insns < end && !this.error) {
      try {
        c.run(chunk);
      } catch (e) {
        if (e instanceof Fault) { this.error = `${e.message}`; break; }
        throw e;
      }
      if (c.insns % 1000000 < chunk) {
        const k = `${this.sym(c.pc)}  <- ${this.sym(c.r[14] >>> 0)}`;
        this.hot.set(k, (this.hot.get(k) || 0) + 1);
      }
      this.dev.tick(chunk);
      if (this.dev.gic.hasPending() && !c.I) { c.irq(); this.irqs++; }
      if (onSlice && onSlice(this)) break;
    }
    return { insns: c.insns, error: this.error };
  }

  sym(a) {
    a >>>= 0;
    const s = this.symbols;
    if (!s) return '0x' + a.toString(16);
    let lo = 0, hi = s.addr.length - 1, i = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (s.addr[mid] <= a) { i = mid; lo = mid + 1; } else hi = mid - 1; }
    if (i < 0) return '0x' + a.toString(16);
    const d = a - s.addr[i];
    return d ? `${s.name[i]}+0x${d.toString(16)}` : s.name[i];
  }

  // ---------------------------------------------------------------- display
  // RGB565 framebuffer of DE2 UI channel 1: {w, h, pitch, data (Uint8Array view into DRAM)}
  framebuffer() {
    const attr = this.r32(FB_LAYER), size = this.r32(FB_LAYER + 4), pitch = this.r32(FB_LAYER + 0x0C), addr = this.r32(FB_LAYER + 0x10);
    const w = (size & 0x1FFF) + 1, h = ((size >>> 16) & 0x1FFF) + 1;
    const o = (addr - DRAM) >>> 0;
    if (!size || !pitch || o + pitch * h > DRAM_SIZE) return null;
    return { w, h, pitch, attr, addr, data: this.dram.subarray(o, o + pitch * h) };
  }
}

// symbols CSV/JSON -> lookup table
export function symbolTable(list) {
  const pairs = list.slice().sort((a, b) => a[0] - b[0]);
  return { addr: Uint32Array.from(pairs.map((p) => p[0])), name: pairs.map((p) => p[1]) };
}
