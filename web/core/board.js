// Peripheral models (port of devices.py). Register meanings follow the V3s user manual (DERIVED);
// what the stock firmware expects from them was read from its code (docs/DRIVERS.md in the decomp repo).

import { calibrationBlob, CAL_STORAGE, CAL_OBJECT } from './calibration.js';

export const CCU = 0x01C20000;
export const TMR = 0x01C20C00;
export const UART = [0x01C28000, 0x01C28400, 0x01C28800];
export const PE_DAT = 0x01C208A0;

export class Board {
  constructor(m) {
    this.m = m;                                  // Machine: r32/w32/writeBytes/readBytes
    this.uart = [[], [], []];
    this.ticks = 0;                              // 24 MHz OSC ticks
    this.ticksPerInsn = 0.5;                     // emulated time per instruction (ASSUMPTION, tunable)
    this.flash = new SpiFlash();
    // channel calibration in the settings area (blank on a fresh emulated flash; see calibration.js)
    if (!m.opts || m.opts.calibration !== false) this.flash.mem.set(calibrationBlob(), CAL_STORAGE);
    this.spi0 = new Spi(this.flash);
    this.sd = new SdCard(m.sdImage);
    this.mmc0 = new Mmc(this.sd, m);
    this.fpga = new Fpga(this);
    this.peDat = 0;
    this.batteryMv = 4100;
    this.charging = false;
    this.gic = new Gic();
    this.timers = new Timers(m, this.gic);
    this.touch = new Gt911();
    this.frontend = new FrontEnd(m);
    this.csi = new Csi(m, this.gic, this.frontend);
  }

  lradcCode() { return Math.max(0, Math.min(63, Math.round((this.batteryMv - 2735.74) / 32.947))); }

  // value to read, or undefined (unmodelled: RAM-backed, logged)
  read(addr, size) {
    if (addr === 0x01C2280C) return this.lradcCode();
    if (addr >= 0x01C81000 && addr < 0x01C83000) return this.gic.read(addr);
    if (addr >= Csi.BASE && addr < Csi.BASE + 0x1000) return this.csi.read(addr - Csi.BASE);
    if (addr === PE_DAT && size === 4) {
      const mode = (this.peDat >>> 2) & 3;
      let v = this.peDat;
      if (mode === 0) v = (v & ~0xFF00) | (this.fpga.out << 8);
      return v;
    }
    if (addr >= 0x01C0F000 && addr < 0x01C10000) return this.mmc0.read(addr - 0x01C0F000, size);
    if (addr >= 0x01C68000 && addr < 0x01C69000) return this.spi0.read(addr - 0x01C68000, size);
    if (addr >= CCU && addr < CCU + 0x50 && (addr & 3) === 0) return (this.m.r32(addr) | 0x10000000) >>> 0;   // PLL LOCK
    if (addr >= CCU && addr < CCU + 0x400) return this.m.r32(addr & ~3) >>> (8 * (addr & 3));
    if (addr === TMR + 0x84 || addr === TMR + 0x88) { this.ticks += 2000; return this.ticks >>> 0; }      // AVS counters
    if (addr >= TMR && addr < TMR + 0x100) return this.m.r32(addr & ~3);
    for (let i = 0; i < 3; i++) {
      const base = UART[i];
      if (addr >= base && addr < base + 0x100) {
        const off = addr - base;
        if (off === 0x7C) return 0x6;            // USR: TX FIFO not full
        if (off === 0x14) return 0x60;           // LSR: THR empty
        return this.m.r32(addr & ~3);
      }
    }
    return undefined;
  }

