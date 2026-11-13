"""Peripheral models for tools/sim. Register meanings follow the V3s user manual (DERIVED);
what the stock firmware expects from them was read from its code (see docs/DRIVERS.md)."""

CCU = 0x01C20000
TMR = 0x01C20C00
UART = (0x01C28000, 0x01C28400, 0x01C28800)


class Board:
    def __init__(self, sim):
        self.sim = sim
        self.uart = [bytearray() for _ in UART]
        self.ticks = 0                 # 24 MHz OSC ticks; one per emulated instruction (approximation)
        self.flash = SpiFlash()
        self.spi0 = Spi(0x01C68000, self.flash)
        self.sd = SdCard(sim.sd_image)
        self.mmc0 = Mmc(self.sd, sim)
        self.fpga = Fpga()
        self.pe_dat = 0

    # returns the value to read, or None (unmodelled: RAM-backed, logged)
    def read(self, addr, size):
        if addr == PE_DAT and size == 4:
            mode = (self.pe_dat >> 2) & 3
            v = self.pe_dat
            if mode == 0:                                        # read mode: FPGA drives PE8..15
                v = (v & ~0xFF00) | (self.fpga.out << 8)
            return v
        if 0x01C0F000 <= addr < 0x01C10000:
            return self.mmc0.read(addr - 0x01C0F000, size)
        if 0x01C68000 <= addr < 0x01C69000:
            return self.spi0.read(addr - 0x01C68000, size)
        # CCU: every PLL reports LOCK (bit 28)
        if CCU <= addr < CCU + 0x50 and (addr & 3) == 0:
            return self.sim.r32(addr) | 0x10000000
        if CCU <= addr < CCU + 0x400:
            return self.sim.r32(addr & ~3) >> (8 * (addr & 3))
        # AVS counters: 24 MHz / divider; the firmware's delay loops poll AVS_CNT0
        if addr in (TMR + 0x84, TMR + 0x88):
            self.ticks += 2000                     # each poll costs ~2000 counts: delays end quickly
            return self.ticks & 0xFFFFFFFF
        if TMR <= addr < TMR + 0x100:
            return self.sim.r32(addr & ~3)
        for i, base in enumerate(UART):
            if base <= addr < base + 0x100:
                off = addr - base
                if off == 0x7C:              # USR: TX FIFO not full
                    return 0x6
                if off == 0x14:              # LSR: THR empty
                    return 0x60
                return self.sim.r32(addr & ~3)
        return None

    def write(self, addr, size, value):
        if addr == PE_DAT and size == 4:
            old, self.pe_dat = self.pe_dat, value
            if old & 1 and not value & 1:                        # PE0 falling edge
                mode, data = (value >> 2) & 3, (value >> 8) & 0xFF
                if mode == 3:
                    self.fpga.command(data)
                elif mode == 1:
                    self.fpga.write(data)
                elif mode == 0:
                    self.fpga.out = self.fpga.read()
            return True
        if 0x01C0F000 <= addr < 0x01C10000:
            self.mmc0.write(addr - 0x01C0F000, size, value)
            return True
        if 0x01C68000 <= addr < 0x01C69000:
            self.spi0.write(addr - 0x01C68000, size, value)
            return True
        if CCU <= addr < CCU + 0x400 or TMR <= addr < TMR + 0x100:
            return True
        for i, base in enumerate(UART):
            if base <= addr < base + 0x100:
                if addr == base:
                    self.uart[i].append(value & 0xFF)
                return True
        return False

    def tick(self, n):
        self.ticks += n

    def uart_text(self):
        return "\n".join(f"[uart{i}] " + b.decode("latin1") for i, b in enumerate(self.uart) if b)


