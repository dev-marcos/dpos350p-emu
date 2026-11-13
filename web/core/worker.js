// Web Worker: owns the emulated machine and runs it off the UI thread.
// Protocol (page -> worker): {t, ...}; replies carry the request id when the page waits for them.
import { Machine, symbolTable } from './machine.js';
import { Fat, mkfsFat32 } from './fat.js';
import { appFromUpload } from './iso.js';
import { readGen } from './genwave.js';

const INSNS_PER_SECOND = 48e6;                  // emulated time: 0.5 OSC tick per instruction (board.ticksPerInsn)
let m = null, app = null, appInfo = null;
let sd = new Uint8Array(64 << 20);
let symbols = null;
let running = false, paused = false;
let opts = { factoryDone: true, bypassCalibration: false };
let speed = 0;                                  // 0 = as fast as possible, else multiple of real time
let lastFrame = 0, lastStatus = 0, mips = 0, tMips = 0, iMips = 0, lastGen = 0, genKey = '';
let paceT0 = 0, paceI0 = 0;
let sdDirty = false;
const keep = { channels: null, battery: 4100, charging: false, audioVolts: 1 };

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

function makeMachine() {
  if (!app) return;
  if (m) { keep.channels = m.dev.frontend.ch; keep.battery = m.dev.batteryMv; keep.charging = m.dev.charging; keep.audioVolts = m.dev.frontend.audioVolts; }
  m = new Machine(app, { sdImage: sd, symbols, ...opts });
  if (keep.channels) m.dev.frontend.ch = keep.channels;
  m.dev.batteryMv = keep.battery; m.dev.charging = keep.charging; m.dev.frontend.audioVolts = keep.audioVolts;
  const mmc = m.dev.mmc0, orig = mmc.cmd.bind(mmc);
  mmc.cmd = (v) => { const idx = v & 0x3F; if (idx === 24 || idx === 25) sdDirty = true; orig(v); };
  running = true;
  paceT0 = performance.now(); paceI0 = 0;
}

// zero-delay yield (setTimeout is clamped to >= 4 ms when nested)
const chan = new MessageChannel();
chan.port1.onmessage = () => step();
const yieldNext = () => chan.port2.postMessage(0);
let loopStarted = false;

function step() {
  const t0 = performance.now();
  if (m && running && !paused && !m.error) {
    const budgetEnd = t0 + 14;
    while (performance.now() < budgetEnd) {
      if (speed > 0) {
        const allowed = paceI0 + (performance.now() - paceT0) / 1000 * INSNS_PER_SECOND * speed;
        if (m.cpu.insns >= allowed) break;
      }
      m.boot(1000000);
      if (m.error) { post({ t: 'error', error: m.error }); break; }
    }
  }
  const now = performance.now();
  if (m && now - lastFrame >= 66) { lastFrame = now; sendFrame(); }
  if (now - lastStatus >= 500) { lastStatus = now; sendStatus(now); }
  if (m && now - lastGen >= 50) { lastGen = now; const g = readGen(m); const key = JSON.stringify(g); if (key !== genKey) { genKey = key; post({ t: 'gen', g }); } }
  const idle = !m || !running || paused || m.error;
  if (idle || (speed > 0 && m.cpu.insns >= paceI0 + (now - paceT0) / 1000 * INSNS_PER_SECOND * speed)) setTimeout(step, idle ? 50 : 4);
  else yieldNext();
}

function sendFrame() {
  const fb = m.framebuffer();
  if (!fb) return;
  const buf = fb.data.slice();                  // copy (transferable)
  post({ t: 'frame', w: fb.w, h: fb.h, pitch: fb.pitch, buf: buf.buffer }, [buf.buffer]);
}

function sendStatus(now) {
  if (m) {
    if (tMips) mips = (m.cpu.insns - iMips) / ((now - tMips) / 1000) / 1e6;
    tMips = now; iMips = m.cpu.insns;
  }
  post({ t: 'status', s: status() });
}

function status() {
  if (!m) return { loaded: !!app, image: appInfo };
  const d = m.dev;
  return {
    loaded: true, running: running && !paused, paused, error: m.error, insns: m.cpu.insns, mips: +mips.toFixed(1),
    irqs: m.irqs, csiFrames: d.csi.frames, pc: m.sym(m.cpu.pc), image: appInfo, batteryMv: d.batteryMv, charging: d.charging,
    factoryDone: opts.factoryDone, channels: d.frontend.ch, audioVolts: d.frontend.audioVolts, touchReads: d.touch.reads,
    speed, emuSeconds: +(m.cpu.insns / INSNS_PER_SECOND).toFixed(1), sdDirty, gen: readGen(m),
  };
}

