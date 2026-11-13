// DPOS350P update container (.iso) -> application image (layout: tools/dposiso.py in the decomp repo).
export const ISO_SIZE = 0xE7856;
const EXE_OFFSET = 0x51000, EXE_BLOCK_SIZE = 0x95800, EXE_HDR_SIZE = 0x20;

export function appFromUpload(data, name = '') {
  const u = data instanceof Uint8Array ? data : new Uint8Array(data);
  const magic = String.fromCharCode(...u.subarray(0, 8));
  if (u.length === ISO_SIZE || magic === 'DPOS350P' || name.toLowerCase().endsWith('.iso')) {
    if (u.length !== ISO_SIZE) throw new Error(`unexpected .iso size ${u.length} (expected ${ISO_SIZE})`);
    return { app: u.slice(EXE_OFFSET + EXE_HDR_SIZE, EXE_OFFSET + EXE_BLOCK_SIZE), kind: 'iso' };
  }
  if (u.length > 0x90000 && u[0] === 0x18 && u[1] === 0xF0 && u[2] === 0x9F && u[3] === 0xE5) return { app: u.slice(), kind: 'app.bin' };   // ldr pc,[pc,#0x18]
  throw new Error('not a DPOS350P firmware (expected the .iso update file or app.bin)');
}
