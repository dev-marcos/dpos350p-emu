// UI strings. English is the default; the choice is kept in localStorage ("lang").
"use strict";
const I18N = {
  en: {
    "title": "DSO-350 Emulator",
    "brand.sub": "firmware 2025-06-19 · runs in your browser",
    "btn.pause": "⏸ Pause", "btn.resume": "▶ Resume", "btn.reset": "⟲ Reset", "btn.shot": "⤓ Screen",
    "tip.pause": "Pause / resume", "tip.reset": "Restart the device (power cycle)", "tip.shot": "Save the screen as PNG",
    "tip.speed": "Speed", "speed.max": "Maximum", "speed.real": "Real time",
    "tip.lang": "Language",
    "nofw.title": "Load the firmware",
    "nofw.text": "DPOS350P update file (<code>.iso</code>) or <code>app.bin</code>.",
    "nofw.choose": "Choose file",
    "nofw.note": "The file stays in this browser. Nothing is uploaded anywhere.",
    "drop": "Drop the firmware here (.iso or app.bin)",
    "hint": "Click and drag on the screen to touch it. Drag a firmware file onto the device to load it.",
    "tab.files": "Files", "tab.channels": "Channels", "tab.system": "System", "tab.dev": "Dev",
    "fs.up": "Parent folder", "fs.refresh": "Refresh", "fs.mkdir": "New folder", "fs.format": "Format",
    "fs.formatTip": "Format the emulated card (FAT32)", "fs.upload": "⤒ Upload", "fs.uploadTip": "Upload files to the card",
    "fs.name": "Name", "fs.size": "Size", "fs.date": "Date", "fs.delete": "Delete", "fs.empty": "empty folder",
    "fs.note": "Emulated 64 MB SD card, kept in this browser. After uploading or deleting files, use <b>Reset</b> so the firmware sees the change.",
    "fs.nofs": "The card has no file system yet ({err}). Let the firmware start and format it, or use Format.",
    "fs.confirmDelete": "Delete \"{name}\" from the emulated card?",
    "fs.confirmFormat": "Format the emulated SD card as FAT32? Every file on the card will be erased.",
    "fs.newFolder": "New folder name:",
    "ch.on": "Enabled", "ch.device": "Scope generator (GEN out)",
    "gen.legend": "Scope generator output (GEN)", "gen.play": "▶ Play on sound card", "gen.stop": "■ Stop", "gen.default": "Default output",
    "gen.devTip": "Sound card output", "gen.fullscale": "Full scale =", "gen.wave": "Waveform", "gen.freq": "Frequency", "gen.ampl": "Amplitude", "gen.offset": "Offset", "gen.duty": "Duty",
    "gen.note": "Settings come from the GEN menu of the emulated scope. The output follows them live; pick \"Scope generator\" as a channel source to connect it to a probe.",
    "gen.nyquist": "{f} Hz is above what the sound card can play ({n} Hz): output muted.", "gen.error": "Could not start the audio output: {err}", "gen.noSink": "This browser cannot choose the output device; the default one is used.", "ch.onLabel": "signal at the probe tip", "ch.source": "Source", "ch.gen": "Generator", "ch.audio": "PC audio",
    "ch.wave": "Waveform", "ch.freq": "Frequency", "ch.ampl": "Amplitude", "ch.offset": "Offset", "ch.probe": "Probe",
    "wave.sine": "Sine", "wave.square": "Square", "wave.triangle": "Triangle", "wave.saw": "Sawtooth", "wave.dc": "DC", "wave.noise": "Noise",
    "audio.legend": "Computer audio input", "audio.allow": "(allow the microphone to list devices)", "audio.start": "▶ Capture", "audio.stop": "■ Stop",
    "audio.fullscale": "Full scale =", "audio.note": "Pick \"PC audio\" as the source of a channel to inject the captured signal (microphone, line in or a virtual cable).",
    "audio.none": "no input", "audio.input": "Input {n}", "audio.error": "Could not open the audio input: {err}",
    "ch.warn": "The probe signal is converted with a synthetic calibration: shape, frequency and amplitude follow the scope settings, but this is not the calibration of a real unit.",
    "sys.fw": "Firmware", "sys.load": "Load firmware (.iso or app.bin)", "sys.forget": "Forget the stored firmware",
    "sys.fwNote": "The file stays only in this browser (IndexedDB). Nothing is sent anywhere.",
    "sys.source": "Source", "sys.size": "Size",
    "sys.battery": "Battery", "sys.voltage": "Voltage", "sys.charging": "Charging",
    "sys.boot": "Start-up", "sys.factory": "Factory process completed (skips the self test and the \"insert the tester\" mode)",
    "sys.nextReset": "Takes effect on the next <b>Reset</b>.",
    "sys.state": "State and card", "sys.snapSave": "Save state", "sys.snapLoad": "Restore state",
    "sys.sdDownload": "Download card image", "sys.sdUse": "Use card image…",
    "sys.snapSaved": "State saved in this browser.", "sys.snapError": "Could not save: {err}", "sys.noSnap": "No saved state.",
    "sys.forgetConfirm": "Forget the firmware stored in this browser?",
    "sys.sdConfirm": "Use \"{name}\" as the SD card? The current card will be replaced.",
    "sys.fwRejected": "Firmware rejected: {err}",
    "dev.auto": "Auto refresh", "dev.exec": "Execution", "dev.memory": "Memory", "dev.read": "Read", "dev.irq": "Interrupts",
    "dev.fpga": "FPGA (reads per selector)", "dev.mmio": "Unmodelled peripherals", "dev.op": "Op", "dev.addr": "Address", "dev.count": "Count",
    "dev.first": "First function", "dev.hot": "Where the time goes", "dev.uart": "UART", "dev.noUart": "(no output)",
    "dev.insns": "Instructions", "dev.speed": "Speed", "dev.regs": "Registers", "dev.flashsd": "Flash/SD", "dev.touch": "Touch",
    "dev.flashsdVal": "{f} reads · {s} commands", "dev.touchVal": "{n} reads",
    "stat.none": "no firmware loaded", "stat.loading": "loading {name}…", "stat.stopped": "stopped: {err}",
    "stat.run": "{insns} instr · {mips} M/s · {emu} s emulated · IRQs {irqs}", "stat.workerError": "emulator error: {err}",
  },
  pt: {
    "title": "Emulador DSO-350",
    "brand.sub": "firmware 2025-06-19 · roda no navegador",
    "btn.pause": "⏸ Pausar", "btn.resume": "▶ Continuar", "btn.reset": "⟲ Reiniciar", "btn.shot": "⤓ Tela",
    "tip.pause": "Pausar / continuar", "tip.reset": "Reiniciar o aparelho (liga de novo)", "tip.shot": "Salvar a tela como PNG",
    "tip.speed": "Velocidade", "speed.max": "Máxima", "speed.real": "Tempo real",
    "tip.lang": "Idioma",
    "nofw.title": "Carregue o firmware",
    "nofw.text": "Arquivo de atualização do DPOS350P (<code>.iso</code>) ou <code>app.bin</code>.",
    "nofw.choose": "Escolher arquivo",
    "nofw.note": "O arquivo fica só neste navegador. Nada é enviado para servidor nenhum.",
    "drop": "Solte aqui o firmware (.iso ou app.bin)",
    "hint": "Clique e arraste na tela para tocar. Arraste um arquivo de firmware sobre o aparelho para carregá-lo.",
    "tab.files": "Arquivos", "tab.channels": "Canais", "tab.system": "Sistema", "tab.dev": "Dev",
    "fs.up": "Pasta acima", "fs.refresh": "Atualizar", "fs.mkdir": "Nova pasta", "fs.format": "Formatar",
    "fs.formatTip": "Formatar o cartão emulado (FAT32)", "fs.upload": "⤒ Enviar", "fs.uploadTip": "Enviar arquivos para o cartão",
    "fs.name": "Nome", "fs.size": "Tamanho", "fs.date": "Data", "fs.delete": "Apagar", "fs.empty": "pasta vazia",
    "fs.note": "Cartão SD emulado (64 MB), guardado neste navegador. Depois de enviar ou apagar arquivos, use <b>Reiniciar</b> para o firmware enxergar a mudança.",
    "fs.nofs": "Cartão ainda sem sistema de arquivos ({err}). Deixe o firmware iniciar e formatar o cartão, ou use Formatar.",
    "fs.confirmDelete": "Apagar \"{name}\" do cartão emulado?",
    "fs.confirmFormat": "Formatar o cartão SD emulado em FAT32? Todos os arquivos do cartão serão apagados.",
    "fs.newFolder": "Nome da nova pasta:",
    "ch.on": "Ligado", "ch.device": "Gerador do aparelho (saída GEN)",
    "gen.legend": "Saída do gerador do aparelho (GEN)", "gen.play": "▶ Tocar na placa de som", "gen.stop": "■ Parar", "gen.default": "Saída padrão",
    "gen.devTip": "Saída da placa de som", "gen.fullscale": "Fundo de escala =", "gen.wave": "Forma", "gen.freq": "Frequência", "gen.ampl": "Amplitude", "gen.offset": "Offset", "gen.duty": "Ciclo",
    "gen.note": "Os ajustes vêm do menu GEN do osciloscópio emulado. A saída acompanha ao vivo; escolha \"Gerador do aparelho\" como fonte de um canal para ligá-lo a uma ponteira.",
    "gen.nyquist": "{f} Hz está acima do que a placa de som reproduz ({n} Hz): saída em silêncio.", "gen.error": "Não foi possível iniciar a saída de áudio: {err}", "gen.noSink": "Este navegador não permite escolher a saída; será usada a padrão.", "ch.onLabel": "sinal na ponteira", "ch.source": "Fonte", "ch.gen": "Gerador", "ch.audio": "Áudio do PC",
    "ch.wave": "Forma", "ch.freq": "Frequência", "ch.ampl": "Amplitude", "ch.offset": "Offset", "ch.probe": "Ponteira",
    "wave.sine": "Senoide", "wave.square": "Quadrada", "wave.triangle": "Triangular", "wave.saw": "Dente de serra", "wave.dc": "DC", "wave.noise": "Ruído",
    "audio.legend": "Entrada de áudio do computador", "audio.allow": "(liberar o microfone para listar)", "audio.start": "▶ Capturar", "audio.stop": "■ Parar",
    "audio.fullscale": "Fundo de escala =", "audio.note": "Escolha \"Áudio do PC\" como fonte em um canal para injetar o sinal capturado (microfone, entrada de linha ou cabo virtual).",
    "audio.none": "nenhuma entrada", "audio.input": "Entrada {n}", "audio.error": "Não foi possível abrir a entrada de áudio: {err}",
    "ch.warn": "O sinal da ponteira é convertido com uma calibração sintética: forma, frequência e amplitude seguem os ajustes do osciloscópio, mas não é a calibração de um aparelho real.",
    "sys.fw": "Firmware", "sys.load": "Carregar firmware (.iso ou app.bin)", "sys.forget": "Esquecer o firmware guardado",
    "sys.fwNote": "O arquivo fica só neste navegador (IndexedDB). Nada é enviado para fora.",
    "sys.source": "Origem", "sys.size": "Tamanho",
    "sys.battery": "Bateria", "sys.voltage": "Tensão", "sys.charging": "Carregando",
    "sys.boot": "Inicialização", "sys.factory": "Processo de fábrica concluído (pula o autoteste e o modo \"insira o testador\")",
    "sys.nextReset": "Vale no próximo <b>Reiniciar</b>.",
    "sys.state": "Estado e cartão", "sys.snapSave": "Salvar estado", "sys.snapLoad": "Restaurar estado",
    "sys.sdDownload": "Baixar imagem do cartão", "sys.sdUse": "Usar imagem de cartão…",
    "sys.snapSaved": "Estado salvo neste navegador.", "sys.snapError": "Não foi possível salvar: {err}", "sys.noSnap": "Nenhum estado salvo.",
    "sys.forgetConfirm": "Esquecer o firmware guardado neste navegador?",
    "sys.sdConfirm": "Usar \"{name}\" como cartão SD? O cartão atual será substituído.",
    "sys.fwRejected": "Firmware recusado: {err}",
    "dev.auto": "Atualizar", "dev.exec": "Execução", "dev.memory": "Memória", "dev.read": "Ler", "dev.irq": "Interrupções",
    "dev.fpga": "FPGA (leituras por seletor)", "dev.mmio": "Periféricos sem modelo", "dev.op": "Op", "dev.addr": "Endereço", "dev.count": "Vezes",
    "dev.first": "Primeira função", "dev.hot": "Onde o tempo vai", "dev.uart": "UART", "dev.noUart": "(sem saída)",
    "dev.insns": "Instruções", "dev.speed": "Velocidade", "dev.regs": "Registradores", "dev.flashsd": "Flash/SD", "dev.touch": "Toque",
    "dev.flashsdVal": "{f} leituras · {s} comandos", "dev.touchVal": "{n} leituras",
    "stat.none": "nenhum firmware carregado", "stat.loading": "carregando {name}…", "stat.stopped": "parou: {err}",
    "stat.run": "{insns} instr · {mips} M/s · {emu} s emulados · IRQs {irqs}", "stat.workerError": "erro no emulador: {err}",
  },
};

let LANG = (() => { try { return localStorage.getItem("lang") || "en"; } catch (_) { return "en"; } })();
if (!I18N[LANG]) LANG = "en";

function t(key, vars) {
  let s = (I18N[LANG] && I18N[LANG][key]) || I18N.en[key] || key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? vars[k] : ""));
  return s;
}

// data-i18n (text), data-i18n-html (markup), data-i18n-title (tooltip)
function applyI18n(root = document) {
  document.documentElement.lang = LANG === "pt" ? "pt-BR" : "en";
  document.title = t("title");
  root.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll("[data-i18n-html]").forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
  root.querySelectorAll("[data-i18n-title]").forEach((el) => { el.title = t(el.dataset.i18nTitle); });
}

function setLang(lang) {
  LANG = I18N[lang] ? lang : "en";
  try { localStorage.setItem("lang", LANG); } catch (_) { /* private mode */ }
  applyI18n();
  document.dispatchEvent(new Event("langchange"));
}