class SpiFlash:
    """Generic SPI NOR (W25Q-style). Content: 0xFF unless an image is given. Logs every read."""
    def __init__(self, size=16 << 20, image=None):
        self.mem = bytearray(b"\xff" * size)
        if image:
            self.mem[:len(image)] = image
        self.reset()
        self.reads = []            # (address, length)
        self.cmds = []

    def reset(self):
        self.cmd = None
        self.buf = []
        self.addr = None
        self.n = 0

    def select(self, on):
        if not on:
            if self.cmd in (0x03, 0x0B) and self.addr is not None and self.n:
                self.reads.append((self.addr, self.n))
            self.reset()

    def xfer(self, b):
        if self.cmd is None:
            self.cmd = b
            self.cmds.append(b)
            return 0xFF
        if self.cmd == 0x9F:                       # JEDEC ID: Winbond W25Q128 (assumption)
            ids = [0xEF, 0x40, 0x18]
            v = ids[len(self.buf) % 3]
            self.buf.append(b)
            return v
        if self.cmd in (0x05, 0x35):               # status: never busy
            return 0x00
        if self.cmd in (0x03, 0x0B, 0x02):
            if len(self.buf) < 3:
                self.buf.append(b)
                if len(self.buf) == 3:
                    self.addr = (self.buf[0] << 16) | (self.buf[1] << 8) | self.buf[2]
                return 0xFF
            if self.cmd == 0x0B and len(self.buf) == 3:
                self.buf.append(b)                 # dummy byte
                return 0xFF
            a = (self.addr + self.n) % len(self.mem)
            self.n += 1
            if self.cmd == 0x02:
                self.mem[a] &= b
                return 0xFF
            return self.mem[a]
        return 0xFF


class Spi:
    """Allwinner SPI controller (V3s user manual register layout)."""
    def __init__(self, base, flash):
        self.base, self.flash = base, flash
        self.regs = {0x04: 0, 0x08: 0, 0x10: 0, 0x14: 0, 0x18: 0, 0x30: 0, 0x34: 0, 0x38: 0}
        self.tx, self.rx = bytearray(), bytearray()
        self.cs = False

    def read(self, off, size):
        if off == 0x1C:                            # FSR: RX count [7:0], TX count [23:16]
            return min(len(self.rx), 64) | (min(len(self.tx), 64) << 16)
        if off == 0x300:
            out = 0
            for i in range(size):
                out |= (self.rx.pop(0) if self.rx else 0) << (8 * i)
            return out
        return self.regs.get(off & ~3, 0)

    def write(self, off, size, v):
        if off == 0x200:
            for i in range(size):
                self.tx.append((v >> (8 * i)) & 0xFF)
            self._pump()
            return
        if off == 0x04:
            v &= ~(1 << 31)                        # soft reset completes at once
        if off == 0x14:                            # ISR: write 1 to clear
            self.regs[0x14] &= ~v
            return
        if off == 0x18:                            # FCR: FIFO resets self-clear
            if v & (1 << 15): self.rx.clear()
            if v & (1 << 31): self.tx.clear()
            v &= ~((1 << 15) | (1 << 31))
        if off == 0x08:
            cs_low = not (v & (1 << 7)) if v & (1 << 6) else True
            if cs_low != self.cs:
                self.cs = cs_low
                self.flash.select(cs_low)
            self.regs[0x08] = v
            if v & (1 << 31):
                self._exchange(v)
            return
        self.regs[off & ~3] = v

    def _exchange(self, tcr):
        """XCH: burst of MBC bytes, the first MTC taken from the TX FIFO (streamed as written),
        the rest dummy bytes clocked by the controller."""
        self.remaining = self.regs[0x30] & 0xFFFFFF
        self.ntx = self.regs[0x34] & 0xFFFFFF
        self.idx = 0
        self.discard = bool(tcr & (1 << 13))       # DHB: drop RX bytes of the TX phase
        self.auto_cs = not (tcr & (1 << 6))
        if not self.cs:
            self.flash.select(True)
        self._pump()

    def _pump(self):
        while getattr(self, "remaining", 0) > 0:
            if self.idx < self.ntx:
                if not self.tx:
                    return                         # wait for the CPU to write more TX bytes
                b = self.tx.pop(0)
            else:
                b = 0
            r = self.flash.xfer(b)
            if not (self.discard and self.idx < self.ntx):
                self.rx.append(r)
            self.idx += 1
            self.remaining -= 1
        if getattr(self, "idx", 0):
            self.regs[0x08] &= ~(1 << 31)
            self.regs[0x14] |= 1 << 12             # transfer complete
            if self.auto_cs:
                self.flash.select(False)
            self.idx = 0