  // true when modelled
  write(addr, size, value) {
    if (addr >= 0x01C81000 && addr < 0x01C83000) return this.gic.write(addr, value);
    if (addr >= Csi.BASE && addr < Csi.BASE + 0x1000) return this.csi.write(addr - Csi.BASE, value);
    if (addr === TMR + 4) {                      // timer IRQ status: write 1 to clear (the stored value is
      this.m.w32(addr, this.m.r32(addr) & ~value);   // then overwritten by the store, as in the Unicorn model)
      return true;
    }
    if (addr === PE_DAT && size === 4) {
      const old = this.peDat; this.peDat = value;
      if ((old & 1) && !(value & 1)) {           // PE0 falling edge
        const mode = (value >>> 2) & 3, data = (value >>> 8) & 0xFF;
        if (mode === 3) this.fpga.command(data);
        else if (mode === 1) this.fpga.write(data);
        else if (mode === 0) this.fpga.out = this.fpga.read();
      }
      return true;
    }
    if (addr >= 0x01C0F000 && addr < 0x01C10000) { this.mmc0.write(addr - 0x01C0F000, size, value); return true; }
    if (addr >= 0x01C68000 && addr < 0x01C69000) { this.spi0.write(addr - 0x01C68000, size, value); return true; }
    if ((addr >= CCU && addr < CCU + 0x400) || (addr >= TMR && addr < TMR + 0x100)) return true;
    for (let i = 0; i < 3; i++) {
      const base = UART[i];
      if (addr >= base && addr < base + 0x100) {
        if (addr === base) { this.uart[i].push(value & 0xFF); if (this.uart[i].length > 65536) this.uart[i].splice(0, 16384); }
        return true;
      }
    }
    return false;
  }

  tickUs(us) {                                   // a delay routine was skipped: let device time pass
    const t = (us >>> 0) * 24;
    this.ticks += t;
    this.timers.advance(t);
    this.csi.advance(us * 1000);
  }

  tick(n) {                                      // n instructions elapsed
    const t = Math.max(1, Math.floor(n * this.ticksPerInsn));
    this.ticks += t;
    this.timers.advance(t);
    this.csi.advance(n);
  }

  uartText() {
    return this.uart.map((b, i) => b.length ? `[uart${i}] ` + String.fromCharCode(...b.slice(-8000)) : '').filter(Boolean).join('\n');
  }
}

export class SpiFlash {                          // generic SPI NOR (W25Q-style), blank = 0xFF
  constructor(size = 16 << 20) {
    this.mem = new Uint8Array(size).fill(0xFF);
    this.reads = 0; this.cmds = new Set();
    this.reset();
  }
  reset() { this.cmd = null; this.buf = []; this.addr = null; this.n = 0; }
  select(on) {
    if (!on) { if ((this.cmd === 0x03 || this.cmd === 0x0B) && this.addr !== null && this.n) this.reads++; this.reset(); }
  }
  xfer(b) {
    if (this.cmd === null) { this.cmd = b; this.cmds.add(b); return 0xFF; }
    if (this.cmd === 0x9F) { const v = [0xEF, 0x40, 0x18][this.buf.length % 3]; this.buf.push(b); return v; }   // JEDEC ID (assumption)
    if (this.cmd === 0x05 || this.cmd === 0x35) return 0x00;
    if (this.cmd === 0x03 || this.cmd === 0x0B || this.cmd === 0x02) {
      if (this.buf.length < 3) {
        this.buf.push(b);
        if (this.buf.length === 3) this.addr = (this.buf[0] << 16) | (this.buf[1] << 8) | this.buf[2];
        return 0xFF;
      }
      if (this.cmd === 0x0B && this.buf.length === 3) { this.buf.push(b); return 0xFF; }
      const a = (this.addr + this.n) % this.mem.length;
      this.n++;
      if (this.cmd === 0x02) { this.mem[a] &= b; return 0xFF; }
      return this.mem[a];
    }
    return 0xFF;
  }
}

