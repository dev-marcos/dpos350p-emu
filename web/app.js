// DSO-350 emulator front end. Everything runs in this browser: the machine runs in a Web Worker
// (core/worker.js); the firmware, the SD-card image and saved states are kept in IndexedDB.
// UI strings come from i18n.js (t()).
"use strict";
const $ = (s) => document.querySelector(s);

// ---------------------------------------------------------------- storage (IndexedDB key/value)
const db = new Promise((res, rej) => {
  const r = indexedDB.open("dso350-emu", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("kv");
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const kvGet = async (k) => { const d = await db; return new Promise((res, rej) => { const q = d.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); };
const kvSet = async (k, v) => { const d = await db; return new Promise((res, rej) => { const t2 = d.transaction("kv", "readwrite"); t2.objectStore("kv").put(v, k); t2.oncomplete = () => res(); t2.onerror = () => rej(t2.error); }); };
const kvDel = async (k) => { const d = await db; return new Promise((res) => { const t2 = d.transaction("kv", "readwrite"); t2.objectStore("kv").delete(k); t2.oncomplete = () => res(); }); };

// ---------------------------------------------------------------- worker
const worker = new Worker("core/worker.js", { type: "module" });
let nextId = 1;
const waiting = new Map();
const call = (msg, transfer) => new Promise((res, rej) => {
  const id = nextId++;
  waiting.set(id, { res, rej });
  worker.postMessage({ ...msg, id }, transfer || []);
});
const send = (msg, transfer) => worker.postMessage(msg, transfer || []);
let status = {};
worker.onmessage = (ev) => {
  const m = ev.data;
  if (m.t === "reply") {
    const w = waiting.get(m.id); waiting.delete(m.id);
    if (!w) return;
    if (m.ok === false) w.rej(new Error(m.error)); else w.res(m);
  } else if (m.t === "frame") drawFrame(m);
  else if (m.t === "status") { status = m.s; renderStatus(); }
  else if (m.t === "error") { status.error = m.error; renderStatus(); }
};
worker.onerror = (e) => { $("#stat").textContent = t("stat.workerError", { err: e.message }); };

// ---------------------------------------------------------------- screen + touch
const canvas = $("#screen"), ctx2d = canvas.getContext("2d");
let img = null;
function drawFrame({ w, h, pitch, buf }) {
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; img = null; }
  if (!img) img = ctx2d.createImageData(w, h);
  const src = new Uint16Array(buf, 0, (pitch * h) >> 1), dst = new Uint32Array(img.data.buffer), stride = pitch >> 1;
  for (let y = 0; y < h; y++) {
    let s = y * stride, d = y * w;
    for (let x = 0; x < w; x++, s++, d++) {
      const v = src[s];
      const r = (v >> 11) << 3, g = ((v >> 5) & 0x3F) << 2, b = (v & 0x1F) << 3;
      dst[d] = 0xFF000000 | (b << 16) | (g << 8) | r;
    }
  }
  ctx2d.putImageData(img, 0, 0);
  $("#noFw").hidden = true;
}
function screenPos(e) {
  const r = canvas.getBoundingClientRect();
  return { x: Math.round((e.clientX - r.left) * canvas.width / r.width), y: Math.round((e.clientY - r.top) * canvas.height / r.height) };
}
let pressing = false, lastMove = 0;
canvas.addEventListener("pointerdown", (e) => {
  pressing = true;
  try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* synthetic pointer */ }
  send({ t: "touch", kind: "down", ...screenPos(e) }); e.preventDefault();
});
canvas.addEventListener("pointermove", (e) => { if (!pressing || Date.now() - lastMove < 30) return; lastMove = Date.now(); send({ t: "touch", kind: "move", ...screenPos(e) }); });
const release = (e) => { if (!pressing) return; pressing = false; send({ t: "touch", kind: "up", ...screenPos(e) }); };
canvas.addEventListener("pointerup", release);
canvas.addEventListener("pointercancel", release);

// ---------------------------------------------------------------- top bar
$("#btnRun").onclick = async () => { status = (await call({ t: "control", action: status.paused ? "resume" : "pause" })).status; renderStatus(); };
$("#btnReset").onclick = async () => { status = (await call({ t: "control", action: "reset" })).status; renderStatus(); };
$("#btnShot").onclick = () => canvas.toBlob((b) => { const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = "dso350-screen.png"; a.click(); });
$("#speed").onchange = (e) => call({ t: "control", action: "speed", value: +e.target.value });
$("#lang").value = LANG;
$("#lang").onchange = (e) => setLang(e.target.value);
document.addEventListener("langchange", () => { chBuilt = false; renderStatus(); loadDir(cwd); listAudio().catch(() => {}); if ($("#pane-dev").classList.contains("active")) loadDev(); });

function fmtInsns(n) { return n >= 1e9 ? (n / 1e9).toFixed(2) + " G" : (n / 1e6).toFixed(0) + " M"; }
function renderStatus() {
  const s = status;
  // the side LEDs light while the device is powered (firmware loaded and running)
  $("#device").classList.toggle("on", !!(s.loaded && s.running && !s.error));
  if (!s.loaded) { $("#stat").textContent = t("stat.none"); $("#noFw").hidden = false; $("#btnRun").textContent = t("btn.pause"); return; }
  $("#btnRun").textContent = s.paused ? t("btn.resume") : t("btn.pause");
  $("#stat").textContent = s.error ? t("stat.stopped", { err: s.error }) : t("stat.run", { insns: fmtInsns(s.insns || 0), mips: s.mips, emu: s.emuSeconds, irqs: s.irqs });
  const fw = s.image || {};
  $("#fwInfo").innerHTML = `<span>${t("sys.source")}</span><span>${esc(fw.source || "—")}</span><span>${t("sys.size")}</span><span>${fw.size || "—"}</span><span>SHA-256</span><span>${fw.sha ? fw.sha + "…" : "—"}</span>`;
  if (s.batteryMv !== undefined && document.activeElement !== $("#batt")) $("#batt").value = s.batteryMv;
  if (s.batteryMv !== undefined) $("#battV").textContent = (s.batteryMv / 1000).toFixed(2) + " V";
  $("#charging").checked = !!s.charging;
  if (s.factoryDone !== undefined) $("#factory").checked = s.factoryDone;
  if (!chBuilt && s.channels) buildChannels(s.channels);
  if (s.sdDirty) saveSdSoon();
}

// ---------------------------------------------------------------- tabs
document.querySelectorAll(".tab").forEach((tb) => tb.onclick = () => {
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === tb));
  document.querySelectorAll(".pane").forEach((p) => p.classList.toggle("active", p.id === "pane-" + tb.dataset.tab));
  if (tb.dataset.tab === "files") loadDir(cwd);
  if (tb.dataset.tab === "dev") loadDev();
});