class SdCard:
    """SDHC card (block addressed) backed by a bytearray image."""
    def __init__(self, image):
        self.img = image
        self.app = False
        self.rca = 0x1234
        self.state = "idle"

    def csd(self):
        c_size = len(self.img) // (512 * 1024) - 1            # CSD v2: capacity = (C_SIZE+1) * 512 KiB
        v = (1 << 126) | (0x0E << 112) | (0x32 << 96) | (0x5B5 << 84) | (9 << 80) | (c_size << 48) | (1 << 46) | (0x7F << 39) | (0x0A << 22) | (9 << 22) | 1
        return v

    def command(self, idx, arg):
        """-> (response int or None, long?, data_out bytes or None, write_handler or None)"""
        app, self.app = self.app, False
        if app:
            if idx == 41:
                return 0xC0FF8000, False, None, None             # ready, CCS = SDHC
            if idx == 6:
                return 0x920, False, None, None
            if idx == 51:                                        # SCR: SD 2.0, 1/4-bit bus
                return 0x920, False, bytes([0x02, 0x35, 0x80, 0x00, 0, 0, 0, 0]), None
            if idx == 13:
                return 0x920, False, bytes(64), None
        if idx == 0:
            return None, False, None, None
        if idx == 8:
            return arg & 0xFFF, False, None, None
        if idx == 55:
            self.app = True
            return 0x120, False, None, None
        if idx == 2:
            return int.from_bytes(b"\x03SDDPOS\x10\x00\x00\x00\x01\x00\x01\x41\x01", "big") >> 8, True, None, None
        if idx == 3:
            return self.rca << 16, False, None, None
        if idx == 9:
            return self.csd() >> 8, True, None, None
        if idx in (7, 12, 16, 13, 23):
            return 0x900, False, None, None
        if idx == 6:
            return 0x900, False, bytes(64), None
        if idx in (17, 18):
            return 0x900, False, None, ("read", arg * 512)
        if idx in (24, 25):
            return 0x900, False, None, ("write", arg * 512)
        return 0x900, False, None, None


class Mmc:
    """Allwinner SD/MMC controller: PIO (FIFO at +0x200) and internal DMA (IDMAC, 0x80..0x8C)."""
    def __init__(self, card, sim=None):
        self.sim = sim
        self.card = card
        self.regs = {}
        self.fifo = bytearray()
        self.wr = None                # (offset, remaining) of a write in progress
        self.log = []

    def read(self, off, size):
        if off == 0x3C:                                          # STATUS
            words = len(self.fifo) // 4
            st = (min(words, 0x1F) << 17)
            st |= 4 if not self.fifo else 0                      # FIFO empty
            return st
        if off == 0x200:
            out = int.from_bytes(bytes(self.fifo[:size]).ljust(size, b"\0"), "little")
            del self.fifo[:size]
            return out
        if off == 0x18:
            return self.regs.get(0x18, 0) & ~(1 << 31)           # commands complete at once
        return self.regs.get(off & ~3, 0)

    def write(self, off, size, v):
        if off == 0x38:                                          # RINTSTS: write 1 to clear
            self.regs[0x38] = self.regs.get(0x38, 0) & ~v
            return
        if off == 0x200:
            if self.wr:
                o, n = self.wr
                b = v.to_bytes(size, "little")
                self.card.img[o:o + size] = b
                self.wr = (o + size, n - size)
                if self.wr[1] <= 0:
                    self.wr = None
                    self.regs[0x38] = self.regs.get(0x38, 0) | (1 << 3) | (1 << 14)
            return
        if off == 0x80:
            v &= ~1                                              # IDMAC soft reset self-clears
        if off == 0x88:                                          # IDST: write 1 to clear
            self.regs[0x88] = self.regs.get(0x88, 0) & ~v
            return
        if off == 0x00:
            if v & 2:
                self.fifo.clear()
            v &= ~7                                              # soft/FIFO/DMA resets self-clear
        self.regs[off & ~3] = v
        if off == 0x18 and v & (1 << 31):
            self._cmd(v)

    def _cmd(self, v):
        if v & (1 << 21):                                        # clock update only
            return
        idx, arg = v & 0x3F, self.regs.get(0x1C, 0)
        resp, long_, data, xfer = self.card.command(idx, arg)
        self.log.append((idx, arg))
        rint = 1 << 2                                            # command done
        if resp is not None:
            if long_:
                for i in range(4):
                    self.regs[0x20 + 4 * i] = (resp >> (32 * i)) & 0xFFFFFFFF
            elif v & (1 << 7):
                # long response requested for a 48-bit reply (the stock driver does this for
                # ACMD41 and reads the OCR from RESP3). ASSUMPTION: the value is visible in
                # every response word.
                for i in range(4):
                    self.regs[0x20 + 4 * i] = resp & 0xFFFFFFFF
            else:
                self.regs[0x20] = resp & 0xFFFFFFFF
        n = self.regs.get(0x14, 512)
        dma = (self.regs.get(0x00, 0) & 0x20) and (self.regs.get(0x80, 0) & 0x80) and self.sim
        if dma and (data is not None or xfer):
            if data is not None:
                self._dma_out(bytes(data[:n]))
            elif xfer[0] == "read":
                self._dma_out(bytes(self.card.img[xfer[1]:xfer[1] + n]))
            else:
                self.card.img[xfer[1]:xfer[1] + n] = self._dma_in(n)
            rint |= (1 << 3) | (1 << 14)
            self.regs[0x88] = self.regs.get(0x88, 0) | 3       # IDST: TX/RX interrupt
            self.regs[0x38] = self.regs.get(0x38, 0) | rint
            return
        if data is not None:
            self.fifo += data[:n]
            rint |= (1 << 3) | (1 << 14)
        elif xfer:
            kind, off = xfer
            if kind == "read":
                self.fifo += self.card.img[off:off + n]
                rint |= (1 << 3) | (1 << 14)
            else:
                self.wr = (off, n)
        self.regs[0x38] = self.regs.get(0x38, 0) | rint

    def _descs(self):
        """Walk the IDMAC descriptor chain: (des0, size, buffer, address of des0)."""
        d = self.regs.get(0x84, 0)
        for _ in range(4096):
            des0, des1, des2, des3 = (self.sim.r32(d + 4 * i) for i in range(4))
            yield des0, des1 & 0xFFFF or 0x10000, des2, d
            self.sim.w32(d, des0 & ~(1 << 31))                   # hand the descriptor back to the CPU
            if des0 & (1 << 2):                                  # last descriptor
                return
            d = des3 if des0 & (1 << 4) else d + 16

    def _dma_out(self, data):                                    # card -> memory
        pos = 0
        for des0, size, buf, _ in self._descs():
            chunk = data[pos:pos + size]
            if chunk:
                self.sim.uc.mem_write(buf, chunk)
            pos += size
            if pos >= len(data):
                break

    def _dma_in(self, n):                                        # memory -> card
        out = bytearray()
        for des0, size, buf, _ in self._descs():
            k = min(size, n - len(out))
            out += self.sim.uc.mem_read(buf, k)
            if len(out) >= n:
                break
        return bytes(out)