export class Spi {                               // Allwinner SPI controller
  constructor(flash) {
    this.flash = flash;
    this.regs = new Map([[0x04, 0], [0x08, 0], [0x10, 0], [0x14, 0], [0x18, 0], [0x30, 0], [0x34, 0], [0x38, 0]]);
    this.tx = []; this.rx = [];
    this.cs = false; this.remaining = 0; this.idx = 0; this.ntx = 0; this.discard = false; this.autoCs = false;
  }
  read(off, size) {
    if (off === 0x1C) return Math.min(this.rx.length, 64) | (Math.min(this.tx.length, 64) << 16);
    if (off === 0x300) { let out = 0; for (let i = 0; i < size; i++) out |= (this.rx.length ? this.rx.shift() : 0) << (8 * i); return out >>> 0; }
    return this.regs.get(off & ~3) || 0;
  }
  write(off, size, v) {
    if (off === 0x200) { for (let i = 0; i < size; i++) this.tx.push((v >>> (8 * i)) & 0xFF); this.pump(); return; }
    if (off === 0x04) v &= ~(1 << 31);
    if (off === 0x14) { this.regs.set(0x14, (this.regs.get(0x14) & ~v) >>> 0); return; }
    if (off === 0x18) { if (v & (1 << 15)) this.rx = []; if (v & (1 << 31)) this.tx = []; v &= ~((1 << 15) | (1 << 31)); }
    if (off === 0x08) {
      const csLow = (v & (1 << 6)) ? !(v & (1 << 7)) : true;
      if (csLow !== this.cs) { this.cs = csLow; this.flash.select(csLow); }
      this.regs.set(0x08, v >>> 0);
      if (v & (1 << 31)) this.exchange(v);
      return;
    }
    this.regs.set(off & ~3, v >>> 0);
  }
  exchange(tcr) {
    this.remaining = this.regs.get(0x30) & 0xFFFFFF;
    this.ntx = this.regs.get(0x34) & 0xFFFFFF;
    this.idx = 0;
    this.discard = !!(tcr & (1 << 13));
    this.autoCs = !(tcr & (1 << 6));
    if (!this.cs) this.flash.select(true);
    this.pump();
  }
  pump() {
    while (this.remaining > 0) {
      let b;
      if (this.idx < this.ntx) { if (!this.tx.length) return; b = this.tx.shift(); } else b = 0;
      const r = this.flash.xfer(b);
      if (!(this.discard && this.idx < this.ntx)) this.rx.push(r);
      this.idx++; this.remaining--;
    }
    if (this.idx) {
      this.regs.set(0x08, (this.regs.get(0x08) & ~(1 << 31)) >>> 0);
      this.regs.set(0x14, (this.regs.get(0x14) | (1 << 12)) >>> 0);
      if (this.autoCs) this.flash.select(false);
      this.idx = 0;
    }
  }
}

export class SdCard {                            // SDHC card backed by a Uint8Array image
  constructor(img) { this.img = img; this.app = false; this.rca = 0x1234; }
  csd() {                                        // 128-bit CSD v2 as BigInt
    const cSize = BigInt(Math.floor(this.img.length / (512 * 1024)) - 1);
    return (1n << 126n) | (0x0En << 112n) | (0x32n << 96n) | (0x5B5n << 84n) | (9n << 80n) | (cSize << 48n) | (1n << 46n) | (0x7Fn << 39n) | (0x0An << 22n) | (9n << 22n) | 1n;
  }
  // -> {resp (BigInt|null), long, data (Uint8Array|null), xfer ([kind, offset]|null)}
  command(idx, arg) {
    const app = this.app; this.app = false;
    const R = (resp, long = false, data = null, xfer = null) => ({ resp: resp === null ? null : BigInt(resp), long, data, xfer });
    if (app) {
      if (idx === 41) return R(0xC0FF8000);
      if (idx === 6) return R(0x920);
      if (idx === 51) return R(0x920, false, new Uint8Array([0x02, 0x35, 0x80, 0x00, 0, 0, 0, 0]));
      if (idx === 13) return R(0x920, false, new Uint8Array(64));
    }
    if (idx === 0) return R(null);
    if (idx === 8) return R(arg & 0xFFF);
    if (idx === 55) { this.app = true; return R(0x120); }
    if (idx === 2) {
      const cid = [0x03, 0x53, 0x44, 0x44, 0x50, 0x4F, 0x53, 0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x41, 0x01];
      let v = 0n; for (const b of cid) v = (v << 8n) | BigInt(b);
      return { resp: v >> 8n, long: true, data: null, xfer: null };
    }
    if (idx === 3) return R((this.rca << 16) >>> 0);
    if (idx === 9) return { resp: this.csd() >> 8n, long: true, data: null, xfer: null };
    if ([7, 12, 16, 13, 23].includes(idx)) return R(0x900);
    if (idx === 6) return R(0x900, false, new Uint8Array(64));
    if (idx === 17 || idx === 18) return R(0x900, false, null, ['read', (arg >>> 0) * 512]);
    if (idx === 24 || idx === 25) return R(0x900, false, null, ['write', (arg >>> 0) * 512]);
    return R(0x900);
  }
}