// ---------------------------------------------------------------- firmware (button + drag & drop); kept in IndexedDB
async function uploadFirmware(file) {
  $("#stat").textContent = t("stat.loading", { name: file.name });
  try {
    const data = await file.arrayBuffer();
    const r = await call({ t: "firmware", data, name: file.name }, [data]);
    await kvSet("firmware", { app: r.app, info: r.info });
    chBuilt = false;
  } catch (e) { alert(t("sys.fwRejected", { err: e.message })); }
}
document.querySelectorAll(".fwFile").forEach((el) => el.onchange = (e) => e.target.files[0] && uploadFirmware(e.target.files[0]));
$("#fwForget").onclick = async () => { if (confirm(t("sys.forgetConfirm"))) { await kvDel("firmware"); location.reload(); } };
const devEl = $("#device"), drop = $("#drop");
devEl.addEventListener("dragover", (e) => { e.preventDefault(); drop.hidden = false; });
devEl.addEventListener("dragleave", () => drop.hidden = true);
devEl.addEventListener("drop", (e) => { e.preventDefault(); drop.hidden = true; const f = e.dataTransfer.files[0]; if (f) uploadFirmware(f); });

// ---------------------------------------------------------------- system pane
$("#batt").oninput = (e) => { $("#battV").textContent = (e.target.value / 1000).toFixed(2) + " V"; };
$("#batt").onchange = (e) => call({ t: "battery", mv: +e.target.value });
$("#charging").onchange = (e) => call({ t: "battery", charging: e.target.checked });
$("#factory").onchange = async (e) => { await call({ t: "control", action: "factory", value: e.target.checked }); await kvSet("factoryDone", e.target.checked); };
$("#snapSave").onclick = async () => {
  $("#snapSave").disabled = true;
  try { const r = await call({ t: "snapshotSave" }); await kvSet("snapshot", r.snapshot); alert(t("sys.snapSaved")); }
  catch (e) { alert(t("sys.snapError", { err: e.message })); }
  $("#snapSave").disabled = false;
};
$("#snapLoad").onclick = async () => {
  const s = await kvGet("snapshot");
  if (!s) return alert(t("sys.noSnap"));
  try { await call({ t: "snapshotLoad", snapshot: s }); } catch (e) { alert(e.message); }
};
$("#sdDownload").onclick = async () => {
  const r = await call({ t: "getSd" });
  await kvSet("sd", r.sd);
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([r.sd])); a.download = "dso350-sdcard.img"; a.click();
};
$("#sdImage").onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  if (!confirm(t("sys.sdConfirm", { name: f.name }))) return;
  await kvSet("sd", await f.arrayBuffer());
  location.reload();
};

