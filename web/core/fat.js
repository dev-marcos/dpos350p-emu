// Minimal FAT12/16/32 access to the emulated SD-card image (port of fat.py): list, read, write with
// long names, delete, mkdir, FAT32 format. The volume may start at sector 0 or at the first MBR
// partition. The firmware caches the file system: reset the device after changing the card.

export class FatError extends Error {}

const dv = (img) => new DataView(img.buffer, img.byteOffset, img.byteLength);

export class Fat {
  constructor(img) {
    this.img = img; this.v = dv(img);
    this.base = this.findVolume();
    const b = this.base, v = this.v;
    this.bps = v.getUint16(b + 11, true);
    if (![512, 1024, 2048, 4096].includes(this.bps)) throw new FatError('no FAT volume (blank card: let the firmware format it first)');
    this.spc = img[b + 13]; this.rsvd = v.getUint16(b + 14, true); this.nfats = img[b + 16]; this.nroot = v.getUint16(b + 17, true);
    const tot = v.getUint16(b + 19, true) || v.getUint32(b + 32, true);
    const fsz = v.getUint16(b + 22, true) || v.getUint32(b + 36, true);
    this.fatsz = fsz;
    this.fat0 = b + this.rsvd * this.bps;
    const rootSecs = Math.floor((this.nroot * 32 + this.bps - 1) / this.bps);
    this.root0 = this.fat0 + this.nfats * fsz * this.bps;
    this.data0 = this.root0 + rootSecs * this.bps;
    this.ncl = Math.floor((tot - (this.rsvd + this.nfats * fsz + rootSecs)) / this.spc);
    this.type = this.ncl < 4085 ? 12 : this.ncl < 65525 ? 16 : 32;
    this.rootCl = this.type === 32 ? v.getUint32(b + 44, true) : 0;
    this.csize = this.spc * this.bps;
  }
  findVolume() {
    const img = this.img;
    if (img.length < 1024 || img[510] !== 0x55 || img[511] !== 0xAA) throw new FatError('no boot sector (blank card: let the firmware format it first)');
    if ((img[0] === 0xEB || img[0] === 0xE9) && [512, 1024, 2048, 4096].includes(this.v.getUint16(11, true))) return 0;
    const lba = this.v.getUint32(446 + 8, true);
    if (!lba) throw new FatError('no FAT volume found');
    return lba * 512;
  }
  get(n) {
    const v = this.v;
    if (this.type === 32) return v.getUint32(this.fat0 + 4 * n, true) & 0x0FFFFFFF;
    if (this.type === 16) return v.getUint16(this.fat0 + 2 * n, true);
    const x = v.getUint16(this.fat0 + n + (n >> 1), true);
    return n & 1 ? x >> 4 : x & 0xFFF;
  }
  set(n, val) {
    const v = this.v;
    for (let k = 0; k < this.nfats; k++) {
      const o = this.fat0 + k * this.fatsz * this.bps;
      if (this.type === 32) v.setUint32(o + 4 * n, ((v.getUint32(o + 4 * n, true) & 0xF0000000) | (val & 0x0FFFFFFF)) >>> 0, true);
      else if (this.type === 16) v.setUint16(o + 2 * n, val & 0xFFFF, true);
      else { const p = o + n + (n >> 1), old = v.getUint16(p, true); v.setUint16(p, n & 1 ? (old & 0x000F) | (val << 4) : (old & 0xF000) | (val & 0xFFF), true); }
    }
  }
  eoc(v) { return v >= { 12: 0xFF8, 16: 0xFFF8, 32: 0x0FFFFFF8 }[this.type]; }
  chain(cl) { const out = []; while (cl >= 2 && cl < this.ncl + 2 && !this.eoc(cl) && out.length < this.ncl) { out.push(cl); cl = this.get(cl); } return out; }
  alloc(n) {
    const free = [];
    for (let c = 2; c < this.ncl + 2 && free.length < n; c++) if (this.get(c) === 0) free.push(c);
    if (free.length < n) throw new FatError('card full');
    free.forEach((c, i) => this.set(c, i + 1 < free.length ? free[i + 1] : 0x0FFFFFFF));
    return free;
  }
  freeChain(cl) { for (const c of this.chain(cl)) this.set(c, 0); }
  clOff(cl) { return this.data0 + (cl - 2) * this.csize; }
  *dirSlots(cl) {
    if (cl === 0 && this.type !== 32) { for (let i = 0; i < this.nroot; i++) yield this.root0 + 32 * i; return; }
    for (const c of this.chain(cl || this.rootCl)) { const base = this.clOff(c); for (let i = 0; i < this.csize / 32; i++) yield base + 32 * i; }
  }
  *entries(cl) {
    const img = this.img, v = this.v;
    let lfn = new Map();
    for (const off of this.dirSlots(cl)) {
      const e0 = img[off], attr = img[off + 11];
      if (e0 === 0) return;
      if (e0 === 0xE5) { lfn = new Map(); continue; }
      if (attr === 0x0F) {
        const seq = e0 & 0x1F, u = [];
        for (const [a, b] of [[1, 11], [14, 26], [28, 32]]) for (let i = a; i < b; i += 2) u.push(v.getUint16(off + i, true));
        let s = ''; for (const ch of u) { if (ch === 0 || ch === 0xFFFF) break; s += String.fromCharCode(ch); }
        lfn.set(seq, s); continue;
      }
      if (attr & 0x08) { lfn = new Map(); continue; }
      const nm = String.fromCharCode(...img.subarray(off, off + 8)).trimEnd(), ex = String.fromCharCode(...img.subarray(off + 8, off + 11)).trimEnd();
      const short = nm + (ex ? '.' + ex : '');
      const name = lfn.size ? [...lfn.keys()].sort((a, b) => a - b).map((k) => lfn.get(k)).join('') : short;
      lfn = new Map();
      if (name === '.' || name === '..') continue;
      const hi = this.type === 32 ? v.getUint16(off + 20, true) : 0;
      const d = v.getUint16(off + 24, true), t = v.getUint16(off + 22, true);
      const p2 = (x) => String(x).padStart(2, '0');
      const time = d ? `${1980 + (d >> 9)}-${p2((d >> 5) & 15)}-${p2(d & 31)} ${p2(t >> 11)}:${p2((t >> 5) & 63)}` : '';
      yield { name, short, dir: !!(attr & 0x10), size: v.getUint32(off + 28, true), cluster: (hi << 16) | v.getUint16(off + 26, true), time, offset: off };
    }
  }
  resolve(path) {
    let cl = 0, ent = null;
    for (const part of path.split('/').filter(Boolean)) {
      let found = null;
      for (const e of this.entries(cl)) if (e.name.toLowerCase() === part.toLowerCase() || e.short.toLowerCase() === part.toLowerCase()) { found = e; break; }
      if (!found) throw new FatError(`not found: ${path}`);
      ent = found; cl = found.cluster;
    }
    return [cl, ent];
  }
  listdir(path = '/') {
    const [cl, ent] = this.resolve(path);
    if (ent && !ent.dir) throw new FatError('not a directory');
    return [...this.entries(cl)].map(({ name, dir, size, time }) => ({ name, dir, size, time }));
  }
  read(path) {
    const [, ent] = this.resolve(path);
    if (!ent || ent.dir) throw new FatError('not a file');
    const out = new Uint8Array(ent.size); let pos = 0;
    for (const c of this.chain(ent.cluster)) { const n = Math.min(this.csize, ent.size - pos); if (n <= 0) break; out.set(this.img.subarray(this.clOff(c), this.clOff(c) + n), pos); pos += n; }
    return out;
  }
  delete(path) {
    const [, ent] = this.resolve(path);
    if (!ent) throw new FatError('cannot delete the root');
    if (ent.dir && !this.entries(ent.cluster).next().done) throw new FatError('directory not empty');
    this.freeChain(ent.cluster);
    this.markDeleted(ent.offset);
  }
  markDeleted(off) {
    this.img[off] = 0xE5;
    for (let o = off - 32; o >= 0 && this.img[o + 11] === 0x0F && this.img[o] !== 0xE5; o -= 32) this.img[o] = 0xE5;
  }
  write(path, data) {
    const [parent, name] = Fat.split(path);
    const [pcl] = this.resolve(parent);
    let old = null;
    try { old = this.resolve(path)[1]; } catch (e) { old = null; }
    if (old) { if (old.dir) throw new FatError('is a directory'); this.freeChain(old.cluster); this.markDeleted(old.offset); }
    const n = Math.ceil(data.length / this.csize);
    const cls = n ? this.alloc(n) : [];
    cls.forEach((c, i) => { const o = this.clOff(c); this.img.fill(0, o, o + this.csize); this.img.set(data.subarray(i * this.csize, (i + 1) * this.csize), o); });
    this.addEntry(pcl, name, 0x20, cls.length ? cls[0] : 0, data.length);
  }
  mkdir(path) {
    const [parent, name] = Fat.split(path);
    const [pcl] = this.resolve(parent);
    const c = this.alloc(1)[0], o = this.clOff(c);
    this.img.fill(0, o, o + this.csize);
    this.img.set(this.rawEntry('.          ', 0x10, c, 0), o);
    this.img.set(this.rawEntry('..         ', 0x10, pcl, 0), o + 32);
    this.addEntry(pcl, name, 0x10, c, 0);
  }
  static split(path) {
    const parts = path.split('/').filter(Boolean);
    if (!parts.length) throw new FatError('bad path');
    return ['/' + parts.slice(0, -1).join('/'), parts[parts.length - 1]];
  }
  rawEntry(name11, attr, cl, size) {
    const t = new Date();
    const d = ((t.getFullYear() - 1980) << 9) | ((t.getMonth() + 1) << 5) | t.getDate();
    const tm = (t.getHours() << 11) | (t.getMinutes() << 5) | (t.getSeconds() >> 1);
    const e = new Uint8Array(32), v = dv(e);
    for (let i = 0; i < 11; i++) e[i] = name11.charCodeAt(i);
    e[11] = attr;
    v.setUint16(14, tm, true); v.setUint16(16, d, true); v.setUint16(18, d, true);
    v.setUint16(20, (cl >>> 16) & 0xFFFF, true); v.setUint16(22, tm, true); v.setUint16(24, d, true);
    v.setUint16(26, cl & 0xFFFF, true); v.setUint32(28, size, true);
    return e;
  }
  shortName(pcl, name) {
    const bad = ' "*+,/:;<=>?[\\]|';
    const up = name.toUpperCase();
    const dot = up.lastIndexOf('.');
    let base = dot >= 0 ? up.slice(0, dot) : up, ext = dot >= 0 ? up.slice(dot + 1) : '';
    const clean = (s) => [...s.replace(/ /g, '')].map((ch) => (ch.charCodeAt(0) < 0x7F && ch.charCodeAt(0) > 0x20 && !bad.includes(ch)) ? ch : '_').join('');
    base = clean(base); ext = clean(ext).slice(0, 3);
    if (base.length <= 8 && name === base + (ext ? '.' + ext : '')) return [base.padEnd(8) + ext.padEnd(3), false];
    const existing = new Set([...this.entries(pcl)].map((e) => e.short.toUpperCase()));
    for (let i = 1; i < 1000; i++) {
      const tail = `~${i}`, b = base.slice(0, 8 - tail.length) + tail;
      if (!existing.has(b + (ext ? '.' + ext : ''))) return [b.padEnd(8) + ext.padEnd(3), true];
    }
    throw new FatError('too many similar names');
  }
  addEntry(pcl, name, attr, cl, size) {
    const [sname, needLfn] = this.shortName(pcl, name);
    let slots = [this.rawEntry(sname, attr, cl, size)];
    if (needLfn) {
      let csum = 0; for (let i = 0; i < 11; i++) csum = ((((csum & 1) << 7) + (csum >> 1) + sname.charCodeAt(i)) & 0xFF);
      const u = []; for (const ch of name) u.push(ch.charCodeAt(0)); u.push(0);
      while (u.length % 13) u.push(0xFFFF);
      const lfn = [];
      for (let p = 0; p < u.length / 13; p++) {
        const e = new Uint8Array(32), v = dv(e), part = u.slice(13 * p, 13 * p + 13);
        e[0] = (p + 1) | (p + 1 === u.length / 13 ? 0x40 : 0); e[11] = 0x0F; e[13] = csum;
        const pos = [1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30];
        part.forEach((ch, i) => v.setUint16(pos[i], ch, true));
        lfn.push(e);
      }
      slots = lfn.reverse().concat(slots);
    }
    const free = this.findFree(pcl, slots.length);
    free.forEach((off, i) => this.img.set(slots[i], off));
  }
  findFree(cl, n) {
    let run = [];
    for (const off of this.dirSlots(cl)) {
      const e0 = this.img[off];
      if (e0 === 0 || e0 === 0xE5) { run.push(off); if (run.length === n) return run; } else run = [];
    }
    if (cl === 0 && this.type !== 32) throw new FatError('root directory full');
    const ch = this.chain(cl || this.rootCl), last = ch[ch.length - 1];
    const c = this.alloc(1)[0];
    this.set(last, c);
    const o = this.clOff(c);
    this.img.fill(0, o, o + this.csize);
    for (let i = 0; run.length < n; i++) run.push(o + 32 * i);
    return run;
  }
}