export class Mmc {                               // Allwinner SD/MMC: PIO FIFO (+0x200) and IDMAC
  constructor(card, m) { this.m = m; this.card = card; this.regs = new Map(); this.fifo = []; this.wr = null; this.commands = 0; }
  g(k) { return this.regs.get(k) || 0; }
  read(off, size) {
    if (off === 0x3C) { const words = this.fifo.length >> 2; let st = Math.min(words, 0x1F) << 17; if (!this.fifo.length) st |= 4; return st; }
    if (off === 0x200) { let out = 0; for (let i = 0; i < size; i++) out |= (this.fifo.length ? this.fifo.shift() : 0) << (8 * i); return out >>> 0; }
    if (off === 0x18) return (this.g(0x18) & ~(1 << 31)) >>> 0;
    return this.g(off & ~3);
  }
  write(off, size, v) {
    if (off === 0x38) { this.regs.set(0x38, (this.g(0x38) & ~v) >>> 0); return; }
    if (off === 0x200) {
      if (this.wr) {
        let [o, n] = this.wr;
        for (let i = 0; i < size; i++) this.card.img[o + i] = (v >>> (8 * i)) & 0xFF;
        o += size; n -= size;
        this.wr = n <= 0 ? null : [o, n];
        if (!this.wr) this.regs.set(0x38, (this.g(0x38) | (1 << 3) | (1 << 14)) >>> 0);
      }
      return;
    }
    if (off === 0x80) v &= ~1;
    if (off === 0x88) { this.regs.set(0x88, (this.g(0x88) & ~v) >>> 0); return; }
    if (off === 0x00) { if (v & 2) this.fifo = []; v &= ~7; }
    this.regs.set(off & ~3, v >>> 0);
    if (off === 0x18 && (v & (1 << 31))) this.cmd(v);
  }
  cmd(v) {
    if (v & (1 << 21)) return;
    const idx = v & 0x3F, arg = this.g(0x1C);
    const { resp, long, data, xfer } = this.card.command(idx, arg);
    this.commands++;
    let rint = 1 << 2;
    if (resp !== null) {
      if (long) for (let i = 0; i < 4; i++) this.regs.set(0x20 + 4 * i, Number((resp >> BigInt(32 * i)) & 0xFFFFFFFFn));
      else if (v & (1 << 7)) for (let i = 0; i < 4; i++) this.regs.set(0x20 + 4 * i, Number(resp & 0xFFFFFFFFn));
      else this.regs.set(0x20, Number(resp & 0xFFFFFFFFn));
    }
    const n = this.regs.has(0x14) ? this.g(0x14) : 512;
    const dma = (this.g(0x00) & 0x20) && (this.g(0x80) & 0x80);
    if (dma && (data || xfer)) {
      if (data) this.dmaOut(data.subarray(0, n));
      else if (xfer[0] === 'read') this.dmaOut(this.card.img.subarray(xfer[1], xfer[1] + n));
      else this.card.img.set(this.dmaIn(n), xfer[1]);
      rint |= (1 << 3) | (1 << 14);
      this.regs.set(0x88, (this.g(0x88) | 3) >>> 0);
      this.regs.set(0x38, (this.g(0x38) | rint) >>> 0);
      return;
    }
    if (data) { for (const b of data.subarray(0, n)) this.fifo.push(b); rint |= (1 << 3) | (1 << 14); }
    else if (xfer) {
      const [kind, off] = xfer;
      if (kind === 'read') { for (const b of this.card.img.subarray(off, off + n)) this.fifo.push(b); rint |= (1 << 3) | (1 << 14); }
      else this.wr = [off, n];
    }
    this.regs.set(0x38, (this.g(0x38) | rint) >>> 0);
  }
  *descs() {
    let d = this.g(0x84);
    for (let k = 0; k < 4096; k++) {
      const des0 = this.m.r32(d), des1 = this.m.r32(d + 4), des2 = this.m.r32(d + 8), des3 = this.m.r32(d + 12);
      yield [des0, (des1 & 0xFFFF) || 0x10000, des2];
      this.m.w32(d, des0 & ~(1 << 31));
      if (des0 & (1 << 2)) return;
      d = (des0 & (1 << 4)) ? des3 : d + 16;
    }
  }
  dmaOut(data) {
    let pos = 0;
    for (const [, size, buf] of this.descs()) {
      const chunk = data.subarray(pos, pos + size);
      if (chunk.length) this.m.writeBytes(buf, chunk);
      pos += size;
      if (pos >= data.length) break;
    }
  }
  dmaIn(n) {
    const out = new Uint8Array(n); let got = 0;
    for (const [, size, buf] of this.descs()) {
      const k = Math.min(size, n - got);
      out.set(this.m.readBytes(buf, k), got); got += k;
      if (got >= n) break;
    }
    return out;
  }
}