// SD image persistence: saved a few seconds after the firmware or the file manager changes it
let sdTimer = null;
function saveSdSoon() {
  if (sdTimer) return;
  sdTimer = setTimeout(async () => { try { const r = await call({ t: "getSd" }); await kvSet("sd", r.sd); } catch (_) { /* ignore */ } sdTimer = null; }, 3000);
}

// ---------------------------------------------------------------- channels
let chBuilt = false;
const WAVES = ["sine", "square", "triangle", "saw", "dc", "noise"];
const PROBES = [1, 10, 100];
function buildChannels(chs) {
  chBuilt = true;
  $("#chForms").innerHTML = chs.map((c, i) => `
    <fieldset class="card ch${i + 1}"><legend>CH${i + 1}</legend>
      <div class="grid2">
        <span>${t("ch.on")}</span><label><input type="checkbox" data-ch="${i}" data-k="on" ${c.on ? "checked" : ""}> ${t("ch.onLabel")}</label>
        <span>${t("ch.source")}</span><select data-ch="${i}" data-k="source"><option value="gen">${t("ch.gen")}</option><option value="audio">${t("ch.audio")}</option></select>
        <span>${t("ch.wave")}</span><select data-ch="${i}" data-k="wave">${WAVES.map((v) => `<option value="${v}">${t("wave." + v)}</option>`).join("")}</select>
        <span>${t("ch.freq")}</span><span><input class="num" type="number" min="0" step="any" data-ch="${i}" data-k="freq" value="${c.freq}"> Hz</span>
        <span>${t("ch.ampl")}</span><span><input class="num" type="number" min="0" step="any" data-ch="${i}" data-k="vpp" value="${c.vpp}"> Vpp</span>
        <span>${t("ch.offset")}</span><span><input class="num" type="number" step="any" data-ch="${i}" data-k="offset" value="${c.offset}"> V</span>
        <span>${t("ch.probe")}</span><span class="seg" data-ch="${i}" data-k="probe">
          ${PROBES.map((p) => `<button data-v="${p}" class="${c.probe == p ? "on" : ""}">${p}x</button>`).join("")}</span>
      </div></fieldset>`).join("");
  chs.forEach((c, i) => { $(`select[data-ch="${i}"][data-k="source"]`).value = c.source; $(`select[data-ch="${i}"][data-k="wave"]`).value = c.wave; });
  document.querySelectorAll("#chForms [data-k]").forEach((el) => {
    if (el.classList.contains("seg")) {
      el.querySelectorAll("button").forEach((b) => b.onclick = () => {
        el.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
        call({ t: "channel", ch: +el.dataset.ch, values: { probe: +b.dataset.v } });
      });
      return;
    }
    el.onchange = () => {
      const v = el.type === "checkbox" ? el.checked : el.type === "number" ? +el.value : el.value;
      call({ t: "channel", ch: +el.dataset.ch, values: { [el.dataset.k]: v } });
    };
  });
}