class Fpga:
    """FPGA on the PE parallel bus (protocol: docs/DRIVERS.md + Hack FPGA_PROTOCOL.md).

    Pins: PE0 strobe (a falling edge transfers one byte), PE2/PE3 mode (1/1 command = select a
    register, 1/0 data write, 0/0 data read), PE8..PE15 data. Unknown registers read 0 and are
    counted, so the log shows what the firmware asks for next.
    """
    def __init__(self):
        self.sel = None
        self.writes = {}             # sel -> list of written bytes (recent)
        self.reads = {}              # sel -> count
        self.out = 0
        self.job_input = 0
        self.log = []

    def command(self, v):
        self.sel = v
        self.idx = 0
        if len(self.log) < 4000:
            self.log.append(("S", v))

    def write(self, v):
        self.writes.setdefault(self.sel, []).append(v)
        del self.writes[self.sel][:-16]
        if len(self.log) < 4000:
            self.log.append(("W", self.sel, v))
        if self.sel == 0x6B:
            self.job_input = ((self.job_input << 8) | v) & 0xFFFFFFFF

    def read(self):
        s = self.sel
        self.reads[s] = self.reads.get(s, 0) + 1
        if s == 0x01:                         # identity: A5 A5 5A 5A (checked by the ID probe)
            v = (0xA5, 0xA5, 0x5A, 0x5A)[self.idx % 4]
            self.idx += 1
        elif s == 0x60:                       # security-chip status (POST check reads bit 0)
            v = 0x01
        elif s in (0x64, 0x65):               # job state / completion: ready (bit 0)
            v = 0x01
        elif s in (0x66, 0x67):               # job result: OPEN (SMEC transform); 0 for now
            v = 0x00
        else:
            v = 0x00
        if len(self.log) < 4000:
            self.log.append(("R", s, v))
        return v


PE_DAT = 0x01C208A0
