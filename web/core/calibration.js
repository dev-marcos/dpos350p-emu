// Synthetic channel calibration for the emulated SPI flash (ASSUMPTION: values chosen for the
// emulator, not read from a real unit).
//
// Format (STATIC-CONFIRMED from calibration_process_serialized_fields 0x40044450 and the serializer
// helpers at 0x40067xxx): big-endian 32-bit scalars at storage address SYS_INFO+0x7E0 (0x1FB000),
// read by calibration_load_wrapper 0x400446B4 into the object at 0x42E53A0C:
//   1. matrix, 50 rows x 32 columns, row-major in the stream (RAM: object+0x190 + col*0xC8 + row*4)
//   2. four auxiliary arrays of 20 values, interleaved per index: +0x50, +0xF0, +0xA0, +0x140
// The selector (0x4004C544) copies one row into the active per-lane coefficients:
//   two-channel mode (SYS+0x100 != 0): A = columns 0..7,   B = columns 8..15
//   one-channel mode:                  A = columns 16..23, B = columns 24..31
// and the conversion core (0x4004073C) computes, per raw byte of lane L:
//   ip  = (gain[V/div] * A[L]) / 1000
//   x   = ip * (raw - SYS[0x1B8]) + B[L]
//   out = clamp(r2 + E0 * ((x >> SYS[0x264]) - r2) / 32, 0, SYS[0x0A] * SYS[0x1C0]),  r2 = SYS[0x1C0] * offset
// so with E0 = 32 the waveform position in display units is x >> shift.

export const CAL_STORAGE = 0x1FB000;
export const CAL_OBJECT = 0x42E53A0C;
export const CAL_STREAM_SIZE = 50 * 32 * 4 + 4 * 20 * 4;      // 0x1A40

// Nominal coefficients: 25 ADC codes per division at gain 2294 (V/div index 6) and raw 128 at the
// screen centre (251 px, 64 units per px, shift 6).
export const NOMINAL = (() => {
  const pxPerCode = (503 / 8) / 25;
  const ip = Math.round(pxPerCode * 64 * 64);
  const A = Math.round(ip * 1000 / 2294);
  const B = 251 * 64 * 64 - Math.trunc(2294 * A / 1000) * (128 - 20);
  return { A, B };
})();

export function calibrationBlob({ A = NOMINAL.A, B = NOMINAL.B, aux = 0 } = {}) {
  const out = new Uint8Array(0x5000);
  const v = new DataView(out.buffer);
  let p = 0;
  for (let row = 0; row < 50; row++) {
    for (let col = 0; col < 32; col++) {
      const isA = (col & 8) === 0;                   // 0..7, 16..23 -> A; 8..15, 24..31 -> B
      v.setInt32(p, isA ? A : B, false); p += 4;
    }
  }
  for (let i = 0; i < 20; i++) for (let k = 0; k < 4; k++) { v.setInt32(p, aux, false); p += 4; }
  return out;
}
