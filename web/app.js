// DSO-350 emulator front end. Talks only to the local API (later replaceable by a WebAssembly core).
"use strict";
const $ = (s) => document.querySelector(s);
const api = async (path, opts = {}) => {
  const r = await fetch(path, opts);
  const ct = r.headers.get("content-type") || "";
  const body = ct.includes("json") ? await r.json() : await r.blob();
  if (!r.ok) throw new Error(body.error || r.statusText);
  return body;
};
const post = (path, obj) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj || {}) });
let status = {};

// ---------------------------------------------------------------- screen + touch
const screen = $("#screen");
function nextFrame() { screen.src = "frame.png?" + Date.now(); }
screen.onload = () => setTimeout(nextFrame, 120);
screen.onerror = () => setTimeout(nextFrame, 1000);
function screenPos(e) {
  const r = screen.getBoundingClientRect();
  return { x: Math.round((e.clientX - r.left) * 1022 / r.width), y: Math.round((e.clientY - r.top) * 600 / r.height) };
}
// touch events are sent strictly in order (parallel requests could reach the emulator swapped)
let pressing = false, lastMove = 0, touchChain = Promise.resolve();
const sendTouch = (kind, p) => { touchChain = touchChain.then(() => post("/api/touch", { kind, ...p })).catch(() => {}); };
screen.addEventListener("pointerdown", (e) => {
  pressing = true;
  try { screen.setPointerCapture(e.pointerId); } catch (_) { /* synthetic pointer */ }
  sendTouch("down", screenPos(e)); e.preventDefault();
});
screen.addEventListener("pointermove", (e) => { if (!pressing || Date.now() - lastMove < 30) return; lastMove = Date.now(); sendTouch("move", screenPos(e)); });
const release = (e) => { if (!pressing) return; pressing = false; sendTouch("up", screenPos(e)); };
screen.addEventListener("pointerup", release);
screen.addEventListener("pointercancel", release);

// ---------------------------------------------------------------- top bar
$("#btnRun").onclick = async () => { status = await post("/api/control", { action: status.paused ? "resume" : "pause" }); renderStatus(); };
$("#btnReset").onclick = async () => { status = await post("/api/control", { action: "reset" }); renderStatus(); };
$("#btnShot").onclick = () => { const a = document.createElement("a"); a.href = "frame.png?" + Date.now(); a.download = "tela-dso350.png"; a.click(); };

function fmtInsns(n) { return n >= 1e9 ? (n / 1e9).toFixed(2) + " G" : (n / 1e6).toFixed(0) + " M"; }
function renderStatus() {
  const s = status;
  if (!s.loaded) { $("#stat").textContent = "nenhum firmware carregado — use Sistema → Carregar firmware"; return; }
  $("#btnRun").textContent = s.paused ? "▶ Continuar" : "⏸ Pausar";
  $("#stat").textContent = s.error ? "parou: " + s.error : `${fmtInsns(s.insns)} instr · ${s.mips} M/s · IRQs ${s.irqs} · quadros ${s.csi_frames}`;
  const fw = s.image || {};
  $("#fwInfo").innerHTML = `<span>Origem</span><span>${fw.source || "—"}</span><span>Tamanho</span><span>${fw.size || "—"}</span><span>SHA-256</span><span>${fw.sha256 || "—"}</span>`;
  if (document.activeElement !== $("#batt")) { $("#batt").value = s.battery_mv; }
  $("#battV").textContent = (s.battery_mv / 1000).toFixed(2) + " V";
  $("#charging").checked = s.charging;
  $("#factory").checked = s.factory_done;
  if (!chBuilt && s.channels) buildChannels(s.channels);
}
setInterval(async () => { try { status = await api("/api/status"); renderStatus(); } catch (e) { $("#stat").textContent = "servidor offline"; } }, 700);

// ---------------------------------------------------------------- tabs
document.querySelectorAll(".tab").forEach((t) => t.onclick = () => {
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
  document.querySelectorAll(".pane").forEach((p) => p.classList.toggle("active", p.id === "pane-" + t.dataset.tab));
  if (t.dataset.tab === "files") loadDir(cwd);
  if (t.dataset.tab === "dev") loadDev();
});

// ---------------------------------------------------------------- firmware upload (button + drag & drop)
async function uploadFirmware(file) {
  $("#stat").textContent = "carregando " + file.name + "…";
  try { status = await api("/api/firmware?name=" + encodeURIComponent(file.name), { method: "POST", body: file }); renderStatus(); }
  catch (e) { alert("Firmware recusado: " + e.message); }
}
$("#fwFile").onchange = (e) => e.target.files[0] && uploadFirmware(e.target.files[0]);
const dev = $("#device"), drop = $("#drop");
dev.addEventListener("dragover", (e) => { e.preventDefault(); drop.hidden = false; });
dev.addEventListener("dragleave", () => drop.hidden = true);
dev.addEventListener("drop", (e) => { e.preventDefault(); drop.hidden = true; const f = e.dataTransfer.files[0]; if (f) uploadFirmware(f); });

