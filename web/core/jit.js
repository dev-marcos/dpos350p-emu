// Basic-block compiler for ARM state. A run of instructions up to the next branch becomes one JS
// function; the browser's JIT then turns it into machine code. Common instructions (data
// processing with immediate / shifted-register operands, single loads and stores, MOVW/MOVT,
// MUL/MLA, B/BL/BX) are generated inline with the same semantics as the interpreter closures in
// cpu.js. Every other instruction calls its interpreter closure ("fallback"), so behaviour is the
// same by construction. A block executes completely or stops early after a taken branch, a
// PC-changing fallback or a store that asked the run loop to stop (c.stop); it returns the number
// of instructions it executed.

const DRAM = 0x40000000;
const MAX_LEN = 48;
const COND = ['c.Z', '!c.Z', 'c.C', '!c.C', 'c.N', '!c.N', 'c.V', '!c.V', '(c.C && !c.Z)', '(!c.C || c.Z)',
  '(c.N === c.V)', '(c.N !== c.V)', '(!c.Z && c.N === c.V)', '(c.Z || c.N !== c.V)'];

const h = (v) => '0x' + (v >>> 0).toString(16);

// operand 2 (shift by immediate or immediate) -> {v: value expression, sc: carry expression}
function op2(w, a) {
  if (w & 0x02000000) {
    const rot = ((w >>> 8) & 0xF) * 2, imm = ((w & 0xFF) >>> rot | (w & 0xFF) << (32 - rot)) | 0;
    const val = rot ? imm : (w & 0xFF);
    return { v: String(val | 0), sc: rot ? String(val >>> 31) : 'c.C' };
  }
  if (w & 0x10) return null;                                  // shift by register: fallback
  const rm = w & 0xF, type = (w >>> 5) & 3, n = (w >>> 7) & 0x1F;
  const v = rm === 15 ? String((a + 8) | 0) : `r[${rm}]`;
  switch (type) {
    case 0: return n ? { v: `(${v} << ${n})`, sc: `((${v} >>> ${32 - n}) & 1)` } : { v, sc: 'c.C' };
    case 1: return n ? { v: `((${v} >>> ${n}) | 0)`, sc: `((${v} >>> ${n - 1}) & 1)` } : { v: '0', sc: `(${v} >>> 31)` };
    case 2: return n ? { v: `(${v} >> ${n})`, sc: `((${v} >>> ${n - 1}) & 1)` } : { v: `(${v} >> 31)`, sc: `(${v} >>> 31)` };
    default: return n ? { v: `(((${v} >>> ${n}) | (${v} << ${32 - n})) | 0)`, sc: `((${v} >>> ${n - 1}) & 1)` }
      : { v: `((c.C << 31) | (${v} >>> 1))`, sc: `(${v} & 1)` };
  }
}