export class Fpga {                              // FPGA on the PE parallel bus (docs/DRIVERS.md)
  constructor(board) { this.board = board; this.sel = null; this.idx = 0; this.writes = new Map(); this.reads = new Map(); this.out = 0; this.jobInput = 0; }
  command(v) { this.sel = v; this.idx = 0; }
  write(v) {
    const l = this.writes.get(this.sel) || []; l.push(v); if (l.length > 16) l.shift(); this.writes.set(this.sel, l);
    if (this.sel === 0x6B) this.jobInput = ((this.jobInput << 8) | v) >>> 0;
  }
  read() {
    const s = this.sel;
    this.reads.set(s, (this.reads.get(s) || 0) + 1);
    if (s === 0x01) { const v = [0xA5, 0xA5, 0x5A, 0x5A][this.idx % 4]; this.idx++; return v; }   // identity
    if (s === 0x02) return this.board.charging ? 1 : 0;                                            // charger status
    if (s === 0x0A) return 0x01;                                                                   // acquisition complete
    if (s === 0x60) return 0x01;                                                                   // security chip status
    if (s === 0x64 || s === 0x65) return 0x01;                                                     // job ready
    return 0x00;
  }
}

export class Gic {                               // GIC-400 subset
  static DIST = 0x01C81000; static CPU = 0x01C82000;
  constructor() { this.enabled = new Set(); this.pending = new Set(); this.active = []; this.counts = new Map(); }
  raise(n) { this.pending.add(n); }
  hasPending() { for (const n of this.pending) if (this.enabled.has(n)) return true; return false; }
  read(addr) {
    if (addr === Gic.CPU + 0x0C) {
      const ready = [...this.pending].filter((n) => this.enabled.has(n)).sort((a, b) => a - b);
      if (!ready.length) return 1023;
      const n = ready[0];
      this.pending.delete(n); this.active.push(n); this.counts.set(n, (this.counts.get(n) || 0) + 1);
      return n;
    }
    if (addr >= Gic.DIST + 0x100 && addr < Gic.DIST + 0x120) {
      const k = (addr - Gic.DIST - 0x100) >> 2; let v = 0;
      for (let b = 0; b < 32; b++) if (this.enabled.has(32 * k + b)) v |= 1 << b;
      return v >>> 0;
    }
    return undefined;
  }
  write(addr, v) {
    if (addr >= Gic.DIST + 0x100 && addr < Gic.DIST + 0x120) { const k = (addr - Gic.DIST - 0x100) >> 2; for (let b = 0; b < 32; b++) if ((v >>> b) & 1) this.enabled.add(32 * k + b); return true; }
    if (addr >= Gic.DIST + 0x180 && addr < Gic.DIST + 0x1A0) { const k = (addr - Gic.DIST - 0x180) >> 2; for (let b = 0; b < 32; b++) if ((v >>> b) & 1) this.enabled.delete(32 * k + b); return true; }
    if (addr === Gic.CPU + 0x10) { const i = this.active.indexOf(v & 0x3FF); if (i >= 0) this.active.splice(i, 1); return true; }
    return false;
  }
}

export class Timers {                            // timer 0/1: 24 MHz down-counters -> IRQ 50/51
  constructor(m, gic) { this.m = m; this.gic = gic; this.acc = [0, 0]; }
  advance(ticks) {
    const en = this.m.r32(TMR);
    for (let n = 0; n < 2; n++) {
      const ctrl = this.m.r32(TMR + 0x10 + 16 * n);
      const intv = (this.m.r32(TMR + 0x14 + 16 * n) >>> 0) || 1;
      if (!(ctrl & 1)) continue;
      this.acc[n] += ticks;
      if (this.acc[n] >= intv) {
        this.acc[n] %= intv;
        this.m.w32(TMR + 4, this.m.r32(TMR + 4) | (1 << n));
        if ((en >>> n) & 1) this.gic.raise(50 + n);
      }
    }
  }
}

