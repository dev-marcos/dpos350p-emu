// ARMv7-A interpreter (Cortex-A7 subset used by the DPOS350P firmware): ARM state, the Thumb-2
// instructions of the compiler's math library, VFPv3 (scalar), CP15 registers. Memory is flat
// (the firmware's MMU tables map every address to itself) and reached through `bus`.
//
// Each instruction word is decoded once into a closure and cached per address; stores into the
// code area drop the cached decodes. r[15] holds the architectural PC value (address + 8 in ARM,
// + 4 in Thumb) while an instruction runs, so decoders read PC like any register.

const DRAM = 0x40000000;
const CODE_LIMIT = 0x00200000;          // decode cache covers the first 2 MiB of DRAM
const LOW_LIMIT = 0x00010000;           // and the low 64 KiB (exception vectors copied to 0)

const MODE = { usr: 0x10, fiq: 0x11, irq: 0x12, svc: 0x13, abt: 0x17, und: 0x1B, sys: 0x1F };

function bankOf(mode) {
  switch (mode) {
    case 0x11: return 1; case 0x12: return 2; case 0x13: return 3; case 0x17: return 4; case 0x1B: return 5;
    default: return 0;                  // usr / sys
  }
}

function ror(v, n) { n &= 31; return n ? ((v >>> n) | (v << (32 - n))) : v; }
function sext(v, bits) { const s = 32 - bits; return (v << s) >> s; }

export class Fault extends Error {}

export class Cpu {
  constructor(bus) {
    this.bus = bus;
    this.dram = bus.dram;                                   // Uint8Array
    this.d32 = new Int32Array(this.dram.buffer, this.dram.byteOffset, this.dram.length >> 2);
    this.d16 = new Uint16Array(this.dram.buffer, this.dram.byteOffset, this.dram.length >> 1);
    this.dramSize = this.dram.length;
    this.r = new Int32Array(16);
    this.N = 0; this.Z = 0; this.C = 0; this.V = 0; this.Q = 0; this.GE = 0;
    this.I = 1; this.F = 1; this.A = 1; this.T = 0; this.E = 0;
    this.mode = MODE.svc;
    this.it = 0;
    // banked r13/r14/SPSR per bank (0 usr/sys, 1 fiq, 2 irq, 3 svc, 4 abt, 5 und), FIQ r8-r12
    this.bankR13 = new Int32Array(6); this.bankR14 = new Int32Array(6); this.spsrs = new Int32Array(6);
    this.fiqR = new Int32Array(5); this.usrR = new Int32Array(5);
    this.pc = 0; this.npc = 0;
    // VFP
    this.vbuf = new ArrayBuffer(256);
    this.f64 = new Float64Array(this.vbuf); this.f32 = new Float32Array(this.vbuf); this.v32 = new Int32Array(this.vbuf);
    this.fpscr = 0; this.fpexc = 0;
    this.cp15 = new Map();
    this.acache = new Array((CODE_LIMIT >> 2)).fill(undefined);
    this.tcache = new Array((CODE_LIMIT >> 1)).fill(undefined);
    this.lacache = new Array((LOW_LIMIT >> 2)).fill(undefined);
    this.ltcache = new Array((LOW_LIMIT >> 1)).fill(undefined);
    this.hooks = new Map();                                 // address -> function(cpu) (runs instead of the instruction)
    this.prehooks = new Map();                              // address -> function(cpu) (runs before the instruction)
    this.insns = 0;
    this.exclusive = false;
  }

  // ------------------------------------------------------------------ CPSR / modes
  get cpsr() {
    return ((this.N << 31) | (this.Z << 30) | (this.C << 29) | (this.V << 28) | (this.Q << 27) |
      ((this.it & 3) << 25) | (this.GE << 16) | (((this.it >> 2) & 0x3F) << 10) | (this.E << 9) |
      (this.A << 8) | (this.I << 7) | (this.F << 6) | (this.T << 5) | this.mode) >>> 0;
  }
  set cpsr(v) { this.setCpsr(v, 0xF); }

  setCpsr(v, mask) {                 // mask bits: 8 flags, 4 status, 2 extension, 1 control
    if (mask & 8) {
      this.N = (v >>> 31) & 1; this.Z = (v >>> 30) & 1; this.C = (v >>> 29) & 1; this.V = (v >>> 28) & 1; this.Q = (v >>> 27) & 1;
      this.it = (this.it & ~3) | ((v >>> 25) & 3);
    }
    if (mask & 4) { this.GE = (v >>> 16) & 0xF; }
    if (mask & 2) { this.E = (v >>> 9) & 1; this.A = (v >>> 8) & 1; }
    if (mask & 1) {
      this.I = (v >>> 7) & 1; this.F = (v >>> 6) & 1; this.T = (v >>> 5) & 1;
      this.it = (this.it & 3) | (((v >>> 10) & 0x3F) << 2);
      this.switchMode(v & 0x1F);
    }
    if (mask & 8 && mask & 1) { /* full write already done */ }
  }

  switchMode(m) {
    const old = this.mode;
    if (old === m) return;
    const ob = bankOf(old), nb = bankOf(m);
    if (ob !== nb) {
      this.bankR13[ob] = this.r[13]; this.bankR14[ob] = this.r[14];
      if (old === MODE.fiq) { for (let i = 0; i < 5; i++) { this.fiqR[i] = this.r[8 + i]; this.r[8 + i] = this.usrR[i]; } }
      if (m === MODE.fiq) { for (let i = 0; i < 5; i++) { this.usrR[i] = this.r[8 + i]; this.r[8 + i] = this.fiqR[i]; } }
      this.r[13] = this.bankR13[nb]; this.r[14] = this.bankR14[nb];
    }
    this.mode = m;
  }

  get spsr() { const b = bankOf(this.mode); return b ? this.spsrs[b] >>> 0 : this.cpsr; }
  set spsr(v) { const b = bankOf(this.mode); if (b) this.spsrs[b] = v; }

  // Register of another mode (debug / snapshots)
  // ------------------------------------------------------------------ exceptions
  irq() {                                         // IRQ entry, low vectors unless SCTLR.V
    const ret = this.pc;
    const cpsr = this.cpsr;
    this.switchMode(MODE.irq);
    this.spsrs[2] = cpsr;
    this.r[14] = (ret + 4) | 0;
    this.I = 1; this.T = 0; this.it = 0;
    this.pc = this.vectorBase() + 0x18;
  }

  vectorBase() { return (this.cp15get(1, 0, 0, 0) & 0x2000) ? 0xFFFF0000 : (this.cp15get(12, 0, 0, 0) & ~0x1F) >>> 0; }

  cp15get(crn, op1, crm, op2) {
    const k = (crn << 12) | (op1 << 8) | (crm << 4) | op2;
    const v = this.cp15.get(k);
    if (v !== undefined) return v;
    switch (k) {
      case 0x0000: return 0x410FC075;            // MIDR: Cortex-A7 r0p5
      case 0x0005: return 0x80000F00;            // MPIDR
      case 0x0100: { const sel = this.cp15.get(0x0200) || 0; return [0x701FE00A, 0x201FE00A, 0x703FE07A][sel >> 1 & 3] || 0; } // CCSIDR (by CSSELR)
      case 0x0101: return 0x0A200023;            // CLIDR
      case 0x1000: return 0x00C50078;            // SCTLR reset value
    }
    return 0;
  }

