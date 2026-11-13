// AudioWorklet: plays the emulated scope's generator output on the computer's sound card.
// Parameters arrive from the page ({g: generator settings, scale: volts for full scale}).
import { shape } from './core/genwave.js';

class GenOut extends AudioWorkletProcessor {
  constructor() {
    super();
    this.g = null;
    this.scale = 5;
    this.on = true;
    this.ph = 0;
    this.peak = 0;
    this.frames = 0;
    this.port.onmessage = (e) => { const d = e.data; if (d.g) this.g = d.g; if (d.scale) this.scale = d.scale; if (d.on !== undefined) this.on = d.on; };
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const n = out[0].length;
    const g = this.g;
    const nyq = sampleRate / 2;
    for (let i = 0; i < n; i++) {
      let v = 0;
      if (g && this.on) {
        if (g.wave === 13) v = g.offset + g.ampl / 2;
        else if (g.freq < nyq) {                      // above Nyquist the sound card cannot reproduce it: silence
          v = g.offset + (g.ampl / 2) * shape(g.wave, this.ph, g.duty);
          this.ph += g.freq / sampleRate;
          if (this.ph >= 1) this.ph -= Math.floor(this.ph);
        }
      }
      let s = v / this.scale;
      if (s > 1) s = 1; else if (s < -1) s = -1;
      for (let ch = 0; ch < out.length; ch++) out[ch][i] = s;
      const a = Math.abs(s); if (a > this.peak) this.peak = a;
    }
    if (++this.frames % 16 === 0) { this.port.postMessage({ peak: this.peak }); this.peak = 0; }
    return true;
  }
}

registerProcessor('gen-out', GenOut);
