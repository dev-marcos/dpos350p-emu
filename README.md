# DPOS350P emulator

Whole-system emulator for the FNIRSI DPOS350P oscilloscope firmware (build 2025-06-19). It boots the
stock firmware from its reset vector and shows the live screen. You can touch the screen, use the
SD-card file manager, set the probe signals and inject audio from the computer.

It is part of the matching-decompilation project
[dpos350p-decomp](https://github.com/dev-marcos/dpos350p-decomp), where this repository is the git
submodule `tools/sim`.

**No FNIRSI code is included.** Load your own firmware file on the page: the `.iso` update file or
`app.bin`. The file stays in your browser (IndexedDB). It is never uploaded anywhere.

## Web version (runs entirely in the browser)

`web/` is a static site: GitHub Pages serves it as is. To try it locally:

```
node tests/serve.mjs            # then open http://localhost:8351
```

| Part | File |
|---|---|
| ARMv7-A CPU: ARM, the Thumb-2 subset the firmware uses, VFPv3, CP15 | `web/core/cpu.js` |
| Peripherals: GIC, timers, SPI flash, SD/MMC + IDMAC, FPGA bus, CSI capture, analog front end, GT911 touch, LRADC battery | `web/core/board.js` |
| Memory map, fast paths, boot loop, framebuffer | `web/core/machine.js` |
| Runs the machine off the UI thread; snapshots; file manager | `web/core/worker.js` |
| FAT12/16/32 read/write, FAT32 format | `web/core/fat.js` |
| `.iso` container → `app.bin` | `web/core/iso.js` |
| Synthetic channel calibration (SPI flash 0x1FB000) and the conversion it feeds | `web/core/calibration.js` |
| Page: device frame, screen, tabs Arquivos / Canais / Sistema / Dev | `web/index.html`, `web/app.js`, `web/style.css`, `web/frame.svg` |

The firmware's MMU tables map every address to itself, so the core uses flat memory.

### Checking the CPU against Unicorn

`tests/gen_cpu_cases.py` runs every distinct instruction of the firmware's functions once in Unicorn,
from a random state. That is about 31,000 instructions and 80,000 cases. `tests/cpu_test.mjs` replays
the cases against `cpu.js` and compares registers, flags, VFP registers and memory. Run both from the
decomp repository root:

```
python3 tools/sim/tests/gen_cpu_cases.py      # inside the dpos-re WSL distro (needs unicorn + capstone)
node tools/sim/tests/cpu_test.mjs             # expected: 0 failed
node tools/sim/tests/boot.mjs --insns 1700M --ch1 freq=20000,vpp=1   # headless boot -> build/sim/js_screen.png
                                              # --tap "x,y;x,y" taps the screen afterwards and prints SYS_INFO changes
```

IT instructions are left out of the comparison: Unicorn runs a whole IT block as one step.

## Python reference (Unicorn)

`sim.py`, `devices.py`, `server.py` and `live.py` are the first version of the emulator. It runs in
Python on Unicorn with a local web server (`python3 -m tools.sim.server` inside the decomp
repository). It stays as the reference for the JavaScript port.

## Known limits

- The channel calibration is synthetic (`web/core/calibration.js`): a real unit keeps it in SPI flash
  at 0x1FB000. Without it the firmware's conversion yields a constant (flat trace, -796 mV). The
  front end produces the ADC codes that this calibration converts into the wanted screen position, so
  amplitudes and measurements follow the V/div setting (checked: 1 Vpp sine reads VPP 1 V, RMS 352 mV).
- Time base: the generator follows the selected time/div (SYS+0x588) at 4750 samples per division,
  up to 0.95 GS/s, with the trigger in the middle of the record the firmware converts. Checked from
  1 ms to 500 ns/div: period and trigger position exact, frequency reading exact. Below 1 us/div the
  trace drifts by up to 10 px.
- Both channels work: lanes 0..3 feed CH1 and 4..7 feed CH2, with half the rate per channel.
- The volts → ADC code conversion is an assumption until the front-end gain chain is
  reverse-engineered.
- Interrupts arrive on time: the run loop stops at the next timer expiry or capture end.
  Before this fix the 1 ms tick lost about 9 of 10 interrupts and the UI read the touch panel only every ~2 s.
- Emulated time runs at 0.5 oscillator tick per instruction, about 48 M instructions per emulated
  second. The speed selector can hold the emulator to real time.
- Not modelled: USB, sound.

Every address is valid only for firmware build 2025-06-19.