  // ------------------------------------------------------------------ memory
  ld32(a) {
    const o = (a - DRAM) >>> 0;
    if (o < this.dramSize && !(a & 3)) return this.d32[o >> 2];
    if (o < this.dramSize - 3) { const d = this.dram; return d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24); }
    return this.bus.read(a >>> 0, 4) | 0;
  }
  ld16(a) {
    const o = (a - DRAM) >>> 0;
    if (o < this.dramSize && !(a & 1)) return this.d16[o >> 1];
    if (o < this.dramSize - 1) return this.dram[o] | (this.dram[o + 1] << 8);
    return this.bus.read(a >>> 0, 2) & 0xFFFF;
  }
  ld8(a) {
    const o = (a - DRAM) >>> 0;
    if (o < this.dramSize) return this.dram[o];
    return this.bus.read(a >>> 0, 1) & 0xFF;
  }
  st32(a, v) {
    const o = (a - DRAM) >>> 0;
    if (o < this.dramSize && !(a & 3)) {
      this.d32[o >> 2] = v;
      if (o < CODE_LIMIT) { this.acache[o >> 2] = undefined; this.tcache[o >> 1] = undefined; this.tcache[(o >> 1) + 1] = undefined; }
      return;
    }
    this.stSlow(a >>> 0, 4, v);
  }
  st16(a, v) {
    const o = (a - DRAM) >>> 0;
    if (o < this.dramSize && !(a & 1)) {
      this.d16[o >> 1] = v;
      if (o < CODE_LIMIT) { this.acache[o >> 2] = undefined; this.tcache[o >> 1] = undefined; }
      return;
    }
    this.stSlow(a >>> 0, 2, v & 0xFFFF);
  }
  st8(a, v) {
    const o = (a - DRAM) >>> 0;
    if (o < this.dramSize) {
      this.dram[o] = v;
      if (o < CODE_LIMIT) { this.acache[o >> 2] = undefined; this.tcache[o >> 1] = undefined; }
      return;
    }
    this.stSlow(a >>> 0, 1, v & 0xFF);
  }
  stSlow(a, size, v) {
    if (a < LOW_LIMIT) { this.lacache[a >> 2] = undefined; this.ltcache[a >> 1] = undefined; if (size === 4) { this.ltcache[(a >> 1) + 1] = undefined; } }
    const o = (a - DRAM) >>> 0;
    if (o < this.dramSize) {            // unaligned DRAM store
      for (let i = 0; i < size; i++) this.st8(a + i, v >>> (8 * i));
      return;
    }
    this.bus.write(a, size, size === 4 ? v >>> 0 : v);
  }
  // invalidate decodes after a bulk write (DMA, loader)
  invalidate(a, n) {
    const o = (a - DRAM) >>> 0;
    if (o < CODE_LIMIT) { const e = Math.min(CODE_LIMIT, o + n); for (let x = o & ~3; x < e; x += 2) { this.acache[x >> 2] = undefined; this.tcache[x >> 1] = undefined; } }
    if (a < LOW_LIMIT) { const e = Math.min(LOW_LIMIT, a + n); for (let x = a & ~3; x < e; x += 2) { this.lacache[x >> 2] = undefined; this.ltcache[x >> 1] = undefined; } }
  }
  flushDecodes() { this.acache.fill(undefined); this.tcache.fill(undefined); this.lacache.fill(undefined); this.ltcache.fill(undefined); }

  // ------------------------------------------------------------------ PC writes
  bxWrite(v) {                         // interworking branch
    if (v & 1) { this.T = 1; this.npc = (v & ~1) >>> 0; } else { this.T = 0; this.npc = (v & ~3) >>> 0; }
  }
  branchWrite(v) { this.npc = (this.T ? (v & ~1) : (v & ~3)) >>> 0; }
  excReturn(v) {                       // SUBS pc, lr / LDM {..pc}^ : CPSR = SPSR, then branch
    this.setCpsr(this.spsr, 0xF);
    this.npc = (this.T ? (v & ~1) : (v & ~3)) >>> 0;
  }

  cond(c) {
    switch (c) {
      case 0: return this.Z; case 1: return !this.Z; case 2: return this.C; case 3: return !this.C;
      case 4: return this.N; case 5: return !this.N; case 6: return this.V; case 7: return !this.V;
      case 8: return this.C && !this.Z; case 9: return !this.C || this.Z;
      case 10: return this.N === this.V; case 11: return this.N !== this.V;
      case 12: return !this.Z && this.N === this.V; case 13: return this.Z || this.N !== this.V;
      default: return true;
    }
  }

  // ------------------------------------------------------------------ run loop
  // Runs up to n instructions. Returns the number executed (fewer if `stop` was set).
  run(n) {
    const r = this.r;
    let i = 0;
    this.stop = false;
    while (i < n) {
      const pc = this.pc;
      if (this.T) {
        let f;
        const o = (pc - DRAM) >>> 0;
        if (o < CODE_LIMIT) { f = this.tcache[o >> 1]; if (f === undefined) f = this.tcache[o >> 1] = this.decodeT(pc); }
        else if (pc < LOW_LIMIT) { f = this.ltcache[pc >> 1]; if (f === undefined) f = this.ltcache[pc >> 1] = this.decodeT(pc); }
        else f = this.decodeT(pc);
        r[15] = pc + 4;
        this.npc = (pc + f.len) >>> 0;
        if (this.it) {
          const c = this.it >> 4;
          const adv = (this.it & 7) ? ((this.it & 0xE0) | ((this.it << 1) & 0x1F)) : 0;
          if (f.isIT || this.cond(c)) { this.it = adv; f(this); } else this.it = adv;
        } else f(this);
      } else {
        let f;
        const o = (pc - DRAM) >>> 0;
        if (o < CODE_LIMIT) { f = this.acache[o >> 2]; if (f === undefined) f = this.acache[o >> 2] = this.decodeA(pc); }
        else if (pc < LOW_LIMIT) { f = this.lacache[pc >> 2]; if (f === undefined) f = this.lacache[pc >> 2] = this.decodeA(pc); }
        else f = this.decodeA(pc);
        r[15] = pc + 8;
        this.npc = (pc + 4) >>> 0;
        f(this);
      }
      this.pc = this.npc;
      i++;
      if (this.stop) break;
    }
    this.insns += i;
    return i;
  }

  fetch32(a) {
    const o = (a - DRAM) >>> 0;
    if (o < this.dramSize) return this.d32[o >> 2] >>> 0;
    return this.bus.read(a, 4) >>> 0;
  }
  fetch16(a) { return this.ld16(a); }

  // ================================================================== ARM decoder
  decodeA(pc) {
    const hook = this.hooks.get(pc);
    if (hook) return hook;
    const w = this.fetch32(pc);
    const cond = w >>> 28;
    let f;
    if (cond === 0xF) f = this.decodeUncond(w, pc);
    else {
      f = this.decodeA2(w, pc);
      if (cond !== 0xE) {
        const g = f;
        f = (c) => { if (c.cond(cond)) g(c); };
      }
    }
    const pre = this.prehooks.get(pc);
    if (pre) { const g = f; f = (c) => { pre(c); g(c); }; }
    return f;
  }

  undef(w, pc, thumb) {
    const msg = `undefined/unsupported ${thumb ? 'Thumb' : 'ARM'} instruction 0x${(w >>> 0).toString(16).padStart(8, '0')} at 0x${(pc >>> 0).toString(16)}`;
    return () => { throw new Fault(msg); };
  }

  decodeUncond(w, pc) {
    if ((w & 0x0E000000) === 0x0A000000) {       // BLX imm
      const h = (w >>> 24) & 1;
      const target = (pc + 8 + (sext(w & 0xFFFFFF, 24) << 2) + (h << 1)) >>> 0;
      return (c) => { c.r[14] = pc + 4; c.T = 1; c.npc = target; };
    }
    const hi = (w & 0xFFFFFFF0) >>> 0;
    if (hi === 0xF57FF040 || hi === 0xF57FF050 || hi === 0xF57FF060 || w === 0xF57FF01F) return () => {}; // DSB/DMB/ISB/CLREX
    if ((w & 0x0D70F000) === 0x0550F000 || (w & 0x0D70F000) === 0x0510F000) return () => {}; // PLD/PLDW
    if ((w & 0x0FF10020) === 0x01000000) {       // CPS
      const imod = (w >>> 18) & 3, M = (w >>> 17) & 1, a = (w >>> 8) & 1, i = (w >>> 7) & 1, fq = (w >>> 6) & 1, mode = w & 0x1F;
      return (c) => { if (imod & 2) { const v = imod === 3 ? 1 : 0; if (a) c.A = v; if (i) c.I = v; if (fq) c.F = v; } if (M) c.switchMode(mode); };
    }
    return this.undef(w, pc);
  }

  // operand 2 as a value closure (and carry into c.sc when wantCarry)
  op2(w, wantCarry) {
    if (w & 0x02000000) {                        // immediate
      const rot = ((w >>> 8) & 0xF) * 2, imm = ror(w & 0xFF, rot) | 0;
      if (wantCarry) { if (rot) { const car = imm >>> 31; return (c) => { c.sc = car; return imm; }; } return (c) => { c.sc = c.C; return imm; }; }
      return () => imm;
    }
    const rm = w & 0xF, type = (w >>> 5) & 3;
    if (!(w & 0x10)) {                           // shift by immediate
      const n = (w >>> 7) & 0x1F;
      if (!wantCarry) {
        switch (type) {
          case 0: return n ? (c) => c.r[rm] << n : (c) => c.r[rm];
          case 1: return n ? (c) => (c.r[rm] >>> n) | 0 : () => 0;
          case 2: return n ? (c) => c.r[rm] >> n : (c) => c.r[rm] >> 31;
          case 3: return n ? (c) => ror(c.r[rm], n) | 0 : (c) => ((c.C << 31) | (c.r[rm] >>> 1));
        }
      }
      switch (type) {
        case 0: return n ? (c) => { const v = c.r[rm]; c.sc = (v >>> (32 - n)) & 1; return v << n; } : (c) => { c.sc = c.C; return c.r[rm]; };
        case 1: return n ? (c) => { const v = c.r[rm]; c.sc = (v >>> (n - 1)) & 1; return (v >>> n) | 0; } : (c) => { c.sc = c.r[rm] >>> 31; return 0; };
        case 2: return n ? (c) => { const v = c.r[rm]; c.sc = (v >>> (n - 1)) & 1; return v >> n; } : (c) => { const v = c.r[rm]; c.sc = v >>> 31; return v >> 31; };
        case 3: return n ? (c) => { const v = c.r[rm]; c.sc = (v >>> (n - 1)) & 1; return ror(v, n) | 0; } : (c) => { const v = c.r[rm]; const r = (c.C << 31) | (v >>> 1); c.sc = v & 1; return r; };
      }
    }
    const rs = (w >>> 8) & 0xF;                  // shift by register
    return (c) => {
      const v = c.r[rm], n = c.r[rs] & 0xFF;
      let r, car = c.C;
      switch (type) {
        case 0: if (n === 0) r = v; else if (n < 32) { car = (v >>> (32 - n)) & 1; r = v << n; } else if (n === 32) { car = v & 1; r = 0; } else { car = 0; r = 0; } break;
        case 1: if (n === 0) r = v; else if (n < 32) { car = (v >>> (n - 1)) & 1; r = (v >>> n) | 0; } else if (n === 32) { car = v >>> 31; r = 0; } else { car = 0; r = 0; } break;
        case 2: if (n === 0) r = v; else if (n < 32) { car = (v >>> (n - 1)) & 1; r = v >> n; } else { car = v >>> 31; r = v >> 31; } break;
        default: if (n === 0) r = v; else if ((n & 31) === 0) { car = v >>> 31; r = v; } else { car = (v >>> ((n & 31) - 1)) & 1; r = ror(v, n) | 0; }
      }
      c.sc = car;
      return r;
    };
  }

  decodeA2(w, pc) {
    const op1 = (w >>> 25) & 7;
    switch (op1) {
      case 0:
        if ((w & 0x90) === 0x90) {
          if ((w & 0x60) === 0) return (w & 0x01000000) ? this.decSync(w, pc) : this.decMul(w, pc);
          return this.decExtraLS(w, pc);
        }
        if ((w & 0x01900000) === 0x01000000) return this.decMisc(w, pc);
        return this.decDP(w, pc);
      case 1:
        if ((w & 0x01900000) === 0x01000000) {
          const op = (w >>> 20) & 0x1F;
          if (op === 0x10) { const rd = (w >>> 12) & 0xF, imm = ((w >>> 4) & 0xF000) | (w & 0xFFF); return (c) => { c.r[rd] = imm; }; }
          if (op === 0x14) { const rd = (w >>> 12) & 0xF, imm = ((w >>> 4) & 0xF000) | (w & 0xFFF); return (c) => { c.r[rd] = (c.r[rd] & 0xFFFF) | (imm << 16); }; }
          if ((op & 0x1B) === 0x12) return this.decMSR(w, pc, ror(w & 0xFF, ((w >>> 8) & 0xF) * 2) | 0, -1);
          return this.undef(w, pc);
        }
        return this.decDP(w, pc);
      case 2: return this.decLS(w, pc);
      case 3: return (w & 0x10) ? this.decMedia(w, pc) : this.decLS(w, pc);
      case 4: return this.decLSM(w, pc);
      case 5: {
        const target = (pc + 8 + (sext(w & 0xFFFFFF, 24) << 2)) >>> 0;
        if (w & 0x01000000) return (c) => { c.r[14] = pc + 4; c.npc = target; };
        return (c) => { c.npc = target; };
      }
      case 6: return this.decVfpLS(w, pc);
      case 7:
        if (w & 0x01000000) return this.undef(w, pc);           // SVC: not used by the firmware
        return this.decCopro(w, pc);
    }
    return this.undef(w, pc);
  }

  // ---------------------------------------------------------------- data processing
  decDP(w, pc) {
    const opc = (w >>> 21) & 0xF, S = (w >>> 20) & 1, rn = (w >>> 16) & 0xF, rd = (w >>> 12) & 0xF;
    const logical = [0, 1, 8, 9, 12, 13, 14, 15].includes(opc);
    const b = this.op2(w, S && logical && rd !== 15);
    return this.makeDP(opc, S, rn, rd, b, false);
  }

  // shared by ARM and Thumb-2; thumbNoPCSemantics: Thumb writes to PC use branchWrite
  makeDP(opc, S, rn, rd, b, thumb) {
    const toPC = rd === 15 && !(S && (opc >= 8 && opc <= 11));
    const fin = !toPC ? null : (S && !thumb) ? (c, v) => c.excReturn(v) : thumb ? (c, v) => c.branchWrite(v) : (c, v) => c.bxWrite(v);
    const setS = S && !toPC;
    const r = this.r;
    switch (opc) {
      case 0: case 1: case 12: case 14: case 15: case 13: {   // AND EOR ORR BIC MVN MOV
        const fn = opc === 0 ? (a, x) => a & x : opc === 1 ? (a, x) => a ^ x : opc === 12 ? (a, x) => a | x : opc === 14 ? (a, x) => a & ~x : opc === 15 ? (a, x) => ~x : (a, x) => x;
        if (opc === 13 && !setS && !fin) return (c) => { r[rd] = b(c); };
        if (fin) return (c) => fin(c, fn(r[rn], b(c)));
        if (setS) return (c) => { const v = fn(r[rn], b(c)); r[rd] = v; c.N = v >>> 31; c.Z = v === 0 ? 1 : 0; c.C = c.sc; };
        return (c) => { r[rd] = fn(r[rn], b(c)); };
      }
      case 8: case 9: {                                     // TST TEQ
        const fn = opc === 8 ? (a, x) => a & x : (a, x) => a ^ x;
        return (c) => { const v = fn(r[rn], b(c)); c.N = v >>> 31; c.Z = v === 0 ? 1 : 0; c.C = c.sc; };
      }
      case 4: case 11:                                      // ADD CMN
        if (opc === 4 && !setS) { if (fin) return (c) => fin(c, (r[rn] + b(c)) | 0); return (c) => { r[rd] = (r[rn] + b(c)) | 0; }; }
        return (c) => { const v = c.addc(r[rn], b(c), 0); if (opc === 4) r[rd] = v; };
      case 2: case 10:                                      // SUB CMP
        if (opc === 2 && !setS) { if (fin) return (c) => fin(c, (r[rn] - b(c)) | 0); return (c) => { r[rd] = (r[rn] - b(c)) | 0; }; }
        if (opc === 2 && fin) return (c) => fin(c, (r[rn] - b(c)) | 0);
        return (c) => { const v = c.addc(r[rn], ~b(c), 1); if (opc === 2) r[rd] = v; };
      case 3:                                               // RSB
        if (!setS) { if (fin) return (c) => fin(c, (b(c) - r[rn]) | 0); return (c) => { r[rd] = (b(c) - r[rn]) | 0; }; }
        return (c) => { r[rd] = c.addc(b(c), ~r[rn], 1); };
      case 5:                                               // ADC
        if (!setS) { if (fin) return (c) => fin(c, (r[rn] + b(c) + c.C) | 0); return (c) => { r[rd] = (r[rn] + b(c) + c.C) | 0; }; }
        return (c) => { r[rd] = c.addc(r[rn], b(c), c.C); };
      case 6:                                               // SBC
        if (!setS) { if (fin) return (c) => fin(c, (r[rn] + ~b(c) + c.C) | 0); return (c) => { r[rd] = (r[rn] + ~b(c) + c.C) | 0; }; }
        return (c) => { r[rd] = c.addc(r[rn], ~b(c), c.C); };
      case 7:                                               // RSC
        if (!setS) return (c) => { r[rd] = (b(c) + ~r[rn] + c.C) | 0; };
        return (c) => { r[rd] = c.addc(b(c), ~r[rn], c.C); };
    }
  }

  addc(a, b, cin) {                     // a + b + cin with NZCV
    const res = ((a >>> 0) + (b >>> 0) + cin);
    const v = res | 0;
    this.C = res > 0xFFFFFFFF ? 1 : 0;
    this.V = (((a ^ v) & (b ^ v)) >>> 31);
    this.N = v >>> 31; this.Z = v === 0 ? 1 : 0;
    return v;
  }

  // ---------------------------------------------------------------- multiply
  static mulu64(a, b) {                 // unsigned 32x32 -> [lo, hi] as uint32
    a >>>= 0; b >>>= 0;
    const al = a & 0xFFFF, ah = a >>> 16, bl = b & 0xFFFF, bh = b >>> 16;
    const ll = al * bl, lh = al * bh, hl = ah * bl, hh = ah * bh;
    const mid = (ll >>> 16) + (lh & 0xFFFF) + (hl & 0xFFFF);
    const lo = ((mid & 0xFFFF) << 16 | (ll & 0xFFFF)) >>> 0;
    const hi = (hh + (lh >>> 16) + (hl >>> 16) + (mid >>> 16)) >>> 0;
    return [lo, hi];
  }
  static muls64(a, b) {
    let [lo, hi] = Cpu.mulu64(a, b);
    if (a < 0) hi = (hi - (b >>> 0)) >>> 0;
    if (b < 0) hi = (hi - (a >>> 0)) >>> 0;
    return [lo, hi];
  }
  static add64(lo, hi, alo, ahi) {
    const l = (lo >>> 0) + (alo >>> 0);
    const h = ((hi >>> 0) + (ahi >>> 0) + (l > 0xFFFFFFFF ? 1 : 0)) >>> 0;
    return [l >>> 0, h];
  }

  decMul(w, pc) {
    const op = (w >>> 21) & 7, S = (w >>> 20) & 1, rdh = (w >>> 16) & 0xF, rdl = (w >>> 12) & 0xF, rs = (w >>> 8) & 0xF, rm = w & 0xF;
    return this.makeMul(op, S, rdh, rdl, rs, rm, w, pc);
  }
  makeMul(op, S, rd, ra, rs, rm, w, pc) {          // ARM field naming: rd = bits 19:16, ra/rdlo = 15:12
    const r = this.r;
    const nz = (c, v) => { c.N = v >>> 31; c.Z = v === 0 ? 1 : 0; };
    switch (op) {
      case 0: return S ? (c) => { const v = Math.imul(r[rm], r[rs]); r[rd] = v; nz(c, v); } : (c) => { r[rd] = Math.imul(r[rm], r[rs]); };
      case 1: return S ? (c) => { const v = (Math.imul(r[rm], r[rs]) + r[ra]) | 0; r[rd] = v; nz(c, v); } : (c) => { r[rd] = (Math.imul(r[rm], r[rs]) + r[ra]) | 0; };
      case 3: return (c) => { r[rd] = (r[ra] - Math.imul(r[rm], r[rs])) | 0; };
      case 2: return (c) => { let [lo, hi] = Cpu.mulu64(r[rm], r[rs]); [lo, hi] = Cpu.add64(lo, hi, r[ra], 0); [lo, hi] = Cpu.add64(lo, hi, r[rd], 0); r[ra] = lo; r[rd] = hi; };
      case 4: case 5: case 6: case 7: {
        const signed = op >= 6, acc = op & 1;
        return (c) => {
          let [lo, hi] = signed ? Cpu.muls64(r[rm], r[rs]) : Cpu.mulu64(r[rm], r[rs]);
          if (acc) [lo, hi] = Cpu.add64(lo, hi, r[ra], r[rd]);
          r[ra] = lo; r[rd] = hi;
          if (S) { c.N = hi >>> 31; c.Z = (lo | hi) === 0 ? 1 : 0; }
        };
      }
    }
    return this.undef(w, pc);
  }

  decSync(w, pc) {
    const op = (w >>> 20) & 0xF, rn = (w >>> 16) & 0xF, rt = (w >>> 12) & 0xF, rm = w & 0xF;
    const r = this.r;
    if (op === 0x9) return (c) => { r[rt] = c.ld32(r[rn]); c.exclusive = true; };            // LDREX
    if (op === 0x8) return (c) => { c.st32(r[rn], r[rm]); r[rt] = 0; c.exclusive = false; };   // STREX
    if (op === 0xD) return (c) => { r[rt] = c.ld8(r[rn]); };                                  // LDREXB
    if (op === 0xC) return (c) => { c.st8(r[rn], r[rm]); r[rt] = 0; };
    if (op === 0xF) return (c) => { r[rt] = c.ld16(r[rn]); };
    if (op === 0xE) return (c) => { c.st16(r[rn], r[rm]); r[rt] = 0; };
    if (op === 0x0) return (c) => { const a = r[rn], v = c.ld32(a); c.st32(a, r[rm]); r[rt] = v; };   // SWP
    if (op === 0x4) return (c) => { const a = r[rn], v = c.ld8(a); c.st8(a, r[rm]); r[rt] = v; };      // SWPB
    return this.undef(w, pc);
  }

  // ---------------------------------------------------------------- misc
  decMisc(w, pc) {
    const op = (w >>> 21) & 3, op2 = (w >>> 4) & 7, r = this.r;
    const rd = (w >>> 12) & 0xF, rm = w & 0xF;
    if (w & 0x80 && !(w & 0x10)) {                 // halfword multiplies
      const rdd = (w >>> 16) & 0xF, ra = (w >>> 12) & 0xF, rs = (w >>> 8) & 0xF;
      const xn = (w >>> 5) & 1, ym = (w >>> 6) & 1;
      const half = (v, top) => top ? v >> 16 : (v << 16) >> 16;
      if (op === 3) return (c) => { r[rdd] = Math.imul(half(r[rm], xn), half(r[rs], ym)); };             // SMULxy
      if (op === 0) return (c) => {                                                                           // SMLAxy
        const p = Math.imul(half(r[rm], xn), half(r[rs], ym)); const s = p + r[ra]; const v = s | 0; if (s !== v) c.Q = 1; r[rdd] = v; };
      if (op === 1 && !xn) return (c) => { const p = Math.floor(r[rm] * half(r[rs], ym) / 65536); const s = p + r[ra]; const v = s | 0; if (s !== v) c.Q = 1; r[rdd] = v; }; // SMLAWy
      if (op === 1 && xn) return (c) => { r[rdd] = Math.floor(r[rm] * half(r[rs], ym) / 65536) | 0; };  // SMULWy
      return this.undef(w, pc);
    }
    switch (op2) {
      case 0:
        if (op & 1) return this.decMSR(w, pc, null, rm);
        if (w & 0x00400000) return (c) => { r[rd] = c.spsr | 0; };
        return (c) => { r[rd] = c.cpsr | 0; };
      case 1:
        if (op === 1) return (c) => { c.bxWrite(r[rm]); };
        if (op === 3) return (c) => { r[rd] = Math.clz32(r[rm]); };
        break;
      case 3:
        if (op === 1) return (c) => { const t = r[rm]; r[14] = pc + 4; c.bxWrite(t); };
        break;
      case 7: return this.undef(w, pc);
    }
    return this.undef(w, pc);
  }

  decMSR(w, pc, imm, rm) {
    const mask = (w >>> 16) & 0xF, spsr = (w >>> 22) & 1, r = this.r;
    const get = imm !== null && rm < 0 ? () => imm : () => r[rm];
    if (spsr) return (c) => {
      let v = c.spsr, x = get() >>> 0, m = 0;
      if (mask & 8) m |= 0xFF000000; if (mask & 4) m |= 0x00FF0000; if (mask & 2) m |= 0x0000FF00; if (mask & 1) m |= 0xFF;
      c.spsr = ((v & ~m) | (x & m)) | 0;
    };
    return (c) => {
      // user mode may only write flags
      const m = c.mode === 0x10 ? (mask & 8) : mask;
      c.setCpsr(get() >>> 0, m);
    };
  }

  // ---------------------------------------------------------------- load / store
  decLS(w, pc) {
    const P = (w >>> 24) & 1, U = (w >>> 23) & 1, B = (w >>> 22) & 1, W = (w >>> 21) & 1, L = (w >>> 20) & 1;
    const rn = (w >>> 16) & 0xF, rt = (w >>> 12) & 0xF, r = this.r;
    let off;
    if (!(w & 0x02000000)) { const imm = w & 0xFFF; off = () => imm; }
    else {
      const rm = w & 0xF, type = (w >>> 5) & 3, n = (w >>> 7) & 0x1F;
      switch (type) {
        case 0: off = n ? (c) => r[rm] << n : (c) => r[rm]; break;
        case 1: off = n ? (c) => (r[rm] >>> n) | 0 : () => 0; break;
        case 2: off = n ? (c) => r[rm] >> n : (c) => r[rm] >> 31; break;
        default: off = n ? (c) => ror(r[rm], n) | 0 : (c) => (c.C << 31) | (r[rm] >>> 1);
      }
    }
    const wb = !P || W;
    const sign = U ? 1 : -1;
    return this.makeLS(L, B ? 1 : 4, false, rn, rt, off, P, sign, wb, false);
  }

  // size 1/2/4, signed load, thumb (affects PC write kind is same: LoadWritePC interworks)
  makeLS(L, size, signed, rn, rt, off, P, sign, wb, thumb) {
    const r = this.r;
    const addrOf = P ? (sign > 0 ? (c) => (r[rn] + off(c)) | 0 : (c) => (r[rn] - off(c)) | 0) : (c) => r[rn];
    const upd = sign > 0 ? (c) => (r[rn] + off(c)) | 0 : (c) => (r[rn] - off(c)) | 0;
    const base = rn === 15 ? (c) => r[15] & ~3 : null;
    const A = base ? (P ? (sign > 0 ? (c) => (base(c) + off(c)) | 0 : (c) => (base(c) - off(c)) | 0) : base) : addrOf;
    if (L) {
      let ld;
      if (size === 4) ld = (c, a) => c.ld32(a);
      else if (size === 2) ld = signed ? (c, a) => (c.ld16(a) << 16) >> 16 : (c, a) => c.ld16(a);
      else ld = signed ? (c, a) => (c.ld8(a) << 24) >> 24 : (c, a) => c.ld8(a);
      if (rt === 15) return (c) => { const a = A(c); const v = ld(c, a); if (wb) r[rn] = P ? a : upd(c); c.bxWrite(v); };
      if (wb) return (c) => { const a = A(c); const nb = P ? a : upd(c); const v = ld(c, a); r[rn] = nb; r[rt] = v; };
      return (c) => { r[rt] = ld(c, A(c)); };
    }
    let st;
    if (size === 4) st = (c, a, v) => c.st32(a, v);
    else if (size === 2) st = (c, a, v) => c.st16(a, v);
    else st = (c, a, v) => c.st8(a, v);
    if (wb) return (c) => { const a = A(c); const nb = P ? a : upd(c); st(c, a, r[rt]); r[rn] = nb; };
    return (c) => { st(c, A(c), r[rt]); };
  }

  decExtraLS(w, pc) {
    const P = (w >>> 24) & 1, U = (w >>> 23) & 1, I = (w >>> 22) & 1, W = (w >>> 21) & 1, L = (w >>> 20) & 1;
    const rn = (w >>> 16) & 0xF, rt = (w >>> 12) & 0xF, op2 = (w >>> 5) & 3, r = this.r;
    let off;
    if (I) { const imm = ((w >>> 4) & 0xF0) | (w & 0xF); off = () => imm; } else { const rm = w & 0xF; off = (c) => r[rm]; }
    const wb = !P || W, sign = U ? 1 : -1;
    if (op2 === 1) return this.makeLS(L, 2, false, rn, rt, off, P, sign, wb, false);
    if (op2 === 2 && L) return this.makeLS(1, 1, true, rn, rt, off, P, sign, wb, false);
    if (op2 === 3 && L) return this.makeLS(1, 2, true, rn, rt, off, P, sign, wb, false);
    return this.makeLSD(!L && op2 === 2, rn, rt, rt + 1, off, P, sign, wb);
  }

  makeLSD(load, rn, rt, rt2, off, P, sign, wb) {
    const r = this.r;
    return (c) => {
      const base = rn === 15 ? (r[15] & ~3) : r[rn];
      const oa = sign > 0 ? (base + off(c)) | 0 : (base - off(c)) | 0;
      const a = P ? oa : base;
      if (load) {
        const v1 = c.ld32(a), v2 = c.ld32(a + 4);
        if (wb) r[rn] = oa;
        r[rt] = v1; r[rt2] = v2;
      } else {
        c.st32(a, r[rt]); c.st32(a + 4, r[rt2]);
        if (wb) r[rn] = oa;
      }
    };
  }

  decLSM(w, pc) {
    const P = (w >>> 24) & 1, U = (w >>> 23) & 1, S = (w >>> 22) & 1, W = (w >>> 21) & 1, L = (w >>> 20) & 1;
    const rn = (w >>> 16) & 0xF, list = w & 0xFFFF;
    return this.makeLSM(L, P, U, S, W, rn, list, false);
  }

  makeLSM(L, P, U, S, W, rn, list, thumb) {
    const r = this.r;
    const regs = []; for (let i = 0; i < 16; i++) if (list >> i & 1) regs.push(i);
    const n = regs.length;
    const hasPC = !!(list & 0x8000);
    const inList = !!(list >> rn & 1);
    const startOff = U ? (P ? 4 : 0) : (P ? -4 * n : -4 * n + 4);
    const wbOff = U ? 4 * n : -4 * n;
    if (L) {
      const userBank = S && !hasPC;
      return (c) => {
        const base = r[rn];
        let a = (base + startOff) | 0;
        let pcv = 0;
        for (let k = 0; k < n; k++) {
          const i = regs[k];
          const v = c.ld32(a); a = (a + 4) | 0;
          if (i === 15) pcv = v;
          else if (userBank && i >= 13 && c.mode !== 0x10 && c.mode !== 0x1F) { const b = 0; if (i === 13) c.bankR13[b] = v; else c.bankR14[b] = v; }
          else r[i] = v;
        }
        if (W && !inList) r[rn] = (base + wbOff) | 0;
        if (hasPC) { if (S) c.excReturn(pcv); else c.bxWrite(pcv); }
      };
    }
    return (c) => {
      const base = r[rn];
      let a = (base + startOff) | 0;
      for (let k = 0; k < n; k++) {
        const i = regs[k];
        let v = r[i];
        if (S && i >= 13 && i <= 14 && c.mode !== 0x10 && c.mode !== 0x1F) v = i === 13 ? c.bankR13[0] : c.bankR14[0];
        c.st32(a, v); a = (a + 4) | 0;
      }
      if (W) r[rn] = (base + wbOff) | 0;
    };
  }

  // ---------------------------------------------------------------- media
  decMedia(w, pc) {
    const op1 = (w >>> 20) & 0x1F, op2 = (w >>> 5) & 7, r = this.r;
    const rd = (w >>> 12) & 0xF, rn = (w >>> 16) & 0xF, rm = w & 0xF;
    if ((op1 & 0x18) === 0x08) {
      // extend (op2 = 011)
      if (op2 === 3) {
        const rot = ((w >>> 10) & 3) * 8;
        const kind = op1 & 7;                        // 010 SXTAB 011 SXTAH 110 UXTAB 111 UXTAH 000 SXTAB16 100 UXTAB16
        let ext;
        switch (kind) {
          case 2: ext = (v) => (v << 24) >> 24; break;
          case 3: ext = (v) => (v << 16) >> 16; break;
          case 6: ext = (v) => v & 0xFF; break;
          case 7: ext = (v) => v & 0xFFFF; break;
          case 4: ext = (v) => v & 0x00FF00FF; break;
          default: return this.undef(w, pc);
        }
        if (rn === 15) return (c) => { r[rd] = ext(ror(r[rm], rot) | 0); };
        if (kind === 4) return (c) => { const x = ror(r[rm], rot); r[rd] = ((((r[rn] & 0xFFFF) + (x & 0xFF)) & 0xFFFF) | (((r[rn] >>> 16) + ((x >>> 16) & 0xFF)) << 16)); };
        return (c) => { r[rd] = (r[rn] + ext(ror(r[rm], rot) | 0)) | 0; };
      }
      if (op1 === 0x0B && op2 === 1) return (c) => { const v = r[rm]; r[rd] = ((v >>> 24) | ((v >>> 8) & 0xFF00) | ((v << 8) & 0xFF0000) | (v << 24)); };   // REV
      if (op1 === 0x0B && op2 === 5) return (c) => { const v = r[rm]; r[rd] = (((v >>> 8) & 0x00FF00FF) | ((v << 8) & 0xFF00FF00)); };                  // REV16
      if (op1 === 0x0F && op2 === 5) return (c) => { const v = r[rm]; r[rd] = ((((v & 0xFF) << 24) >> 16) | ((v >>> 8) & 0xFF)); };                      // REVSH
      if (op1 === 0x0F && op2 === 1) return (c) => { let v = r[rm] >>> 0, o = 0; for (let i = 0; i < 32; i++) { o = (o << 1) | (v & 1); v >>>= 1; } r[rd] = o; }; // RBIT
      if ((op1 & 0x1E) === 0x0E && !(op2 & 1) || (op1 & 0x1E) === 0x0A && !(op2 & 1)) {   // USAT / SSAT
        const sat = (w >>> 16) & 0x1F, sh = (w >>> 6) & 1, n = (w >>> 7) & 0x1F, uns = (op1 & 4) !== 0;
        return this.makeSat(uns, rd, rm, sat, sh, n);
      }
      return this.undef(w, pc);
    }
    if ((op1 & 0x18) === 0x10) {
      const rdd = (w >>> 16) & 0xF, rmm = (w >>> 8) & 0xF, rnn = w & 0xF;
      if (op1 === 0x11 && op2 === 0) return (c) => { const d = r[rmm]; r[rdd] = d === 0 ? 0 : (d === -1 && r[rnn] === -0x80000000) ? -0x80000000 : (r[rnn] / d) | 0; };   // SDIV
      if (op1 === 0x13 && op2 === 0) return (c) => { const d = r[rmm] >>> 0; r[rdd] = d === 0 ? 0 : ((r[rnn] >>> 0) / d) | 0; };   // UDIV
      return this.undef(w, pc);
    }
    if ((op1 & 0x1E) === 0x1A && (op2 & 3) === 2) {   // SBFX
      const width = ((w >>> 16) & 0x1F) + 1, lsb = (w >>> 7) & 0x1F;
      return (c) => { r[rd] = (r[rm] << (32 - lsb - width)) >> (32 - width); };
    }
    if ((op1 & 0x1E) === 0x1E && (op2 & 3) === 2) {   // UBFX
      const width = ((w >>> 16) & 0x1F) + 1, lsb = (w >>> 7) & 0x1F;
      return (c) => { r[rd] = width === 32 ? r[rm] : (r[rm] >>> lsb) & ((1 << width) - 1) >>> 0; };
    }
    if ((op1 & 0x1E) === 0x1C && (op2 & 3) === 0) {   // BFC / BFI
      const msb = (w >>> 16) & 0x1F, lsb = (w >>> 7) & 0x1F;
      return this.makeBFI(rd, rm === 15 ? -1 : rm, lsb, msb);
    }
    return this.undef(w, pc);
  }

  makeSat(uns, rd, rn, sat, sh, n) {
    const r = this.r;
    const shift = sh ? (v) => v >> (n || 31) : (v) => v << n;
    if (uns) { const max = sat === 31 ? 0x7FFFFFFF * 2 + 1 : (1 << sat) - 1;
      return (c) => { const v = shift(r[rn]); if (v < 0) { r[rd] = 0; c.Q = 1; } else if (v > max) { r[rd] = max | 0; c.Q = 1; } else r[rd] = v; }; }
    const max = Math.pow(2, sat) - 1, min = -Math.pow(2, sat);
    return (c) => { const v = shift(r[rn]); if (v > max) { r[rd] = max; c.Q = 1; } else if (v < min) { r[rd] = min; c.Q = 1; } else r[rd] = v; };
  }

  makeBFI(rd, rn, lsb, msb) {
    const r = this.r;
    if (msb < lsb) return () => {};
    const width = msb - lsb + 1;
    const mask = (width === 32 ? -1 : ((1 << width) - 1) << lsb) | 0;
    if (rn < 0) return (c) => { r[rd] = r[rd] & ~mask; };
    return (c) => { r[rd] = (r[rd] & ~mask) | ((r[rn] << lsb) & mask); };
  }

  // ---------------------------------------------------------------- coprocessors
  decCopro(w, pc) {
    const cp = (w >>> 8) & 0xF;
    if (cp === 15 && (w & 0x10)) {
      const op1 = (w >>> 21) & 7, L = (w >>> 20) & 1, crn = (w >>> 16) & 0xF, rt = (w >>> 12) & 0xF, op2 = (w >>> 5) & 7, crm = w & 0xF;
      const k = (crn << 12) | (op1 << 8) | (crm << 4) | op2, r = this.r;
      if (L) return rt === 15 ? (c) => { const v = c.cp15get(crn, op1, crm, op2); c.N = v >>> 31; c.Z = (v >>> 30) & 1; c.C = (v >>> 29) & 1; c.V = (v >>> 28) & 1; }
        : (c) => { r[rt] = c.cp15get(crn, op1, crm, op2); };
      if (crn === 7 || crn === 8) return () => {};      // cache / TLB / barrier operations
      return (c) => { c.cp15.set(k, r[rt] >>> 0); };
    }
    if (cp === 10 || cp === 11) return this.decVfp(w, pc);
    return this.undef(w, pc);
  }

  // ================================================================== VFP
  vfpExpandImm(imm8, dbl) {
    const s = imm8 >> 7, b6 = (imm8 >> 6) & 1, rest = imm8 & 0x3F;
    if (dbl) { const exp = ((b6 ? 0 : 1) << 10) | ((b6 ? 0xFF : 0) << 2) | ((rest >> 4) & 3); const buf = new DataView(new ArrayBuffer(8));
      buf.setUint32(4, ((s << 31) | ((exp & 0x7FF) << 20) | ((rest & 0xF) << 16)) >>> 0, true); buf.setUint32(0, 0, true); return buf.getFloat64(0, true); }
    const exp = ((b6 ? 0 : 1) << 7) | ((b6 ? 0x1F : 0) << 2) | ((rest >> 4) & 3);
    const buf = new DataView(new ArrayBuffer(4)); buf.setUint32(0, ((s << 31) | ((exp & 0xFF) << 23) | ((rest & 0xF) << 19)) >>> 0, true); return buf.getFloat32(0, true);
  }

  // NaN results: first signalling NaN operand (quietened), else first quiet NaN, else the default NaN
  nanD(dst, ...src) {
    const v = this.v32;
    let pick = -1;
    for (const s of src) { const hi = v[s * 2 + 1], lo = v[s * 2]; if ((hi & 0x7FF00000) === 0x7FF00000 && ((hi & 0xFFFFF) | lo) && !(hi & 0x80000)) { pick = s; break; } }
    if (pick < 0) for (const s of src) { const hi = v[s * 2 + 1], lo = v[s * 2]; if ((hi & 0x7FF00000) === 0x7FF00000 && ((hi & 0xFFFFF) | lo)) { pick = s; break; } }
    if (pick < 0) { v[dst * 2] = 0; v[dst * 2 + 1] = 0x7FF80000; return; }
    v[dst * 2] = v[pick * 2]; v[dst * 2 + 1] = v[pick * 2 + 1] | 0x80000;
  }
  nanS(dst, ...src) {
    const v = this.v32;
    let pick = -1;
    for (const s of src) { const x = v[s]; if ((x & 0x7F800000) === 0x7F800000 && (x & 0x7FFFFF) && !(x & 0x400000)) { pick = s; break; } }
    if (pick < 0) for (const s of src) { const x = v[s]; if ((x & 0x7F800000) === 0x7F800000 && (x & 0x7FFFFF)) { pick = s; break; } }
    v[dst] = pick < 0 ? 0x7FC00000 : (v[pick] | 0x400000);
  }

  fpCompare(a, b, c) {
    if (Number.isNaN(a) || Number.isNaN(b)) this.fpscr = (this.fpscr & 0x0FFFFFFF) | 0x30000000;
    else if (a === b) this.fpscr = (this.fpscr & 0x0FFFFFFF) | 0x60000000;
    else if (a < b) this.fpscr = (this.fpscr & 0x0FFFFFFF) | 0x80000000;
    else this.fpscr = (this.fpscr & 0x0FFFFFFF) | 0x20000000;
  }

  roundInt(x, mode) {              // mode: 0 nearest-even, 1 +inf, 2 -inf, 3 zero
    switch (mode) {
      case 3: return Math.trunc(x);
      case 1: return Math.ceil(x);
      case 2: return Math.floor(x);
      default: { const f = Math.floor(x), d = x - f; if (d > 0.5) return f + 1; if (d < 0.5) return f; return (f % 2 === 0) ? f : f + 1; }
    }
  }
  toInt(x, signed, mode) {
    if (Number.isNaN(x)) return 0;
    let v = this.roundInt(x, mode);
    if (signed) { if (v > 2147483647) v = 2147483647; else if (v < -2147483648) v = -2147483648; return v | 0; }
    if (v > 4294967295) v = 4294967295; else if (v < 0) v = 0; return v | 0;
  }

  decVfp(w, pc) {
    const sz = (w >>> 8) & 1;
    const D = (w >>> 22) & 1, N = (w >>> 7) & 1, M = (w >>> 5) & 1;
    const vd = (w >>> 12) & 0xF, vn = (w >>> 16) & 0xF, vm = w & 0xF;
    const r = this.r, f64 = this.f64, f32 = this.f32, v32 = this.v32;
    if (w & 0x10) {                                     // transfers
      const rt = (w >>> 12) & 0xF;
      const opc1 = (w >>> 21) & 7, L = (w >>> 20) & 1;
      if (!sz) {
        if (opc1 === 0) { const s = (vn << 1) | N; return L ? (c) => { r[rt] = v32[s]; } : (c) => { v32[s] = r[rt]; }; }   // VMOV core<->S
        if (opc1 === 7) {                                                                                                  // VMRS / VMSR
          const reg = vn;
          if (L) {
            if (reg === 1) return rt === 15 ? (c) => { const v = c.fpscr; c.N = v >>> 31; c.Z = (v >>> 30) & 1; c.C = (v >>> 29) & 1; c.V = (v >>> 28) & 1; } : (c) => { r[rt] = c.fpscr; };
            if (reg === 8) return (c) => { r[rt] = c.fpexc; };
            if (reg === 0) return (c) => { r[rt] = 0x41023075; };   // FPSID
            if (reg === 6 || reg === 7) return (c) => { r[rt] = reg === 7 ? 0x10110222 : 0x10110222; };
            return (c) => { r[rt] = 0; };
          }
          if (reg === 1) return (c) => { c.fpscr = r[rt]; };
          if (reg === 8) return (c) => { c.fpexc = r[rt]; };
          return () => {};
        }
      } else {
        // VMOV scalar: Dd[x] <-> Rt (32-bit lanes only)
        if ((opc1 & 4) === 0 && ((w >>> 5) & 3) === 0) {
          const d = (N << 4) | vn, x = (w >>> 21) & 1;
          return L ? (c) => { r[rt] = v32[d * 2 + x]; } : (c) => { v32[d * 2 + x] = r[rt]; };
        }
      }
      return this.undef(w, pc);
    }
    const opc1 = ((w >>> 20) & 3) | (((w >>> 23) & 1) << 2), op6 = (w >>> 6) & 1;
    // register numbering
    const Dd = (D << 4) | vd, Dn = (N << 4) | vn, Dm = (M << 4) | vm;
    const Sd = (vd << 1) | D, Sn = (vn << 1) | N, Sm = (vm << 1) | M;
    if (sz) {
      // a NaN result goes through nanD (ARM NaN propagation / default NaN; JS NaNs lose sign and payload)
      const bin = (fn) => (c) => { const v = fn(f64[Dn], f64[Dm]); if (v === v) f64[Dd] = v; else c.nanD(Dd, Dn, Dm); };
      const acc = (fn) => (c) => { const v = fn(f64[Dd], f64[Dn] * f64[Dm]); if (v === v) f64[Dd] = v; else c.nanD(Dd, Dd, Dn, Dm); };
      switch (opc1) {
        case 0: return op6 ? acc((d, p) => d - p) : acc((d, p) => d + p);                       // VMLS / VMLA
        case 1: return op6 ? acc((d, p) => -d - p) : acc((d, p) => -d + p);                     // VNMLA / VNMLS
        case 2: return op6 ? bin((a, b) => -(a * b)) : bin((a, b) => a * b);                    // VNMUL / VMUL
        case 3: return op6 ? bin((a, b) => a - b) : bin((a, b) => a + b);                       // VSUB / VADD
        case 4: if (!op6) return bin((a, b) => a / b); break;                                   // VDIV
      }
    } else {
      const F = Math.fround;
      const bin = (fn) => (c) => { const v = F(fn(f32[Sn], f32[Sm])); if (v === v) f32[Sd] = v; else c.nanS(Sd, Sn, Sm); };
      const acc = (fn) => (c) => { const v = F(fn(f32[Sd], F(f32[Sn] * f32[Sm]))); if (v === v) f32[Sd] = v; else c.nanS(Sd, Sd, Sn, Sm); };
      switch (opc1) {
        case 0: return op6 ? acc((d, p) => d - p) : acc((d, p) => d + p);
        case 1: return op6 ? acc((d, p) => -d - p) : acc((d, p) => -d + p);
        case 2: return op6 ? bin((a, b) => -(a * b)) : bin((a, b) => a * b);
        case 3: return op6 ? bin((a, b) => a - b) : bin((a, b) => a + b);
        case 4: if (!op6) return bin((a, b) => a / b); break;
      }
    }
    if (opc1 === 7) {
      if (!op6) {                                                        // VMOV immediate
        const imm8 = ((w >>> 12) & 0xF0) | (w & 0xF);
        const imm8b = (((w >>> 16) & 0xF) << 4) | (w & 0xF);
        const val = this.vfpExpandImm(imm8b, sz);
        return sz ? (c) => { f64[Dd] = val; } : (c) => { f32[Sd] = val; };
      }
      const opc2 = (w >>> 16) & 0xF, op7 = (w >>> 7) & 1;
      switch (opc2) {
        case 0: return sz ? (op7 ? (c) => { f64[Dd] = Math.abs(f64[Dm]); } : (c) => { v32[Dd * 2] = v32[Dm * 2]; v32[Dd * 2 + 1] = v32[Dm * 2 + 1]; })
          : (op7 ? (c) => { v32[Sd] = v32[Sm] & 0x7FFFFFFF; } : (c) => { v32[Sd] = v32[Sm]; });
        case 1: return sz ? (op7 ? (c) => { const v = Math.sqrt(f64[Dm]); if (v === v) f64[Dd] = v; else c.nanD(Dd, Dm); } : (c) => { v32[Dd * 2] = v32[Dm * 2]; v32[Dd * 2 + 1] = v32[Dm * 2 + 1] ^ 0x80000000; })
          : (op7 ? (c) => { const v = Math.fround(Math.sqrt(f32[Sm])); if (v === v) f32[Sd] = v; else c.nanS(Sd, Sm); } : (c) => { v32[Sd] = v32[Sm] ^ 0x80000000; });
        case 10: case 11: case 14: case 15: {                                    // fixed point <-> fp, in place
          const toFixed = (opc2 >> 2) & 1, uns = opc2 & 1, size = op7 ? 32 : 16;
          const fbits = size - (((w & 0xF) << 1) | ((w >>> 5) & 1));
          const scale = Math.pow(2, fbits);
          if (toFixed) return (c) => {
            const x = sz ? f64[Dd] : f32[Sd];
            let v = Number.isNaN(x) ? 0 : Math.trunc(x * scale);
            const max = uns ? Math.pow(2, size) - 1 : Math.pow(2, size - 1) - 1, min = uns ? 0 : -Math.pow(2, size - 1);
            if (v > max) v = max; else if (v < min) v = min;
            const lo = v | 0;
            if (sz) { v32[Dd * 2] = lo; v32[Dd * 2 + 1] = uns ? 0 : (lo >> 31); } else v32[Sd] = lo;
          };
          return (c) => {
            let raw = sz ? v32[Dd * 2] : v32[Sd];
            if (size === 16) raw = uns ? raw & 0xFFFF : (raw << 16) >> 16; else if (uns) raw >>>= 0;
            if (sz) f64[Dd] = raw / scale; else f32[Sd] = Math.fround(raw / scale);
          };
        }
        case 4: return sz ? (c) => c.fpCompare(f64[Dd], f64[Dm]) : (c) => c.fpCompare(f32[Sd], f32[Sm]);
        case 5: return sz ? (c) => c.fpCompare(f64[Dd], 0) : (c) => c.fpCompare(f32[Sd], 0);
        case 7: if (op7) return sz ? (c) => { f32[Sd] = Math.fround(f64[Dm]); } : (c) => { f64[Dd] = f32[Sm]; }; break;
        case 8: {                                                                // int -> fp (source Sm)
          const signed = op7;
          return sz ? (c) => { f64[Dd] = signed ? v32[Sm] : v32[Sm] >>> 0; } : (c) => { f32[Sd] = Math.fround(signed ? v32[Sm] : v32[Sm] >>> 0); };
        }
        case 12: case 13: {                                                      // fp -> int (dest Sd)
          const signed = opc2 === 13, rz = op7;
          return sz ? (c) => { v32[Sd] = c.toInt(f64[Dm], signed, rz ? 3 : (c.fpscr >>> 22) & 3); }
            : (c) => { v32[Sd] = c.toInt(f32[Sm], signed, rz ? 3 : (c.fpscr >>> 22) & 3); };
        }
      }
    }
    return this.undef(w, pc);
  }

  decVfpLS(w, pc) {
    const cp = (w >>> 8) & 0xF;
    if (cp !== 10 && cp !== 11) return this.undef(w, pc);
    const sz = cp === 11 ? 1 : 0;
    const P = (w >>> 24) & 1, U = (w >>> 23) & 1, D = (w >>> 22) & 1, W = (w >>> 21) & 1, L = (w >>> 20) & 1;
    const rn = (w >>> 16) & 0xF, vd = (w >>> 12) & 0xF, imm8 = w & 0xFF, r = this.r, v32 = this.v32;
    const op = (w >>> 21) & 0xF;                       // P U D W (for 64-bit moves: 0010)
    if ((w & 0x0FE00000) === 0x0C400000) {             // 64-bit transfers core <-> D / two S
      const rt = (w >>> 12) & 0xF, rt2 = (w >>> 16) & 0xF, M = (w >>> 5) & 1, vm = w & 0xF;
      if (sz) { const d = (M << 4) | vm; return L ? (c) => { r[rt] = v32[d * 2]; r[rt2] = v32[d * 2 + 1]; } : (c) => { v32[d * 2] = r[rt]; v32[d * 2 + 1] = r[rt2]; }; }
      const s = (vm << 1) | M; return L ? (c) => { r[rt] = v32[s]; r[rt2] = v32[s + 1]; } : (c) => { v32[s] = r[rt]; v32[s + 1] = r[rt2]; };
    }
    if (P && !W) {                                     // VLDR / VSTR
      const off = (imm8 << 2) * (U ? 1 : -1);
      const reg = sz ? ((D << 4) | vd) * 2 : (vd << 1) | D;
      const base = rn === 15 ? (c) => r[15] & ~3 : (c) => r[rn];
      if (sz) return L ? (c) => { const a = (base(c) + off) | 0; v32[reg] = c.ld32(a); v32[reg + 1] = c.ld32(a + 4); }
        : (c) => { const a = (base(c) + off) | 0; c.st32(a, v32[reg]); c.st32(a + 4, v32[reg + 1]); };
      return L ? (c) => { v32[reg] = c.ld32((base(c) + off) | 0); } : (c) => { c.st32((base(c) + off) | 0, v32[reg]); };
    }
    // VLDM / VSTM (IA or DB with writeback)
    const words = sz ? (imm8 & ~1) : imm8;
    const first = sz ? ((D << 4) | vd) * 2 : (vd << 1) | D;
    return (c) => {
      const base = r[rn];
      let a = U ? base : (base - 4 * words) | 0;
      for (let k = 0; k < words; k++) { if (L) v32[first + k] = c.ld32(a); else c.st32(a, v32[first + k]); a = (a + 4) | 0; }
      if (W) r[rn] = U ? (base + 4 * words) | 0 : (base - 4 * words) | 0;
    };
  }

  // ================================================================== Thumb decoder
  decodeT(pc) {
    const hook = this.hooks.get(pc);
    if (hook) { hook.len = 2; return hook; }
    const hw = this.fetch16(pc);
    let f;
    if ((hw & 0xE000) === 0xE000 && (hw & 0x1800) !== 0) {
      const hw2 = this.fetch16(pc + 2);
      f = this.decodeT32(hw, hw2, pc);
      f.len = 4;
    } else {
      f = this.decodeT16(hw, pc);
      f.len = 2;
    }
    const pre = this.prehooks.get(pc);
    if (pre) { const g = f, len = f.len, isIT = f.isIT; f = (c) => { pre(c); g(c); }; f.len = len; f.isIT = isIT; }
    return f;
  }

  decodeT16(hw, pc) {
    const r = this.r;
    const inIT = this.it !== 0;
    const setf = !inIT;
    const top5 = hw >>> 11;
    const nz = (c, v) => { c.N = v >>> 31; c.Z = v === 0 ? 1 : 0; };
    if (top5 <= 2) {                                    // LSL/LSR/ASR imm
      const imm = (hw >>> 6) & 0x1F, rm = (hw >>> 3) & 7, rd = hw & 7, type = top5;
      const b = this.op2((type << 5) | (imm << 7) | rm, setf);
      if (type === 0 && imm === 0) return setf ? (c) => { const v = r[rm]; r[rd] = v; nz(c, v); } : (c) => { r[rd] = r[rm]; };
      return setf ? (c) => { const v = b(c); r[rd] = v; nz(c, v); c.C = c.sc; } : (c) => { r[rd] = b(c); };
    }
    if (top5 === 3) {                                   // ADD/SUB reg / imm3
      const op = (hw >>> 9) & 3, rn = (hw >>> 3) & 7, rd = hw & 7, x = (hw >>> 6) & 7;
      const get = op & 2 ? () => x : (c) => r[x];
      if (op & 1) return setf ? (c) => { r[rd] = c.addc(r[rn], ~get(c), 1); } : (c) => { r[rd] = (r[rn] - get(c)) | 0; };
      return setf ? (c) => { r[rd] = c.addc(r[rn], get(c), 0); } : (c) => { r[rd] = (r[rn] + get(c)) | 0; };
    }
    if ((hw >>> 13) === 1) {                            // MOV/CMP/ADD/SUB imm8
      const op = (hw >>> 11) & 3, rd = (hw >>> 8) & 7, imm = hw & 0xFF;
      switch (op) {
        case 0: return setf ? (c) => { r[rd] = imm; nz(c, imm); } : (c) => { r[rd] = imm; };
        case 1: return (c) => { c.addc(r[rd], ~imm, 1); };
        case 2: return setf ? (c) => { r[rd] = c.addc(r[rd], imm, 0); } : (c) => { r[rd] = (r[rd] + imm) | 0; };
        case 3: return setf ? (c) => { r[rd] = c.addc(r[rd], ~imm, 1); } : (c) => { r[rd] = (r[rd] - imm) | 0; };
      }
    }
    if ((hw >>> 10) === 0x10) {                         // data processing
      const op = (hw >>> 6) & 0xF, rm = (hw >>> 3) & 7, rdn = hw & 7;
      const S = setf ? 1 : 0;
      switch (op) {
        case 0: return this.makeDP(0, S, rdn, rdn, (c) => { c.sc = c.C; return r[rm]; }, true);
        case 1: return this.makeDP(1, S, rdn, rdn, (c) => { c.sc = c.C; return r[rm]; }, true);
        case 2: case 3: case 4: case 7: {
          const type = op === 2 ? 0 : op === 3 ? 1 : op === 4 ? 2 : 3;
          const b = this.op2((rm << 8) | (type << 5) | 0x10 | rdn, true);
          return S ? (c) => { const v = b(c); r[rdn] = v; nz(c, v); c.C = c.sc; } : (c) => { r[rdn] = b(c); };
        }
        case 5: return this.makeDP(5, S, rdn, rdn, (c) => r[rm], true);
        case 6: return this.makeDP(6, S, rdn, rdn, (c) => r[rm], true);
        case 8: return this.makeDP(8, 1, rdn, rdn, (c) => { c.sc = c.C; return r[rm]; }, true);
        case 9: return this.makeDP(3, S, rm, rdn, () => 0, true);                     // RSB #0 (NEG)
        case 10: return this.makeDP(10, 1, rdn, rdn, (c) => r[rm], true);
        case 11: return this.makeDP(11, 1, rdn, rdn, (c) => r[rm], true);
        case 12: return this.makeDP(12, S, rdn, rdn, (c) => { c.sc = c.C; return r[rm]; }, true);
        case 13: return S ? (c) => { const v = Math.imul(r[rm], r[rdn]); r[rdn] = v; nz(c, v); } : (c) => { r[rdn] = Math.imul(r[rm], r[rdn]); };
        case 14: return this.makeDP(14, S, rdn, rdn, (c) => { c.sc = c.C; return r[rm]; }, true);
        case 15: return this.makeDP(15, S, rdn, rdn, (c) => { c.sc = c.C; return r[rm]; }, true);
      }
    }
    if ((hw >>> 10) === 0x11) {                         // special data / BX
      const op = (hw >>> 8) & 3, rm = (hw >>> 3) & 0xF, rdn = ((hw >>> 4) & 8) | (hw & 7);
      if (op === 0) return rdn === 15 ? (c) => c.branchWrite((r[15] + r[rm]) | 0) : (c) => { r[rdn] = (r[rdn] + r[rm]) | 0; };
      if (op === 1) return (c) => { c.addc(r[rdn], ~r[rm], 1); };
      if (op === 2) return rdn === 15 ? (c) => c.branchWrite(r[rm]) : (c) => { r[rdn] = r[rm]; };
      if (hw & 0x80) return (c) => { const t = r[rm]; r[14] = (pc + 2) | 1; c.bxWrite(t); };   // BLX
      return (c) => { c.bxWrite(r[rm]); };
    }
    if (top5 === 9) {                                   // LDR literal
      const rt = (hw >>> 8) & 7, imm = (hw & 0xFF) << 2, a = (((pc + 4) & ~3) + imm) | 0;
      return (c) => { r[rt] = c.ld32(a); };
    }
    if ((hw >>> 12) === 5) {                            // load/store register offset
      const op = (hw >>> 9) & 7, rm = (hw >>> 6) & 7, rn = (hw >>> 3) & 7, rt = hw & 7;
      const off = (c) => r[rm];
      const tbl = [[0, 4, false], [0, 2, false], [0, 1, false], [1, 1, true], [1, 4, false], [1, 2, false], [1, 1, false], [1, 2, true]][op];
      return this.makeLS(tbl[0], tbl[1], tbl[2], rn, rt, off, 1, 1, false, true);
    }
    if ((hw >>> 13) === 3) {                            // STR/LDR(B) imm5
      const B = (hw >>> 12) & 1, L = (hw >>> 11) & 1, imm = (hw >>> 6) & 0x1F, rn = (hw >>> 3) & 7, rt = hw & 7;
      const o = B ? imm : imm << 2;
      return this.makeLS(L, B ? 1 : 4, false, rn, rt, () => o, 1, 1, false, true);
    }
    if ((hw >>> 12) === 8) {                            // STRH/LDRH imm5
      const L = (hw >>> 11) & 1, imm = ((hw >>> 6) & 0x1F) << 1, rn = (hw >>> 3) & 7, rt = hw & 7;
      return this.makeLS(L, 2, false, rn, rt, () => imm, 1, 1, false, true);
    }
    if ((hw >>> 12) === 9) {                            // SP-relative
      const L = (hw >>> 11) & 1, rt = (hw >>> 8) & 7, imm = (hw & 0xFF) << 2;
      return this.makeLS(L, 4, false, 13, rt, () => imm, 1, 1, false, true);
    }
    if ((hw >>> 12) === 10) {                           // ADR / ADD SP
      const rd = (hw >>> 8) & 7, imm = (hw & 0xFF) << 2;
      if (hw & 0x800) return (c) => { r[rd] = (r[13] + imm) | 0; };
      const v = (((pc + 4) & ~3) + imm) | 0; return (c) => { r[rd] = v; };
    }
    if ((hw >>> 12) === 11) {                           // misc
      if ((hw & 0xFF00) === 0xB000) { const imm = (hw & 0x7F) << 2; return hw & 0x80 ? (c) => { r[13] = (r[13] - imm) | 0; } : (c) => { r[13] = (r[13] + imm) | 0; }; }
      if ((hw & 0xF500) === 0xB100) {                   // CBZ/CBNZ
        const nzb = (hw >>> 11) & 1, rn = hw & 7, imm = (((hw >>> 9) & 1) << 6) | (((hw >>> 3) & 0x1F) << 1);
        const target = (pc + 4 + imm) >>> 0;
        return nzb ? (c) => { if (r[rn] !== 0) c.npc = target; } : (c) => { if (r[rn] === 0) c.npc = target; };
      }
      if ((hw & 0xFF00) === 0xB200) {                   // SXTH SXTB UXTH UXTB
        const op = (hw >>> 6) & 3, rm = (hw >>> 3) & 7, rd = hw & 7;
        return [(c) => { r[rd] = (r[rm] << 16) >> 16; }, (c) => { r[rd] = (r[rm] << 24) >> 24; }, (c) => { r[rd] = r[rm] & 0xFFFF; }, (c) => { r[rd] = r[rm] & 0xFF; }][op];
      }
      if ((hw & 0xFE00) === 0xB400) {                   // PUSH
        const list = (hw & 0xFF) | ((hw & 0x100) ? 0x4000 : 0);
        return this.makeLSM(0, 1, 0, 0, 1, 13, list, true);
      }
      if ((hw & 0xFE00) === 0xBC00) {                   // POP
        const list = (hw & 0xFF) | ((hw & 0x100) ? 0x8000 : 0);
        return this.makeLSM(1, 0, 1, 0, 1, 13, list, true);
      }
      if ((hw & 0xFFE8) === 0xB660) {                   // CPS
        const im = (hw >>> 4) & 1, a = (hw >>> 2) & 1, i = (hw >>> 1) & 1, fq = hw & 1;
        return (c) => { if (a) c.A = im; if (i) c.I = im; if (fq) c.F = im; };
      }
      if ((hw & 0xFF00) === 0xBA00) {
        const op = (hw >>> 6) & 3, rm = (hw >>> 3) & 7, rd = hw & 7;
        if (op === 0) return (c) => { const v = r[rm]; r[rd] = ((v >>> 24) | ((v >>> 8) & 0xFF00) | ((v << 8) & 0xFF0000) | (v << 24)); };
        if (op === 1) return (c) => { const v = r[rm]; r[rd] = (((v >>> 8) & 0x00FF00FF) | ((v << 8) & 0xFF00FF00)); };
        if (op === 3) return (c) => { const v = r[rm]; r[rd] = ((((v & 0xFF) << 24) >> 16) | ((v >>> 8) & 0xFF)); };
      }
      if ((hw & 0xFF00) === 0xBF00) {
        if (hw & 0xF) { const it = hw & 0xFF; const f = (c) => { c.it = it; }; f.isIT = true; return f; }
        return () => {};                                // NOP / hints
      }
      return this.undef(hw, pc, true);
    }
    if ((hw >>> 12) === 12) {                           // STM / LDM
      const L = (hw >>> 11) & 1, rn = (hw >>> 8) & 7, list = hw & 0xFF;
      return this.makeLSM(L, 0, 1, 0, L ? !(list >> rn & 1) : 1, rn, list, true);
    }
    if ((hw >>> 12) === 13) {                           // B<cond> / SVC
      const cond = (hw >>> 8) & 0xF;
      if (cond >= 14) return this.undef(hw, pc, true);
      const target = (pc + 4 + (sext(hw & 0xFF, 8) << 1)) >>> 0;
      return (c) => { if (c.cond(cond)) c.npc = target; };
    }
    if (top5 === 0x1C) {                                // B
      const target = (pc + 4 + (sext(hw & 0x7FF, 11) << 1)) >>> 0;
      return (c) => { c.npc = target; };
    }
    return this.undef(hw, pc, true);
  }

  thumbExpandImm(imm12, wantCarry) {
    if ((imm12 >>> 10) === 0) {
      const b = imm12 & 0xFF;
      let v;
      switch ((imm12 >>> 8) & 3) { case 0: v = b; break; case 1: v = (b << 16) | b; break; case 2: v = (b << 24) | (b << 8); break; default: v = (b << 24) | (b << 16) | (b << 8) | b; }
      v |= 0;
      return wantCarry ? (c) => { c.sc = c.C; return v; } : () => v;
    }
    const v = ror(0x80 | (imm12 & 0x7F), imm12 >>> 7) | 0;
    const car = v >>> 31;
    return wantCarry ? (c) => { c.sc = car; return v; } : () => v;
  }

  decodeT32(hw1, hw2, pc) {
    const r = this.r;
    const op1 = (hw1 >>> 11) & 3, op2 = (hw1 >>> 4) & 0x7F;
    const w = ((hw1 << 16) | hw2) >>> 0;
    if (op1 === 1) {
      if ((op2 & 0x64) === 0x00) {                     // load/store multiple
        const op = (hw1 >>> 7) & 3, W = (hw1 >>> 5) & 1, L = (hw1 >>> 4) & 1, rn = hw1 & 0xF, list = hw2;
        if (op === 1) return this.makeLSM(L, 0, 1, 0, W, rn, list, true);
        if (op === 2) return this.makeLSM(L, 1, 0, 0, W, rn, list, true);
        return this.undef(w, pc, true);
      }
      if ((op2 & 0x64) === 0x04) {                     // dual / exclusive / table branch
        const P = (hw1 >>> 8) & 1, U = (hw1 >>> 7) & 1, W = (hw1 >>> 5) & 1, L = (hw1 >>> 4) & 1, rn = hw1 & 0xF;
        const rt = (hw2 >>> 12) & 0xF, rt2 = (hw2 >>> 8) & 0xF, imm = (hw2 & 0xFF) << 2;
        if (P || W) return this.makeLSD(L, rn, rt, rt2, () => imm, P, U ? 1 : -1, W);
        if (!U && !P && !W) {                          // LDREX / STREX
          if (L) return (c) => { r[rt] = c.ld32((r[rn] + imm) | 0); };
          const rd = (hw2 >>> 8) & 0xF; return (c) => { c.st32((r[rn] + imm) | 0, r[rt]); r[rd] = 0; };
        }
        if (U && L && (hw2 & 0xFFE0) === 0xF000) {     // TBB / TBH
          const rm = hw2 & 0xF, h = (hw2 >>> 4) & 1;
          return (c) => {
            const base = rn === 15 ? r[15] : r[rn];
            const n = h ? c.ld16((base + (r[rm] << 1)) | 0) : c.ld8((base + r[rm]) | 0);
            c.npc = (pc + 4 + 2 * n) >>> 0;
          };
        }
        return this.undef(w, pc, true);
      }
      if ((op2 & 0x60) === 0x20) {                     // data processing (shifted register)
        const op = (hw1 >>> 5) & 0xF, S = (hw1 >>> 4) & 1, rn = hw1 & 0xF, rd = (hw2 >>> 8) & 0xF;
        const imm = (((hw2 >>> 12) & 7) << 2) | ((hw2 >>> 6) & 3), type = (hw2 >>> 4) & 3, rm = hw2 & 0xF;
        const logical = [0, 1, 2, 3, 4].includes(op);
        const b = this.op2((imm << 7) | (type << 5) | rm, S && logical);
        return this.makeT32DP(op, S, rn, rd, b, w, pc);
      }
      if (op2 & 0x40) return this.decCoproT(w, pc);
      return this.undef(w, pc, true);
    }
    if (op1 === 2) {
      if (!(hw2 & 0x8000)) {
        if (!(op2 & 0x20)) {                           // modified immediate
          const op = (hw1 >>> 5) & 0xF, S = (hw1 >>> 4) & 1, rn = hw1 & 0xF, rd = (hw2 >>> 8) & 0xF;
          const imm12 = (((hw1 >>> 10) & 1) << 11) | (((hw2 >>> 12) & 7) << 8) | (hw2 & 0xFF);
          const logical = [0, 1, 2, 3, 4].includes(op);
          const b = this.thumbExpandImm(imm12, S && logical);
          return this.makeT32DP(op, S, rn, rd, b, w, pc);
        }
        // plain binary immediate
        const op = (hw1 >>> 4) & 0x1F, rn = hw1 & 0xF, rd = (hw2 >>> 8) & 0xF;
        const i = (hw1 >>> 10) & 1, imm3 = (hw2 >>> 12) & 7, imm8 = hw2 & 0xFF;
        const imm12 = (i << 11) | (imm3 << 8) | imm8;
        switch (op) {
          case 0x00: if (rn === 15) { const v = (((pc + 4) & ~3) + imm12) | 0; return (c) => { r[rd] = v; }; } return (c) => { r[rd] = (r[rn] + imm12) | 0; };
          case 0x0A: if (rn === 15) { const v = (((pc + 4) & ~3) - imm12) | 0; return (c) => { r[rd] = v; }; } return (c) => { r[rd] = (r[rn] - imm12) | 0; };
          case 0x04: { const v = (rn << 12) | imm12; return (c) => { r[rd] = v; }; }
          case 0x0C: { const v = (rn << 12) | imm12; return (c) => { r[rd] = (r[rd] & 0xFFFF) | (v << 16); }; }
          case 0x14: case 0x1C: {
            const lsb = (imm3 << 2) | ((hw2 >>> 6) & 3), width = (hw2 & 0x1F) + 1;
            if (op === 0x14) return (c) => { r[rd] = (r[rn] << (32 - lsb - width)) >> (32 - width); };
            return (c) => { r[rd] = width === 32 ? r[rn] : (r[rn] >>> lsb) & ((1 << width) - 1); };
          }
          case 0x16: { const lsb = (imm3 << 2) | ((hw2 >>> 6) & 3), msb = hw2 & 0x1F; return this.makeBFI(rd, rn === 15 ? -1 : rn, lsb, msb); }
          case 0x18: case 0x1A: case 0x10: case 0x12: {
            const sat = hw2 & 0x1F, sh = (hw1 >>> 5) & 1, n = (imm3 << 2) | ((hw2 >>> 6) & 3);
            return this.makeSat(op >= 0x18, rd, rn, sat, sh, n);
          }
        }
        return this.undef(w, pc, true);
      }
      // branches and misc control
      const b14 = (hw2 >>> 14) & 1, b12 = (hw2 >>> 12) & 1;
      const S = (hw1 >>> 10) & 1, J1 = (hw2 >>> 13) & 1, J2 = (hw2 >>> 11) & 1;
      if (!b14 && !b12) {
        if (((hw1 >>> 7) & 7) !== 7) {                 // conditional branch
          const cond = (hw1 >>> 6) & 0xF;
          const off = sext((S << 20) | (J2 << 19) | (J1 << 18) | ((hw1 & 0x3F) << 12) | ((hw2 & 0x7FF) << 1), 21);
          const target = (pc + 4 + off) >>> 0;
          return (c) => { if (c.cond(cond)) c.npc = target; };
        }
        if ((hw1 & 0xFFF0) === 0xF3B0) return () => {};   // DMB/DSB/ISB
        if ((hw1 & 0xFFF0) === 0xF3A0) return () => {};   // hints (NOP, WFI...)
        if ((hw1 & 0xFFE0) === 0xF380) {                   // MSR
          const rn = hw1 & 0xF, mask = (hw2 >>> 8) & 0xF, R = (hw1 >>> 4) & 1;
          return this.decMSR((R << 22) | (mask << 16), pc, null, rn);
        }
        if ((hw1 & 0xFFE0) === 0xF3E0) { const rd = (hw2 >>> 8) & 0xF, R = (hw1 >>> 4) & 1; return R ? (c) => { r[rd] = c.spsr | 0; } : (c) => { r[rd] = c.cpsr | 0; }; }
        return this.undef(w, pc, true);
      }
      const I1 = (~(J1 ^ S)) & 1, I2 = (~(J2 ^ S)) & 1;
      const off = sext((S << 24) | (I1 << 23) | (I2 << 22) | ((hw1 & 0x3FF) << 12) | ((hw2 & 0x7FF) << 1), 25);
      if (!b14 && b12) { const target = (pc + 4 + off) >>> 0; return (c) => { c.npc = target; }; }               // B.W
      if (b14 && b12) { const target = (pc + 4 + off) >>> 0; return (c) => { r[14] = (pc + 4) | 1; c.npc = target; }; }   // BL
      { const target = ((((pc + 4) & ~3) + off) & ~3) >>> 0; return (c) => { r[14] = (pc + 4) | 1; c.T = 0; c.npc = target; }; } // BLX
    }
    // op1 === 3
    if ((op2 & 0x71) === 0x00 || (op2 & 0x67) === 0x01 || (op2 & 0x67) === 0x03 || (op2 & 0x67) === 0x05) {   // load/store single
      const size = (hw1 >>> 5) & 3, signed = (hw1 >>> 8) & 1, L = (hw1 >>> 4) & 1, rn = hw1 & 0xF, rt = (hw2 >>> 12) & 0xF;
      const bytes = size === 0 ? 1 : size === 1 ? 2 : 4;
      if (L && rt === 15 && bytes < 4) return () => {};           // PLD / PLI (memory hints)
      if (rn === 15 && L) {
        const U = (hw1 >>> 7) & 1, imm = hw2 & 0xFFF;
        const a = (((pc + 4) & ~3) + (U ? imm : -imm)) | 0;
        return this.makeLS(1, bytes, !!signed, 15, rt, () => (U ? imm : -imm), 1, 1, false, true);
      }
      if (hw1 & 0x80) { const imm = hw2 & 0xFFF; return this.makeLS(L, bytes, !!signed, rn, rt, () => imm, 1, 1, false, true); }
      if (hw2 & 0x800) {
        const P = (hw2 >>> 10) & 1, U = (hw2 >>> 9) & 1, W = (hw2 >>> 8) & 1, imm = hw2 & 0xFF;
        return this.makeLS(L, bytes, !!signed, rn, rt, () => imm, P, U ? 1 : -1, W === 1, true);
      }
      if ((hw2 & 0xFC0) === 0) { const rm = hw2 & 0xF, sh = (hw2 >>> 4) & 3; return this.makeLS(L, bytes, !!signed, rn, rt, (c) => r[rm] << sh, 1, 1, false, true); }
      return this.undef(w, pc, true);
    }
    if ((op2 & 0x70) === 0x20) {                       // data processing (register)
      const o1 = (hw1 >>> 4) & 0xF, rn = hw1 & 0xF, rd = (hw2 >>> 8) & 0xF, o2 = (hw2 >>> 4) & 0xF, rm = hw2 & 0xF;
      if ((o1 & 0x8) === 0 && o2 === 0) {              // shifts by register
        const type = (o1 >>> 1) & 3, S = o1 & 1;
        const b = this.op2((rm << 8) | (type << 5) | 0x10 | rn, S);
        return S ? (c) => { const v = b(c); r[rd] = v; c.N = v >>> 31; c.Z = v === 0 ? 1 : 0; c.C = c.sc; } : (c) => { r[rd] = b(c); };
      }
      if ((o1 & 0x8) === 0 && (o2 & 8)) {              // extends
        const rot = ((hw2 >>> 4) & 3) * 8;
        let ext;
        switch (o1) { case 0: ext = (v) => (v << 16) >> 16; break; case 1: ext = (v) => v & 0xFFFF; break; case 4: ext = (v) => (v << 24) >> 24; break; case 5: ext = (v) => v & 0xFF; break; default: return this.undef(w, pc, true); }
        if (rn === 15) return (c) => { r[rd] = ext(ror(r[rm], rot) | 0); };
        return (c) => { r[rd] = (r[rn] + ext(ror(r[rm], rot) | 0)) | 0; };
      }
      if ((o1 & 0xC) === 0x8 && (o2 & 0xC) === 0x8) {  // misc
        const op = ((o1 & 3) << 2) | (o2 & 3);
        switch (op) {
          case 0x4 | 0: return (c) => { const v = r[rm]; r[rd] = ((v >>> 24) | ((v >>> 8) & 0xFF00) | ((v << 8) & 0xFF0000) | (v << 24)); };
          case 0x4 | 1: return (c) => { const v = r[rm]; r[rd] = (((v >>> 8) & 0x00FF00FF) | ((v << 8) & 0xFF00FF00)); };
          case 0x4 | 2: return (c) => { let v = r[rm] >>> 0, o = 0; for (let i = 0; i < 32; i++) { o = (o << 1) | (v & 1); v >>>= 1; } r[rd] = o; };
          case 0x4 | 3: return (c) => { const v = r[rm]; r[rd] = ((((v & 0xFF) << 24) >> 16) | ((v >>> 8) & 0xFF)); };
          case 0xC | 0: return (c) => { r[rd] = Math.clz32(r[rm]); };
        }
      }
      return this.undef(w, pc, true);
    }
    if ((op2 & 0x78) === 0x30) {                       // multiply / accumulate
      const o1 = (hw1 >>> 4) & 7, rn = hw1 & 0xF, ra = (hw2 >>> 12) & 0xF, rd = (hw2 >>> 8) & 0xF, o2 = (hw2 >>> 4) & 3, rm = hw2 & 0xF;
      if (o1 === 0 && o2 === 0) return ra === 15 ? (c) => { r[rd] = Math.imul(r[rn], r[rm]); } : (c) => { r[rd] = (Math.imul(r[rn], r[rm]) + r[ra]) | 0; };
      if (o1 === 0 && o2 === 1) return (c) => { r[rd] = (r[ra] - Math.imul(r[rn], r[rm])) | 0; };
      return this.undef(w, pc, true);
    }
    if ((op2 & 0x78) === 0x38) {                       // long multiply / divide
      const o1 = (hw1 >>> 4) & 7, rn = hw1 & 0xF, rdlo = (hw2 >>> 12) & 0xF, rdhi = (hw2 >>> 8) & 0xF, o2 = (hw2 >>> 4) & 0xF, rm = hw2 & 0xF;
      if (o1 === 1 && o2 === 0xF) return (c) => { const d = r[rm]; r[rdhi] = d === 0 ? 0 : (d === -1 && r[rn] === -0x80000000) ? -0x80000000 : (r[rn] / d) | 0; };
      if (o1 === 3 && o2 === 0xF) return (c) => { const d = r[rm] >>> 0; r[rdhi] = d === 0 ? 0 : ((r[rn] >>> 0) / d) | 0; };
      const map = { 0: 6, 2: 4, 4: 7, 6: 5 };            // SMULL UMULL SMLAL UMLAL -> ARM op
      if (o2 === 0 && map[o1] !== undefined) return this.makeMul(map[o1], 0, rdhi, rdlo, rm, rn, w, pc);
      return this.undef(w, pc, true);
    }
    if (op2 & 0x40) return this.decCoproT(w, pc);
    return this.undef(w, pc, true);
  }

  makeT32DP(op, S, rn, rd, b, w, pc) {
    // Thumb-2 opcodes -> ARM opcodes; rd==15 with S = test instructions; rn==15 = MOV/MVN
    switch (op) {
      case 0: return rd === 15 && S ? this.makeDP(8, 1, rn, 0, b, true) : this.makeDP(0, S, rn, rd, b, true);
      case 1: return this.makeDP(14, S, rn, rd, b, true);
      case 2: return rn === 15 ? this.makeDP(13, S, 0, rd, b, true) : this.makeDP(12, S, rn, rd, b, true);
      case 3: if (rn === 15) return this.makeDP(15, S, 0, rd, b, true);
        { const r = this.r; const nb = (c) => ~b(c); return this.makeDP(12, S, rn, rd, (c) => { const v = b(c); return ~v; }, true); }   // ORN
      case 4: return rd === 15 && S ? this.makeDP(9, 1, rn, 0, b, true) : this.makeDP(1, S, rn, rd, b, true);
      case 8: return rd === 15 && S ? this.makeDP(11, 1, rn, 0, b, true) : this.makeDP(4, S, rn, rd, b, true);
      case 10: return this.makeDP(5, S, rn, rd, b, true);
      case 11: return this.makeDP(6, S, rn, rd, b, true);
      case 13: return rd === 15 && S ? this.makeDP(10, 1, rn, 0, b, true) : this.makeDP(2, S, rn, rd, b, true);
      case 14: return this.makeDP(3, S, rn, rd, b, true);
    }
    return this.undef(w, pc, true);
  }

  decCoproT(w, pc) {
    // VFP encodings in Thumb equal the ARM ones with cond = 1110
    const aw = ((w & 0x0FFFFFFF) | 0xE0000000) >>> 0;
    const top = (w >>> 24) & 0xF;
    if (((w >>> 28) & 0xF) !== 0xE) return this.undef(w, pc, true);
    if ((aw & 0x0E000000) === 0x0C000000) return this.decVfpLS(aw, pc);
    return this.decCopro(aw, pc);
  }
}

export { MODE, DRAM, ror, sext };