export class Csi {                               // CSI0: FPGA sample stream -> 8 slots x 6144 samples
  static BASE = 0x01CB4000; static IRQ = 0x74;
  constructor(m, gic, signal) { this.m = m; this.gic = gic; this.signal = signal; this.status = 0; this.frames = 0; this.armed = 0; }
  read(off) { return off === 0x74 ? this.status : undefined; }
  write(off, v) {
    if (off === 0x74) { this.status &= ~v; return true; }
    if (off === 0x08 && (v & 3)) this.armed = 20000;
    return false;
  }
  advance(insns) {
    if (this.armed <= 0) return;
    this.armed -= insns;
    if (this.armed > 0) return;
    const buf = (this.m.r32(Csi.BASE + 0x50) << 2) >>> 0;
    if (buf >= 0x40000000 && buf < 0x44000000) for (let slot = 0; slot < 8; slot++) this.m.writeBytes(buf + slot * 0x2134, this.signal.samples(slot, this.frames));
    this.frames++;
    this.status |= 2;
    this.gic.raise(Csi.IRQ);
  }
}

export class FrontEnd {
  // Virtual analog front end + probes. It produces the ADC codes that the firmware's calibrated
  // conversion (calibration.js) turns into the wanted screen position:
  //   position_px = offset_px + volts_at_input / (V/div) * px_per_div
  // using the live per-lane coefficients, the V/div gain table and the conversion parameters, so the
  // trace and the measurements follow the firmware's own settings. ASSUMPTIONS: the V/div table
  // below, 8 vertical divisions, all lanes sampling the same instant.
  static SYS = 0x40544E68;
  static VDIV = [20, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01, 0.005, 0.002];   // DERIVED: index 6 shows 200mV, 5 shows 500mV
  constructor(m) {
    this.m = m;
    this.SAMPLE_RATE = 250e6;                    // total sample rate, all 8 interleaved lanes (ASSUMPTION: the 250 MS/s shown at 20 us/div)
    this.LANES = 8;
    this.ch = [
      { on: true, wave: 'sine', freq: 1000, vpp: 2, offset: 0, probe: 1, source: 'gen' },
      { on: true, wave: 'square', freq: 500, vpp: 1, offset: 0, probe: 1, source: 'gen' },
    ];
    this.audio = new Float32Array(0);
    this.audioVolts = 1.0;
    this.audioRate = 48000;                      // samples per second of the pushed audio (set by the page)
    this.halfSpan = 0;
    this.out = new Uint8Array(6144);
    this.seed = 1;
  }
  u(off, n) { const a = FrontEnd.SYS + off; return n === 1 ? this.m.r8(a) : n === 2 ? this.m.r16(a) : this.m.r32(a) | 0; }
  pushAudio(samples) {
    const keep = 1 << 16;
    const a = new Float32Array(Math.min(keep, this.audio.length + samples.length));
    const old = this.audio.subarray(Math.max(0, this.audio.length - (a.length - samples.length)));
    a.set(old, 0); a.set(samples.subarray(Math.max(0, samples.length - a.length)), old.length);
    this.audio = a;
  }
  // volts at the probe tip for sample i of this frame
  // t: seconds from the trigger point
  volts(p, t, j) {
    if (!p.on) return 0;
    if (p.source === 'audio' && this.audio.length) { const k = this.audio.length - 1 - Math.round((this.halfSpan - t) * this.audioRate); return (k >= 0 && k < this.audio.length ? this.audio[k] : 0) * this.audioVolts; }
    const ph = (((t * p.freq) % 1) + 1) % 1;
    let s;
    switch (p.wave) {
      case 'square': s = ph < 0.5 ? 1 : -1; break;
      case 'triangle': s = 4 * Math.abs(ph - 0.5) - 1; break;
      case 'saw': s = 2 * ph - 1; break;
      case 'dc': s = 1; break;
      case 'noise': this.seed = (Math.imul(this.seed, 1103515245) + 12345) >>> 0; s = (this.seed / 2147483648) - 1; break;
      default: s = Math.sin(2 * Math.PI * ph);
    }
    return s * p.vpp / 2 + p.offset;
  }
  samples(slot, frame, n = 6144) {
    const on = [this.u(0x3E, 1) !== 0, this.u(0x102, 1) !== 0];
    const c = ((on[0] && on[1] && slot >= 4) || (on[1] && !on[0])) ? 1 : 0;
    const p = this.ch[c];
    const out = this.out;
    const vidx = this.u(c ? 0x105 : 0x41, 1);
    const gain = this.u((c ? 0x214 : 0x1C4) + 4 * vidx, 4);
    const A = this.m.r32(CAL_OBJECT + 0x10 + 4 * slot) | 0, B = this.m.r32(CAL_OBJECT + 0x30 + 4 * slot) | 0;
    const ip = Math.trunc(Math.imul(gain, A) / 1000);
    const unit = this.u(0x1C0, 4) || 64, shift = this.u(0x264, 4) & 31, base = this.u(0x1B8, 1);
    const offPx = this.u(c ? 0x120 : 0x60, 4);
    const pxPerDiv = (this.u(0x0A, 2) || 503) / 8;
    const vdiv = FrontEnd.VDIV[vidx] || 1;
    const d44 = this.u(0x44, 2);
    const k = pxPerDiv / vdiv / Math.max(1, p.probe);
    // The 8 lanes are interleaved ADC phases: byte i of lane L is sample 8*i + L. The FPGA triggers
    // the capture: the rising crossing of the generator's mean level sits at the middle of the
    // frame (ASSUMPTION: 50 % pre-trigger, generator phase 0 = trigger).
    const dt = 1 / this.SAMPLE_RATE, mid = (n * this.LANES) / 2;
    this.halfSpan = mid * dt;
    const phase0 = p.wave === 'sine' ? 0 : p.wave === 'saw' ? 0.5 : p.wave === 'triangle' ? 0.75 : 0;
    for (let i = 0; i < n; i++) {
      let code;
      const idx = i * this.LANES + slot;
      const t = (idx - mid) * dt + phase0 / Math.max(p.freq, 1e-9);
      if (d44 >= 3000) code = Math.floor((d44 - 3000) * 256 / 7000);          // POST ADC test: the swept DAC drives the codes
      else if (ip > 0) {
        const px = offPx + this.volts(p, t, n * this.LANES - idx) * k;
        code = base + (px * unit * Math.pow(2, shift) - B) / ip;
      } else code = 128 + this.volts(p, t, n * this.LANES - idx) * k / 2.5;      // no usable calibration
      code = Math.round(code);
      out[i] = code < 0 ? 0 : code > 255 ? 255 : code;
    }
    return out.subarray(0, n);
  }
}