// ---------------------------------------------------------------- audio input (getUserMedia -> PCM chunks to the worker)
let audioCtx = null, audioNode = null, audioStream = null, pending = [];
async function listAudio() {
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
  const keep = $("#audioDev").value;
  $("#audioDev").innerHTML = devs.map((d, i) => `<option value="${d.deviceId}">${esc(d.label || t("audio.input", { n: i + 1 }))}</option>`).join("") || `<option value=''>${t("audio.none")}</option>`;
  if (keep) $("#audioDev").value = keep;
}
navigator.mediaDevices?.enumerateDevices && listAudio();
$("#audioStart").onclick = async () => {
  try {
    const id = $("#audioDev").value;
    audioStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: id ? { exact: id } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    await listAudio();
    audioCtx = new AudioContext();
    const src = audioCtx.createMediaStreamSource(audioStream);
    audioNode = audioCtx.createScriptProcessor(4096, 1, 1);
    audioNode.onaudioprocess = (ev) => {
      const d = ev.inputBuffer.getChannelData(0);
      pending.push(new Float32Array(d));
      let peak = 0; for (const v of d) peak = Math.max(peak, Math.abs(v));
      $("#audioLevel").style.width = Math.min(100, peak * 100) + "%";
    };
    src.connect(audioNode); audioNode.connect(audioCtx.destination);
    $("#audioStart").disabled = true; $("#audioStop").disabled = false;
  } catch (e) { alert(t("audio.error", { err: e.message })); }
};
$("#audioStop").onclick = () => {
  audioNode?.disconnect(); audioStream?.getTracks().forEach((tr) => tr.stop()); audioCtx?.close();
  audioCtx = audioNode = audioStream = null;
  $("#audioStart").disabled = false; $("#audioStop").disabled = true; $("#audioLevel").style.width = "0";
};
setInterval(() => {
  if (!pending.length) return;
  const n = pending.reduce((a, b) => a + b.length, 0), all = new Float32Array(n);
  let o = 0; for (const p of pending) { all.set(p, o); o += p.length; }
  pending = [];
  send({ t: "audio", samples: all.buffer, volts: +$("#audioVolts").value || 1, rate: audioCtx ? audioCtx.sampleRate : 48000 }, [all.buffer]);
}, 100);

// ---------------------------------------------------------------- file manager (SD card)
let cwd = "/";
const human = (n) => n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB";
const join = (a, b) => (a.endsWith("/") ? a : a + "/") + b;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
async function loadDir(path) {
  try {
    const r = await call({ t: "fs", op: "list", path });
    cwd = path; $("#crumbs").textContent = path; $("#crumbs").title = path;
    const rows = r.entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
    $("#fsList").innerHTML = rows.map((e) => `<tr>
      <td class="name" data-dir="${e.dir ? 1 : 0}" data-name="${encodeURIComponent(e.name)}">${e.dir ? "📁" : "📄"} ${esc(e.name)}</td>
      <td class="r">${e.dir ? "" : human(e.size)}</td><td>${e.time}</td>
      <td class="act"><button data-del="${encodeURIComponent(e.name)}" title="${t("fs.delete")}">✕</button></td></tr>`).join("")
      || `<tr><td colspan="4" class="note">${t("fs.empty")}</td></tr>`;
    $("#fsNote").classList.remove("warn");
    $("#fsNote").innerHTML = t("fs.note");
  } catch (e) {
    $("#fsList").innerHTML = "";
    $("#fsNote").textContent = t("fs.nofs", { err: e.message });
    $("#fsNote").classList.add("warn");
  }
}
$("#fsList").onclick = async (ev) => {
  const tg = ev.target;
  if (tg.dataset.del) {
    const name = decodeURIComponent(tg.dataset.del);
    if (!confirm(t("fs.confirmDelete", { name }))) return;
    try { await call({ t: "fs", op: "delete", path: join(cwd, name) }); } catch (e) { alert(e.message); }
    return loadDir(cwd);
  }
  const td = tg.closest(".name"); if (!td) return;
  const name = decodeURIComponent(td.dataset.name);
  if (td.dataset.dir === "1") return loadDir(join(cwd, name));
  const r = await call({ t: "fs", op: "read", path: join(cwd, name) });
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([r.data])); a.download = name; a.click();
};
$("#fsUp").onclick = () => loadDir(cwd === "/" ? "/" : cwd.replace(/\/[^/]+\/?$/, "") || "/");
$("#fsRefresh").onclick = () => loadDir(cwd);
$("#fsMkdir").onclick = async () => {
  const n = prompt(t("fs.newFolder")); if (!n) return;
  try { await call({ t: "fs", op: "mkdir", path: join(cwd, n) }); } catch (e) { alert(e.message); }
  loadDir(cwd);
};
$("#fsFormat").onclick = async () => {
  if (!confirm(t("fs.confirmFormat"))) return;
  try { await call({ t: "fs", op: "format" }); } catch (e) { alert(e.message); }
  loadDir("/");
};
$("#fsUpload").onchange = async (e) => {
  for (const f of e.target.files) {
    try { const data = await f.arrayBuffer(); await call({ t: "fs", op: "write", path: join(cwd, f.name), data }, [data]); }
    catch (err) { alert(f.name + ": " + err.message); }
  }
  e.target.value = ""; loadDir(cwd);
};

