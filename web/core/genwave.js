// The scope's built-in signal generator, as the firmware sets it up (RUNTIME-CONFIRMED in the
// emulator by changing each setting in the GEN menu):
//   0x42E4287E  u8   waveform, menu order (WAVES below)
//   0x42E42880  u32  frequency, Hz
//   0x42E42884  u32  amplitude, mVpp
//   0x42E42888  i32  offset, mV
//   0x42E4288C  u32  duty cycle, 0.1 %
// The shapes are ASSUMPTIONS from the menu names; the firmware sends the real sample table to the
// FPGA (selectors 0x3F/0x40/0x43), which is not decoded yet.

export const GEN_STATE = 0x42E42800;
export const WAVES = ['sine', 'square', 'triangular', 'sawtooth1', 'sawtooth2', 'step', 'half', 'full',
  'exponent', 'ringing', 'sqrt', 'multisin', 'sinc', 'dc', 'capture'];

export function readGen(m) {
  return {
    wave: m.r8(GEN_STATE + 0x7E),
    freq: m.r32(GEN_STATE + 0x80) >>> 0,
    ampl: (m.r32(GEN_STATE + 0x84) >>> 0) / 1000,
    offset: (m.r32(GEN_STATE + 0x88) | 0) / 1000,
    duty: (m.r32(GEN_STATE + 0x8C) >>> 0) / 1000,
  };
}

const TWO_PI = 2 * Math.PI;
const SINC_NORM = 1;

// normalised shape in [-1, 1] at phase ph in [0, 1)
export function shape(wave, ph, duty = 0.5) {
  switch (wave) {
    case 0: return Math.sin(TWO_PI * ph);
    case 1: return ph < duty ? 1 : -1;
    case 2: return ph < 0.5 ? 4 * ph - 1 : 3 - 4 * ph;
    case 3: return 2 * ph - 1;
    case 4: return 1 - 2 * ph;
    case 5: return (Math.floor(ph * 8) / 7) * 2 - 1;
    case 6: { const s = Math.sin(TWO_PI * ph); return s > 0 ? 2 * s - 1 : -1; }
    case 7: return 2 * Math.abs(Math.sin(TWO_PI * ph)) - 1;
    case 8: return 2 * (Math.exp(4 * ph) - 1) / (Math.exp(4) - 1) - 1;
    case 9: return Math.exp(-5 * ph) * Math.sin(TWO_PI * 6 * ph);
    case 10: return 2 * Math.sqrt(ph) - 1;
    case 11: return (Math.sin(TWO_PI * ph) + Math.sin(3 * TWO_PI * ph) / 3 + Math.sin(5 * TWO_PI * ph) / 5) / 1.07;
    case 12: { const x = (ph - 0.5) * 8 * Math.PI; return x === 0 ? SINC_NORM : (Math.sin(x) / x) * SINC_NORM * 2 - 0.3; }
    case 13: return 1;
    default: return Math.sin(TWO_PI * ph);
  }
}

// volts at the generator output at time t (seconds)
export function genVolts(g, t) {
  const ph = ((t * g.freq) % 1 + 1) % 1;
  if (g.wave === 13) return g.offset + g.ampl / 2;
  return g.offset + (g.ampl / 2) * shape(g.wave, ph, g.duty);
}