// returns JS for one instruction (without the condition), or null to use the fallback closure.
// kind: 'seq' (falls through), 'store' (may set c.stop), 'end' (always leaves the block)
function gen(w, a) {
  const op1 = (w >>> 25) & 7;
  const reg = (n) => (n === 15 ? String((a + 8) | 0) : `r[${n}]`);
  if (op1 === 5) {                                            // B / BL
    const target = (a + 8 + (((w & 0xFFFFFF) << 8) >> 6)) >>> 0;
    return { kind: 'end', code: (w & 0x01000000 ? `r[14] = ${(a + 4) | 0}; ` : '') + `c.pc = ${h(target)};` };
  }
  if (op1 === 0 || op1 === 1) {
    if (op1 === 0 && (w & 0x90) === 0x90) {
      if ((w & 0x60) === 0) {                                 // multiplies
        if (w & 0x01000000) return null;
        const op = (w >>> 21) & 7, S = (w >>> 20) & 1, rd = (w >>> 16) & 0xF, ra = (w >>> 12) & 0xF, rs = (w >>> 8) & 0xF, rm = w & 0xF;
        if (S || rd === 15 || rm === 15 || rs === 15) return null;
        if (op === 0) return { kind: 'seq', code: `r[${rd}] = Math.imul(r[${rm}], r[${rs}]);` };
        if (op === 1 && ra !== 15) return { kind: 'seq', code: `r[${rd}] = (Math.imul(r[${rm}], r[${rs}]) + r[${ra}]) | 0;` };
        return null;
      }
      // extra loads/stores: LDRH/STRH/LDRSB/LDRSH (LDRD/STRD use the fallback)
      const P = (w >>> 24) & 1, U = (w >>> 23) & 1, I = (w >>> 22) & 1, W = (w >>> 21) & 1, L = (w >>> 20) & 1;
      const rn = (w >>> 16) & 0xF, rt = (w >>> 12) & 0xF, o2 = (w >>> 5) & 3;
      let ld = null, st = null;
      if (o2 === 1) { if (L) ld = 'c.ld16(ad)'; else st = 'c.st16(ad, VAL)'; }
      else if (o2 === 2 && L) ld = '((c.ld8(ad) << 24) >> 24)';
      else if (o2 === 3 && L) ld = '((c.ld16(ad) << 16) >> 16)';
      else return null;
      const off = I ? String(((w >>> 4) & 0xF0) | (w & 0xF)) : (w & 0xF) === 15 ? null : `r[${w & 0xF}]`;
      if (off === null) return null;
      return ls(P, U, W, rn, rt, off, ld, st, a);
    }
    if ((w & 0x01900000) === 0x01000000) {
      if (op1 === 1) {
        const op = (w >>> 20) & 0x1F, rd = (w >>> 12) & 0xF, imm = ((w >>> 4) & 0xF000) | (w & 0xFFF);
        if (rd === 15) return null;
        if (op === 0x10) return { kind: 'seq', code: `r[${rd}] = ${imm};` };
        if (op === 0x14) return { kind: 'seq', code: `r[${rd}] = (r[${rd}] & 0xFFFF) | ${imm << 16};` };
        return null;
      }
      // misc: BX only
      if (((w >>> 21) & 3) === 1 && ((w >>> 4) & 7) === 1) { const rm = w & 0xF; return { kind: 'end', code: `c.bxWrite(${reg(rm)}); c.pc = c.npc;` }; }
      return null;
    }
    // data processing
    const opc = (w >>> 21) & 0xF, S = (w >>> 20) & 1, rn = (w >>> 16) & 0xF, rd = (w >>> 12) & 0xF;
    if (rd === 15 && !(S && opc >= 8 && opc <= 11)) return null;   // writes PC: fallback
    const b = op2(w, a);
    if (!b) return null;
    const A = reg(rn), B = 'b';
    const nz = 'c.N = v >>> 31; c.Z = v === 0 ? 1 : 0;';
    let body;
    switch (opc) {
      case 0: case 1: case 12: case 13: case 14: case 15: {
        const e = { 0: `${A} & ${B}`, 1: `${A} ^ ${B}`, 12: `${A} | ${B}`, 13: B, 14: `${A} & ~${B}`, 15: `~${B}` }[opc];
        body = S ? `const b = ${b.v}; const sc = ${b.sc}; const v = ${e}; r[${rd}] = v; ${nz} c.C = sc;` : `const b = ${b.v}; r[${rd}] = ${e};`;
        break;
      }
      case 8: case 9: body = `const b = ${b.v}; const sc = ${b.sc}; const v = ${opc === 8 ? `${A} & ${B}` : `${A} ^ ${B}`}; ${nz} c.C = sc;`; break;
      case 4: body = S ? `const b = ${b.v}; r[${rd}] = c.addc(${A}, b, 0);` : `r[${rd}] = (${A} + ${b.v}) | 0;`; break;
      case 2: body = S ? `const b = ${b.v}; r[${rd}] = c.addc(${A}, ~b, 1);` : `r[${rd}] = (${A} - ${b.v}) | 0;`; break;
      case 3: body = S ? `const b = ${b.v}; r[${rd}] = c.addc(b, ~${A}, 1);` : `r[${rd}] = (${b.v} - ${A}) | 0;`; break;
      case 5: body = S ? `const b = ${b.v}; r[${rd}] = c.addc(${A}, b, c.C);` : `r[${rd}] = (${A} + ${b.v} + c.C) | 0;`; break;
      case 6: body = S ? `const b = ${b.v}; r[${rd}] = c.addc(${A}, ~b, c.C);` : `r[${rd}] = (${A} + ~${b.v} + c.C) | 0;`; break;
      case 7: body = S ? `const b = ${b.v}; r[${rd}] = c.addc(b, ~${A}, c.C);` : `r[${rd}] = (${b.v} + ~${A} + c.C) | 0;`; break;
      case 10: body = `const b = ${b.v}; c.addc(${A}, ~b, 1);`; break;
      case 11: body = `const b = ${b.v}; c.addc(${A}, b, 0);`; break;
    }
    return { kind: 'seq', code: `{ ${body} }` };
  }
  if (op1 === 2 || (op1 === 3 && !(w & 0x10))) {             // LDR/STR/LDRB/STRB
    const P = (w >>> 24) & 1, U = (w >>> 23) & 1, B = (w >>> 22) & 1, W = (w >>> 21) & 1, L = (w >>> 20) & 1;
    const rn = (w >>> 16) & 0xF, rt = (w >>> 12) & 0xF;
    let off;
    if (op1 === 2) off = String(w & 0xFFF);
    else {
      const rm = w & 0xF, type = (w >>> 5) & 3, n = (w >>> 7) & 0x1F;
      if (rm === 15) return null;
      const v = `r[${rm}]`;
      off = [n ? `(${v} << ${n})` : v, n ? `((${v} >>> ${n}) | 0)` : '0', n ? `(${v} >> ${n})` : `(${v} >> 31)`,
        n ? `(((${v} >>> ${n}) | (${v} << ${32 - n})) | 0)` : `((c.C << 31) | (${v} >>> 1))`][type];
    }
    const ld = L ? (B ? 'c.ld8(ad)' : 'c.ld32(ad)') : null, st = L ? null : (B ? 'c.st8(ad, VAL)' : 'c.st32(ad, VAL)');
    return ls(P, U, W, rn, rt, off, ld, st, a);
  }
  return null;
}