// ---------------------------------------------------------------- dev pane
async function loadDev() {
  try {
    const d = (await call({ t: "dev" })).info, s = status;
    if (!d.regs) return;
    $("#devExec").innerHTML = `<span>PC</span><span>${esc(s.pc)}</span><span>${t("dev.insns")}</span><span>${fmtInsns(s.insns || 0)}</span><span>${t("dev.speed")}</span><span>${s.mips} M/s</span>`
      + `<span>CPSR</span><span>${d.cpsr}</span><span>${t("dev.regs")}</span><span>${d.regs.map((v, i) => `r${i}=${v}`).join(" ")}</span>`
      + `<span>${t("dev.flashsd")}</span><span>${t("dev.flashsdVal", { f: d.flashReads, s: d.sdCommands })}</span><span>${t("dev.touch")}</span><span>${t("dev.touchVal", { n: s.touchReads })}</span>`;
    $("#devIrq").innerHTML = Object.entries(d.gic).map(([k, v]) => `<span>IRQ ${k}${({ 50: " (timer 0)", 116: " (CSI)", 103: " (USB)" })[k] || ""}</span><span>${v}</span>`).join("") || "<span>—</span><span></span>";
    $("#devFpga").innerHTML = Object.entries(d.fpgaReads).map(([k, v]) => `<span>${k}: ${v}</span>`).join("");
    $("#devMmio").innerHTML = d.unmodelled.map((u) => `<tr><td>${u.op}${u.size}</td><td class="mono">${u.addr}</td><td class="r">${u.count}</td><td class="mono">${esc(u.first)}</td></tr>`).join("");
    $("#devHot").innerHTML = d.hot.map((h) => `${h.samples} · ${esc(h.where)}`).join("<br>");
    $("#devUart").textContent = d.uart || t("dev.noUart");
  } catch (e) { /* busy */ }
}
setInterval(() => { if ($("#pane-dev").classList.contains("active") && $("#devAuto").checked) loadDev(); }, 1500);
$("#peekGo").onclick = async () => {
  try {
    const addr = parseInt($("#peekAddr").value, 16), n = +$("#peekLen").value || 64;
    const r = await call({ t: "peek", addr, n });
    const lines = [];
    for (let i = 0; i < r.data.length; i += 16) lines.push((addr + i).toString(16).padStart(8, "0") + "  " + r.data.slice(i, i + 16).map((b) => b.toString(16).padStart(2, "0")).join(" "));
    $("#peekOut").textContent = lines.join("\n");
  } catch (e) { $("#peekOut").textContent = e.message; }
};

// ---------------------------------------------------------------- start-up
applyI18n();
(async () => {
  let symbols = null;
  try { const r = await fetch("data/symbols.json"); if (r.ok) symbols = await r.json(); } catch (_) { /* optional */ }
  const fw = await kvGet("firmware").catch(() => null);
  const sd = await kvGet("sd").catch(() => null);
  const factoryDone = await kvGet("factoryDone").catch(() => undefined);
  const r = await call({ t: "init", app: fw ? fw.app : null, info: fw ? fw.info : null, sd: sd || null, symbols, opts: { factoryDone: factoryDone !== false } });
  status = r.status; renderStatus();
  loadDir("/");
})();