export class Gt911 {                             // Goodix GT911 touch, register level (fast-path hooks)
  constructor() {
    this.regs = new Uint8Array(0x10000);
    this.regs.set([0x39, 0x31, 0x31, 0], 0x8140);
    this.regs.set([0x00, 0x04, 0x58, 0x02], 0x8146);
    this.down = false; this.x = 0; this.y = 0; this.releasePending = false; this.track = 0;
    this.reads = 0; this.downReads = 0; this.releaseWanted = false;
  }
  event(kind, x, y) {
    if (kind === 'down' || kind === 'move') {
      if (kind === 'down') { this.track = (this.track + 1) & 0x0F; this.downReads = 0; }
      this.down = true; this.x = Math.max(0, x | 0); this.y = Math.max(0, y | 0);
      this.releaseWanted = false;
    } else {
      this.releaseWanted = true;                 // keep a quick click until the firmware has read it twice
      if (this.downReads >= 2) { this.down = false; this.releasePending = true; }
    }
  }
  refresh() {
    if (this.down && this.releaseWanted && this.downReads >= 2) { this.down = false; this.releasePending = true; }
    if (this.down) {
      this.downReads++;
      const r = this.regs;
      r[0x814E] = 0x81; r[0x814F] = this.track;
      r[0x8150] = this.x & 0xFF; r[0x8151] = this.x >> 8; r[0x8152] = this.y & 0xFF; r[0x8153] = this.y >> 8;
      r[0x8154] = 30; r[0x8155] = 0;
    } else if (this.releasePending) { this.regs[0x814E] = 0x80; this.releasePending = false; }
  }
  read(reg, n) {
    this.reads++;
    if (reg <= 0x814E && 0x814E < reg + n) this.refresh();
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = this.regs[(reg + i) & 0xFFFF];
    return out;
  }
  write(reg, data) { for (let i = 0; i < data.length; i++) this.regs[(reg + i) & 0xFFFF] = data[i]; }
}