export function mkfsFat32(img, label = 'DSO350     ') {
  const n = Math.floor(img.length / 512);
  const spc = n <= 0x40000 ? 1 : 8, rsvd = 32, nfats = 2;
  let fatsz = 1, ncl;
  for (;;) { ncl = Math.floor((n - rsvd - nfats * fatsz) / spc); const need = Math.ceil((ncl + 2) * 4 / 512); if (need <= fatsz) break; fatsz = need; }
  if (ncl < 65525) throw new FatError('card too small for FAT32');
  img.fill(0);
  const bs = new Uint8Array(512), v = dv(bs);
  bs.set([0xEB, 0x58, 0x90], 0); bs.set([...'MSDOS5.0'].map((c) => c.charCodeAt(0)), 3);
  v.setUint16(11, 512, true); bs[13] = spc; v.setUint16(14, rsvd, true); bs[16] = nfats; bs[21] = 0xF8;
  v.setUint16(24, 63, true); v.setUint16(26, 255, true); v.setUint32(32, n, true);
  v.setUint32(36, fatsz, true); v.setUint32(44, 2, true); v.setUint16(48, 1, true); v.setUint16(50, 6, true);
  bs[64] = 0x80; bs[66] = 0x29; v.setUint32(67, (Date.now() / 1000) >>> 0, true);
  bs.set([...label.padEnd(11).slice(0, 11)].map((c) => c.charCodeAt(0)), 71);
  bs.set([...'FAT32   '].map((c) => c.charCodeAt(0)), 82);
  bs[510] = 0x55; bs[511] = 0xAA;
  const fsinfo = new Uint8Array(512), fv = dv(fsinfo);
  fv.setUint32(0, 0x41615252, true); fv.setUint32(484, 0x61417272, true); fv.setUint32(488, ncl - 1, true); fv.setUint32(492, 3, true); fv.setUint32(508, 0xAA550000, true);
  for (const base of [0, 6 * 512]) { img.set(bs, base); img.set(fsinfo, base + 512); }
  const iv = dv(img);
  for (let k = 0; k < nfats; k++) { const o = (rsvd + k * fatsz) * 512; iv.setUint32(o, 0x0FFFFFF8, true); iv.setUint32(o + 4, 0x0FFFFFFF, true); iv.setUint32(o + 8, 0x0FFFFFFF, true); }
  return { clusters: ncl, clusterSize: spc * 512 };
}