function devInfo() {
  if (!m) return {};
  const d = m.dev;
  const hex = (v, n = 8) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(n, '0');
  return {
    unmodelled: [...m.unmodelled.values()].sort((a, b) => b.count - a.count).slice(0, 40)
      .map((e) => ({ op: e.op, addr: hex(e.addr), size: e.size * 8, count: e.count, first: m.sym(e.first) })),
    hot: [...m.hot.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([where, samples]) => ({ where, samples })),
    gic: Object.fromEntries(d.gic.counts),
    fpgaReads: Object.fromEntries([...d.fpga.reads.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [hex(k, 2), v])),
    flashReads: d.flash.reads, sdCommands: d.mmc0.commands,
    regs: [...m.cpu.r].map((v) => hex(v)), cpsr: hex(m.cpu.cpsr),
    uart: d.uartText().slice(-4000),
  };
}

// ---------------------------------------------------------------- snapshots
// Device state as plain data. Cross references between devices (and to the machine) are kept once:
// an object already visited is skipped, so restoring assigns into the existing objects.
const isRecord = (v) => v && typeof v === 'object' && !ArrayBuffer.isView(v) && !(v instanceof Map) && !(v instanceof Set) && !Array.isArray(v);
function plain(o, seen) {
  seen.add(o);
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'function' || k === 'img') continue;          // the SD image is kept separately
    if (isRecord(v)) { if (!seen.has(v)) out[k] = plain(v, seen); }
    else out[k] = structuredClone(v);
  }
  return out;
}
function assign(target, src) {
  for (const [k, v] of Object.entries(src)) {
    const cur = target[k];
    if (cur && typeof cur === 'object' && !ArrayBuffer.isView(cur) && !(cur instanceof Map) && !(cur instanceof Set) && !Array.isArray(cur) && v && typeof v === 'object') assign(cur, v);
    else if (ArrayBuffer.isView(cur) && ArrayBuffer.isView(v) && cur.length === v.length) cur.set(v);
    else target[k] = v;
  }
}
async function gzip(u8) {
  const s = new Blob([u8]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
async function gunzip(u8) {
  const s = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
async function snapshotSave() {
  const c = m.cpu;
  const cpu = {
    r: c.r.slice(), cpsr: c.cpsr, mode: c.mode, bankR13: c.bankR13.slice(), bankR14: c.bankR14.slice(), spsrs: c.spsrs.slice(),
    fiqR: c.fiqR.slice(), usrR: c.usrR.slice(), pc: c.pc, v32: c.v32.slice(), fpscr: c.fpscr, fpexc: c.fpexc, cp15: new Map(c.cp15), insns: c.insns,
  };
  const mem = {};
  for (const k of ['dram', 'sram', 'hivec', 'mmio']) mem[k] = await gzip(m[k]);
  return { version: 1, appSha: appInfo && appInfo.sha, cpu, mem, dev: plain(m.dev, new Set([m])), irqs: m.irqs, started: m.started, opts };
}
async function snapshotLoad(s) {
  opts = s.opts || opts;
  makeMachine();
  for (const k of ['dram', 'sram', 'hivec', 'mmio']) m[k].set(await gunzip(s.mem[k]));
  const c = m.cpu;
  c.mode = s.cpu.mode; c.r.set(s.cpu.r); c.bankR13.set(s.cpu.bankR13); c.bankR14.set(s.cpu.bankR14); c.spsrs.set(s.cpu.spsrs);
  c.fiqR.set(s.cpu.fiqR); c.usrR.set(s.cpu.usrR);
  c.setCpsr(s.cpu.cpsr, 0xE); c.I = (s.cpu.cpsr >>> 7) & 1; c.F = (s.cpu.cpsr >>> 6) & 1; c.T = (s.cpu.cpsr >>> 5) & 1; c.mode = s.cpu.mode;
  c.it = (((s.cpu.cpsr >>> 25) & 3) | (((s.cpu.cpsr >>> 10) & 0x3F) << 2));
  c.pc = s.cpu.pc; c.v32.set(s.cpu.v32); c.fpscr = s.cpu.fpscr; c.fpexc = s.cpu.fpexc; c.cp15 = new Map(s.cpu.cp15); c.insns = s.cpu.insns;
  c.flushDecodes();
  assign(m.dev, s.dev);
  m.irqs = s.irqs; m.started = s.started;
  paceT0 = performance.now(); paceI0 = c.insns;
}

// ---------------------------------------------------------------- file manager
function fs(op, p, data) {
  if (op === 'format') { mkfsFat32(sd); sdDirty = true; return { ok: true }; }
  const f = new Fat(sd);
  switch (op) {
    case 'list': return { path: p, entries: f.listdir(p), type: f.type, clusterSize: f.csize };
    case 'read': return { data: f.read(p) };
    case 'write': f.write(p, new Uint8Array(data)); sdDirty = true; return { ok: true };
    case 'mkdir': f.mkdir(p); sdDirty = true; return { ok: true };
    case 'delete': f.delete(p); sdDirty = true; return { ok: true };
  }
  throw new Error(`unknown fs op ${op}`);
}

// ---------------------------------------------------------------- messages
self.onmessage = async (ev) => {
  const q = ev.data;
  const reply = (r, transfer) => post({ t: 'reply', id: q.id, ...r }, transfer);
  try {
    switch (q.t) {
      case 'init':
        if (q.sd) sd = new Uint8Array(q.sd);
        if (q.symbols) symbols = symbolTable(q.symbols);
        if (q.opts) opts = { ...opts, ...q.opts };
        if (q.app) { app = new Uint8Array(q.app); appInfo = q.info; makeMachine(); }
        if (!loopStarted) { loopStarted = true; step(); }
        reply({ ok: true, status: status() });
        break;
      case 'firmware': {
        const { app: a, kind } = appFromUpload(new Uint8Array(q.data), q.name);
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', a));
        const sha = [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
        app = a; appInfo = { source: `${q.name} (${kind})`, size: a.length, sha };
        makeMachine();
        reply({ ok: true, app: a.slice().buffer, info: appInfo });
        break;
      }
      case 'control':
        if (q.action === 'pause') paused = true;
        else if (q.action === 'resume') { paused = false; paceT0 = performance.now(); paceI0 = m ? m.cpu.insns : 0; }
        else if (q.action === 'reset') { makeMachine(); paused = false; }
        else if (q.action === 'speed') { speed = +q.value || 0; paceT0 = performance.now(); paceI0 = m ? m.cpu.insns : 0; }
        else if (q.action === 'factory') opts.factoryDone = !!q.value;
        reply({ ok: true, status: status() });
        break;
      case 'touch': if (m) m.dev.touch.event(q.kind, q.x, q.y); break;
      case 'channel': if (m) Object.assign(m.dev.frontend.ch[q.ch], q.values); reply({ ok: true }); break;
      case 'audio': if (m) { m.dev.frontend.pushAudio(new Float32Array(q.samples)); if (q.volts) m.dev.frontend.audioVolts = q.volts; if (q.rate) m.dev.frontend.audioRate = q.rate; } break;
      case 'battery': if (m) { if (q.mv !== undefined) m.dev.batteryMv = +q.mv; if (q.charging !== undefined) m.dev.charging = !!q.charging; } reply({ ok: true }); break;
      case 'fs': { const r = fs(q.op, q.path, q.data); const tr = r.data ? [r.data.buffer] : []; reply({ ok: true, ...r, data: r.data ? r.data.buffer : undefined }, tr); break; }
      case 'getSd': { sdDirty = false; const copy = sd.slice(); reply({ ok: true, sd: copy.buffer }, [copy.buffer]); break; }
      case 'dev': reply({ ok: true, info: devInfo() }); break;
      case 'peek': { const b = m.readBytes(q.addr >>> 0, Math.min(q.n || 64, 4096)); reply({ ok: true, data: [...b] }); break; }
      case 'poke': m.writeBytes(q.addr >>> 0, new Uint8Array(q.data)); reply({ ok: true }); break;
      case 'snapshotSave': { const s = await snapshotSave(); reply({ ok: true, snapshot: s }); break; }
      case 'snapshotLoad': await snapshotLoad(q.snapshot); reply({ ok: true }); break;
      default: reply({ ok: false, error: `unknown message ${q.t}` });
    }
  } catch (e) {
    reply({ ok: false, error: String(e && e.message || e) });
  }
};