// ---------------------------------------------------------------- system pane
$("#batt").oninput = (e) => { $("#battV").textContent = (e.target.value / 1000).toFixed(2) + " V"; };
$("#batt").onchange = (e) => post("/api/battery", { mv: +e.target.value });
$("#charging").onchange = (e) => post("/api/battery", { charging: e.target.checked });
$("#factory").onchange = (e) => post("/api/control", { action: "factory_done", value: e.target.checked });
$("#snapSave").onclick = () => post("/api/control", { action: "snapshot_save" }).then(() => alert("Estado salvo."));
$("#snapLoad").onclick = () => post("/api/control", { action: "snapshot_load" }).catch((e) => alert(e.message));
$("#sdSave").onclick = () => post("/api/control", { action: "save_sd" }).then(() => alert("Cartão gravado em build/sim/sdcard.img."));

// ---------------------------------------------------------------- channels
let chBuilt = false;
const WAVES = [["sine", "Senoide"], ["square", "Quadrada"], ["triangle", "Triangular"], ["saw", "Dente de serra"], ["dc", "DC"], ["noise", "Ruído"]];
function buildChannels(chs) {
  chBuilt = true;
  $("#chForms").innerHTML = chs.map((c, i) => `
    <fieldset class="card ch${i + 1}"><legend>CH${i + 1}</legend>
      <div class="grid2">
        <span>Ligado</span><label><input type="checkbox" data-ch="${i}" data-k="on" ${c.on ? "checked" : ""}> sinal na ponteira</label>
        <span>Fonte</span><select data-ch="${i}" data-k="source"><option value="gen">Gerador</option><option value="audio">Áudio do PC</option></select>
        <span>Forma</span><select data-ch="${i}" data-k="wave">${WAVES.map(([v, t]) => `<option value="${v}">${t}</option>`).join("")}</select>
        <span>Frequência</span><span><input class="num" type="number" min="0" step="any" data-ch="${i}" data-k="freq" value="${c.freq}"> Hz</span>
        <span>Amplitude</span><span><input class="num" type="number" min="0" step="any" data-ch="${i}" data-k="vpp" value="${c.vpp}"> Vpp</span>
        <span>Offset</span><span><input class="num" type="number" step="any" data-ch="${i}" data-k="offset" value="${c.offset}"> V</span>
        <span>Ponteira</span><span class="seg" data-ch="${i}" data-k="probe">
          <button data-v="1" class="${c.probe == 1 ? "on" : ""}">1x</button><button data-v="10" class="${c.probe == 10 ? "on" : ""}">10x</button></span>
      </div></fieldset>`).join("");
  chs.forEach((c, i) => { $(`select[data-ch="${i}"][data-k="source"]`).value = c.source; $(`select[data-ch="${i}"][data-k="wave"]`).value = c.wave; });
  document.querySelectorAll("#chForms [data-k]").forEach((el) => {
    if (el.classList.contains("seg")) {
      el.querySelectorAll("button").forEach((b) => b.onclick = () => {
        el.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
        post("/api/channel", { ch: +el.dataset.ch, probe: +b.dataset.v });
      });
      return;
    }
    el.onchange = () => {
      const v = el.type === "checkbox" ? el.checked : el.type === "number" ? +el.value : el.value;
      post("/api/channel", { ch: +el.dataset.ch, [el.dataset.k]: v });
    };
  });
}

// ---------------------------------------------------------------- audio input (getUserMedia -> PCM chunks to the emulator)
let audioCtx = null, audioNode = null, audioStream = null, pending = [];
async function listAudio() {
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
  $("#audioDev").innerHTML = devs.map((d, i) => `<option value="${d.deviceId}">${d.label || "Entrada " + (i + 1)}</option>`).join("") || "<option value=''>nenhuma entrada</option>";
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
  } catch (e) { alert("Não foi possível abrir a entrada de áudio: " + e.message); }
};
$("#audioStop").onclick = () => {
  audioNode?.disconnect(); audioStream?.getTracks().forEach((t) => t.stop()); audioCtx?.close();
  audioCtx = audioNode = audioStream = null;
  $("#audioStart").disabled = false; $("#audioStop").disabled = true; $("#audioLevel").style.width = "0";
};
setInterval(() => {
  if (!pending.length) return;
  const n = pending.reduce((a, b) => a + b.length, 0), all = new Float32Array(n);
  let o = 0; for (const p of pending) { all.set(p, o); o += p.length; }
  pending = [];
  api("/api/audio?volts=" + (+$("#audioVolts").value || 1), { method: "POST", body: all.buffer }).catch(() => {});
}, 100);