// single load/store with the interpreter's ordering (makeLS)
function ls(P, U, W, rn, rt, off, ld, st, a) {
  if (ld && rt === 15) return null;                           // loads to PC: fallback
  const wb = !P || W;
  if (wb && rn === 15) return null;
  const base = rn === 15 ? String(((a + 8) & ~3) | 0) : `r[${rn}]`;
  const sum = `(${base} ${U ? '+' : '-'} ${off}) | 0`;
  const ad = P ? sum : base;
  if (ld) {
    if (wb) return { kind: 'seq', code: `{ const ad = ${ad}; const nb = ${P ? 'ad' : sum}; const v = ${ld}; r[${rn}] = nb; r[${rt}] = v; }` };
    return { kind: 'seq', code: `{ const ad = ${ad}; r[${rt}] = ${ld}; }` };
  }
  const val = rt === 15 ? String((a + 8) | 0) : `r[${rt}]`;
  if (wb) return { kind: 'store', code: `{ const ad = ${ad}; const nb = ${P ? 'ad' : sum}; ${st.replace('VAL', val)}; r[${rn}] = nb; }` };
  return { kind: 'store', code: `{ const ad = ${ad}; ${st.replace('VAL', val)}; }` };
}

// Compile the block starting at pc (ARM state). Returns a function(c) -> instructions executed, with
// .len = block length and .end = address after the block, or null when nothing can be compiled.
export function compileBlock(cpu, pc, maxLen = MAX_LEN) {
  const F = [];
  const parts = [];
  let a = pc, k = 0;
  for (; k < maxLen; k++, a = (a + 4) >>> 0) {
    const o = (a - DRAM) >>> 0;
    if (o >= cpu.dramSize) break;
    if (cpu.hooks.has(a) || cpu.prehooks.has(a)) break;       // hooked addresses run in the interpreter
    const w = cpu.fetch32(a);
    const cond = w >>> 28;
    const g = cond === 0xF ? null : gen(w, a);
    const next = h(a + 4);
    if (!g) {
      F.push(cpu.decodeA(a));
      parts.push(`r[15] = ${(a + 8) | 0}; c.npc = ${next}; F[${F.length - 1}](c);
  if (c.npc !== ${next}) { c.pc = c.npc; return ${k + 1}; }
  if (c.stop) { c.pc = ${next}; return ${k + 1}; }`);
      continue;
    }
    const guard = cond === 0xE ? (s) => s : (s) => `if (${COND[cond]}) { ${s} }`;
    if (g.kind === 'end') {
      if (cond === 0xE) { parts.push(`r[15] = ${(a + 8) | 0}; c.npc = ${next}; ${g.code} return ${k + 1};`); k++; break; }
      parts.push(`r[15] = ${(a + 8) | 0}; c.npc = ${next}; if (${COND[cond]}) { ${g.code} return ${k + 1}; }`);
      parts.push(`c.pc = ${next}; return ${k + 1};`); k++;
      return finish(parts, F, pc, k, next);
    }
    parts.push(`r[15] = ${(a + 8) | 0}; ` + guard(g.code));
    if (g.kind === 'store') parts.push(`if (c.stop) { c.pc = ${next}; return ${k + 1}; }`);
  }
  if (k === 0) return null;
  const lastIsEnd = parts.length && /return \d+;\s*$/.test(parts[parts.length - 1]) && !/if \(c\.stop\)/.test(parts[parts.length - 1]) && !/F\[/.test(parts[parts.length - 1]);
  if (!lastIsEnd) parts.push(`c.pc = ${h(a)}; return ${k};`);
  return finish(parts, F, pc, k, h(a));
}

function finish(parts, F, pc, len, end) {
  const src = `return function block_${(pc >>> 0).toString(16)}(c) {\n  const r = c.r;\n  ${parts.join('\n  ')}\n};`;
  // eslint-disable-next-line no-new-func
  const fn = new Function('F', src)(F);
  fn.len = len;
  fn.start = pc;
  return fn;
}