// ---------------------------------------------------------------- file manager (SD card)
let cwd = "/";
const human = (n) => n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB";
const join = (a, b) => (a.endsWith("/") ? a : a + "/") + b;
async function loadDir(path) {
  try {
    const r = await api("/api/fs?path=" + encodeURIComponent(path));
    cwd = path; $("#crumbs").textContent = path; $("#crumbs").title = path;
    const rows = r.entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
    $("#fsList").innerHTML = rows.map((e) => `<tr>
      <td class="name" data-dir="${e.dir ? 1 : 0}" data-name="${encodeURIComponent(e.name)}">${e.dir ? "📁" : "📄"} ${e.name}</td>
      <td class="r">${e.dir ? "" : human(e.size)}</td><td>${e.time}</td>
      <td class="act"><button data-del="${encodeURIComponent(e.name)}" title="Apagar">✕</button></td></tr>`).join("")
      || `<tr><td colspan="4" class="note">pasta vazia</td></tr>`;
    $("#fsNote").classList.remove("warn");
  } catch (e) {
    $("#fsList").innerHTML = "";
    $("#fsNote").textContent = "Cartão ainda sem sistema de arquivos (" + e.message + "). Deixe o firmware iniciar e formatar o cartão, depois atualize.";
    $("#fsNote").classList.add("warn");
  }
}
$("#fsList").onclick = async (ev) => {
  const t = ev.target;
  if (t.dataset.del) {
    const name = decodeURIComponent(t.dataset.del);
    if (!confirm(`Apagar "${name}" do cartão emulado?`)) return;
    try { await api("/api/fs/delete?path=" + encodeURIComponent(join(cwd, name)), { method: "POST" }); } catch (e) { alert(e.message); }
    return loadDir(cwd);
  }
  const td = t.closest(".name"); if (!td) return;
  const name = decodeURIComponent(td.dataset.name);
  if (td.dataset.dir === "1") return loadDir(join(cwd, name));
  const a = document.createElement("a"); a.href = "/api/fs/file?path=" + encodeURIComponent(join(cwd, name)); a.download = name; a.click();
};
$("#fsUp").onclick = () => loadDir(cwd === "/" ? "/" : cwd.replace(/\/[^/]+\/?$/, "") || "/");
$("#fsRefresh").onclick = () => loadDir(cwd);
$("#fsMkdir").onclick = async () => {
  const n = prompt("Nome da nova pasta:"); if (!n) return;
  try { await api("/api/fs/mkdir?path=" + encodeURIComponent(join(cwd, n)), { method: "POST" }); } catch (e) { alert(e.message); }
  loadDir(cwd);
};
$("#fsFormat").onclick = async () => {
  if (!confirm("Formatar o cartão SD emulado em FAT32? Todos os arquivos do cartão serão apagados.")) return;
  try { await api("/api/fs/format", { method: "POST" }); } catch (e) { alert(e.message); }
  loadDir("/");
};
$("#fsUpload").onchange = async (e) => {
  for (const f of e.target.files) {
    try { await api("/api/fs/file?path=" + encodeURIComponent(join(cwd, f.name)), { method: "POST", body: f }); }
    catch (err) { alert(f.name + ": " + err.message); }
  }
  e.target.value = ""; loadDir(cwd);
};

// ---------------------------------------------------------------- dev pane
async function loadDev() {
  try {
    const d = await api("/api/dev"), s = status;
    $("#devExec").innerHTML = `<span>PC</span><span>${s.pc}</span><span>Instruções</span><span>${fmtInsns(s.insns || 0)}</span><span>Velocidade</span><span>${s.mips} M/s</span><span>Toque</span><span>${s.touch || "—"}</span><span>Flash/SD</span><span>${d.flash_reads} leituras · ${d.sd_commands} comandos</span>`;
    $("#devIrq").innerHTML = Object.entries(d.gic).map(([k, v]) => `<span>IRQ ${k}${({ 50: " (timer 0)", 116: " (CSI)", 103: " (USB)" })[k] || ""}</span><span>${v}</span>`).join("") || "<span>—</span><span></span>";
    $("#devFpga").innerHTML = Object.entries(d.fpga_reads).map(([k, v]) => `<span>${k}: ${v}</span>`).join("");
    $("#devMmio").innerHTML = d.unmodelled.map((u) => `<tr><td>${u.op}${u.size}</td><td class="mono">${u.addr}</td><td class="r">${u.count}</td><td class="mono">${u.first}</td></tr>`).join("");
    $("#devHot").innerHTML = d.hot.map((h) => `${h.samples} · ${h.where}`).join("<br>");
    $("#devUart").textContent = d.uart || "(sem saída)";
  } catch (e) { /* server busy */ }
}
setInterval(() => { if ($("#pane-dev").classList.contains("active") && $("#devAuto").checked) loadDev(); }, 1500);
loadDir("/");
