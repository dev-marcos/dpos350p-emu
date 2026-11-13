"""Minimal FAT12/16/32 access to the emulated SD-card image (for the web file manager).

Reads directories (with long names), reads, writes, deletes files and creates directories.
The volume may start at sector 0 (no partition table) or at the first MBR partition.
The firmware keeps its own FatFs caches: after changing the card from outside, reset the
emulated device (or remount) before relying on the firmware seeing the change.
"""
import struct
import time


class FatError(Exception):
    pass


class Fat:
    def __init__(self, img):
        self.img = img
        self.base = self._find_volume()
        b = self.base
        g = lambda o, f: struct.unpack_from(f, img, b + o)[0]
        self.bps = g(11, "<H")
        if self.bps not in (512, 1024, 2048, 4096):
            raise FatError("no FAT volume (blank card: let the firmware format it first)")
        self.spc = g(13, "B")
        self.rsvd = g(14, "<H")
        self.nfats = g(16, "B")
        self.nroot = g(17, "<H")
        tot = g(19, "<H") or g(32, "<I")
        fsz = g(22, "<H") or g(36, "<I")
        self.fatsz = fsz
        self.fat0 = b + self.rsvd * self.bps
        root_secs = (self.nroot * 32 + self.bps - 1) // self.bps
        self.root0 = self.fat0 + self.nfats * fsz * self.bps
        self.data0 = self.root0 + root_secs * self.bps
        ncl = (tot - (self.rsvd + self.nfats * fsz + root_secs)) // self.spc
        self.ncl = ncl
        self.type = 12 if ncl < 4085 else 16 if ncl < 65525 else 32
        self.root_cl = g(44, "<I") if self.type == 32 else 0
        self.csize = self.spc * self.bps

    def _find_volume(self):
        img = self.img
        if len(img) < 1024 or img[510:512] != b"\x55\xAA":
            raise FatError("no boot sector (blank card: let the firmware format it first)")
        if img[0] in (0xEB, 0xE9) and struct.unpack_from("<H", img, 11)[0] in (512, 1024, 2048, 4096):
            return 0
        lba = struct.unpack_from("<I", img, 446 + 8)[0]
        if not lba:
            raise FatError("no FAT volume found")
        return lba * 512

    # ---------------------------------------------------------------- FAT table
    def _get(self, n):
        if self.type == 32:
            return struct.unpack_from("<I", self.img, self.fat0 + 4 * n)[0] & 0x0FFFFFFF
        if self.type == 16:
            return struct.unpack_from("<H", self.img, self.fat0 + 2 * n)[0]
        v = struct.unpack_from("<H", self.img, self.fat0 + n + n // 2)[0]
        return v >> 4 if n & 1 else v & 0xFFF

    def _set(self, n, v):
        for k in range(self.nfats):
            o = self.fat0 + k * self.fatsz * self.bps
            if self.type == 32:
                old = struct.unpack_from("<I", self.img, o + 4 * n)[0]
                struct.pack_into("<I", self.img, o + 4 * n, (old & 0xF0000000) | (v & 0x0FFFFFFF))
            elif self.type == 16:
                struct.pack_into("<H", self.img, o + 2 * n, v & 0xFFFF)
            else:
                p = o + n + n // 2
                old = struct.unpack_from("<H", self.img, p)[0]
                new = (old & 0x000F) | (v << 4) if n & 1 else (old & 0xF000) | (v & 0xFFF)
                struct.pack_into("<H", self.img, p, new)

    def _eoc(self, v):
        return v >= {12: 0xFF8, 16: 0xFFF8, 32: 0x0FFFFFF8}[self.type]

    def _chain(self, cl):
        out = []
        while 2 <= cl < self.ncl + 2 and not self._eoc(cl) and len(out) < self.ncl:
            out.append(cl)
            cl = self._get(cl)
        return out

    def _alloc(self, n):
        free = [c for c in range(2, self.ncl + 2) if self._get(c) == 0][:n]
        if len(free) < n:
            raise FatError("card full")
        for a, b in zip(free, free[1:] + [None]):
            self._set(a, b if b else 0x0FFFFFFF)
        return free

    def _free_chain(self, cl):
        for c in self._chain(cl):
            self._set(c, 0)

    def _cl_off(self, cl):
        return self.data0 + (cl - 2) * self.csize

    # ---------------------------------------------------------------- directories
    def _dir_slots(self, cl):
        """(offset, 32-byte entry) of every slot of a directory (cl 0 = fixed FAT12/16 root)."""
        if cl == 0 and self.type != 32:
            for i in range(self.nroot):
                o = self.root0 + 32 * i
                yield o, self.img[o:o + 32]
            return
        for c in self._chain(cl or self.root_cl):
            base = self._cl_off(c)
            for i in range(self.csize // 32):
                o = base + 32 * i
                yield o, self.img[o:o + 32]

    def _entries(self, cl):
        lfn = {}
        for off, e in self._dir_slots(cl):
            if e[0] == 0:
                return
            if e[0] == 0xE5:
                lfn = {}
                continue
            if e[11] == 0x0F:
                seq = e[0] & 0x1F
                chars = e[1:11] + e[14:26] + e[28:32]
                lfn[seq] = chars.decode("utf-16-le", "replace").split("\x00")[0].replace("￿", "")
                continue
            if e[11] & 0x08:          # volume label
                lfn = {}
                continue
            short = e[0:8].decode("latin1").rstrip() + ("." + e[8:11].decode("latin1").rstrip() if e[8:11].strip() else "")
            name = "".join(lfn[k] for k in sorted(lfn)) if lfn else short
            lfn = {}
            if name in (".", ".."):
                continue
            hi = struct.unpack_from("<H", e, 20)[0] if self.type == 32 else 0
            cl0 = (hi << 16) | struct.unpack_from("<H", e, 26)[0]
            d, t = struct.unpack_from("<H", e, 24)[0], struct.unpack_from("<H", e, 22)[0]
            stamp = "%04d-%02d-%02d %02d:%02d" % (1980 + (d >> 9), (d >> 5) & 15, d & 31, t >> 11, (t >> 5) & 63) if d else ""
            yield {"name": name, "short": short, "dir": bool(e[11] & 0x10), "size": struct.unpack_from("<I", e, 28)[0],
                   "cluster": cl0, "time": stamp, "offset": off}

    def _resolve(self, path):
        cl, ent = 0, None
        for part in [p for p in path.split("/") if p]:
            for e in self._entries(cl):
                if e["name"].lower() == part.lower() or e["short"].lower() == part.lower():
                    ent, cl = e, e["cluster"]
                    break
            else:
                raise FatError(f"not found: {path}")
        return cl, ent

    # ---------------------------------------------------------------- public API
    def listdir(self, path="/"):
        cl, ent = self._resolve(path)
        if ent is not None and not ent["dir"]:
            raise FatError("not a directory")
        return [{k: e[k] for k in ("name", "dir", "size", "time")} for e in self._entries(cl)]

    def read(self, path):
        _, ent = self._resolve(path)
        if ent is None or ent["dir"]:
            raise FatError("not a file")
        data = b"".join(bytes(self.img[self._cl_off(c):self._cl_off(c) + self.csize]) for c in self._chain(ent["cluster"]))
        return data[:ent["size"]]

    def delete(self, path):
        _, ent = self._resolve(path)
        if ent is None:
            raise FatError("cannot delete the root")
        if ent["dir"] and any(True for _ in self._entries(ent["cluster"])):
            raise FatError("directory not empty")
        self._free_chain(ent["cluster"])
        self._mark_deleted(ent["offset"])

    def _mark_deleted(self, off):
        self.img[off] = 0xE5
        o = off - 32                                   # preceding long-name slots
        while o >= 0 and self.img[o + 11] == 0x0F and self.img[o] != 0xE5:
            self.img[o] = 0xE5
            o -= 32

    def write(self, path, data):
        parent, name = self._split(path)
        pcl, pent = self._resolve(parent)
        try:
            _, old = self._resolve(path)
        except FatError:
            old = None
        if old is not None:
            if old["dir"]:
                raise FatError("is a directory")
            self._free_chain(old["cluster"])
            self._mark_deleted(old["offset"])
        n = (len(data) + self.csize - 1) // self.csize
        cls = self._alloc(n) if n else []
        for i, c in enumerate(cls):
            chunk = data[i * self.csize:(i + 1) * self.csize]
            o = self._cl_off(c)
            self.img[o:o + self.csize] = chunk.ljust(self.csize, b"\0")
        self._add_entry(pcl, name, 0x20, cls[0] if cls else 0, len(data))

    def mkdir(self, path):
        parent, name = self._split(path)
        pcl, _ = self._resolve(parent)
        c = self._alloc(1)[0]
        o = self._cl_off(c)
        self.img[o:o + self.csize] = bytes(self.csize)
        self.img[o:o + 32] = self._raw_entry(b".          ", 0x10, c, 0)
        self.img[o + 32:o + 64] = self._raw_entry(b"..         ", 0x10, pcl, 0)
        self._add_entry(pcl, name, 0x10, c, 0)

    # ---------------------------------------------------------------- entry creation
    @staticmethod
    def _split(path):
        parts = [p for p in path.split("/") if p]
        if not parts:
            raise FatError("bad path")
        return "/" + "/".join(parts[:-1]), parts[-1]

    def _raw_entry(self, name11, attr, cl, size):
        t = time.localtime()
        d = ((t.tm_year - 1980) << 9) | (t.tm_mon << 5) | t.tm_mday
        tm = (t.tm_hour << 11) | (t.tm_min << 5) | (t.tm_sec // 2)
        e = bytearray(32)
        e[0:11] = name11
        e[11] = attr
        struct.pack_into("<HHH", e, 14, tm, d, d)
        struct.pack_into("<H", e, 20, (cl >> 16) & 0xFFFF)
        struct.pack_into("<HH", e, 22, tm, d)
        struct.pack_into("<H", e, 26, cl & 0xFFFF)
        struct.pack_into("<I", e, 28, size)
        return bytes(e)

    def _short_name(self, pcl, name):
        bad = set(' "*+,/:;<=>?[\\]|')
        base, _, ext = name.upper().rpartition(".") if "." in name else (name.upper(), "", "")
        clean = lambda s: "".join(ch if (ch.isascii() and ch not in bad and ch.isprintable()) else "_" for ch in s.replace(" ", ""))
        base, ext = clean(base), clean(ext)[:3]
        if len(base) <= 8 and name == (base + ("." + ext if ext else "")):
            return (base.ljust(8) + ext.ljust(3)).encode("latin1"), False
        existing = {e["short"].upper() for e in self._entries(pcl)}
        for i in range(1, 1000):
            tail = f"~{i}"
            b = base[:8 - len(tail)] + tail
            if (b + ("." + ext if ext else "")) not in existing:
                return (b.ljust(8) + ext.ljust(3)).encode("latin1"), True
        raise FatError("too many similar names")

    def _add_entry(self, pcl, name, attr, cl, size):
        sname, need_lfn = self._short_name(pcl, name)
        slots = [self._raw_entry(sname, attr, cl, size)]
        if need_lfn:
            csum = 0
            for ch in sname:
                csum = (((csum & 1) << 7) + (csum >> 1) + ch) & 0xFF
            u = name.encode("utf-16-le") + b"\0\0"
            u = u.ljust(((len(u) + 25) // 26) * 26, b"\xff")
            parts = [u[i:i + 26] for i in range(0, len(u), 26)]
            lfn = []
            for i, p in enumerate(parts, 1):
                e = bytearray(32)
                e[0] = i | (0x40 if i == len(parts) else 0)
                e[1:11], e[11], e[13], e[14:26], e[28:32] = p[0:10], 0x0F, csum, p[10:22], p[22:26]
                lfn.append(bytes(e))
            slots = lfn[::-1] + slots
        free = self._find_free(pcl, len(slots))
        for off, s in zip(free, slots):
            self.img[off:off + 32] = s

    def _find_free(self, cl, n):
        run = []
        for off, e in self._dir_slots(cl):
            if e[0] in (0, 0xE5):
                run.append(off)
                if len(run) == n:
                    return run
            else:
                run = []
        if cl == 0 and self.type != 32:
            raise FatError("root directory full")
        last = self._chain(cl or self.root_cl)[-1]               # grow the directory by one cluster
        c = self._alloc(1)[0]
        self._set(last, c)
        o = self._cl_off(c)
        self.img[o:o + self.csize] = bytes(self.csize)
        return run + [o + 32 * i for i in range(n - len(run))]


def mkfs_fat32(img, label=b"DSO350     "):
    """Format the whole image as one FAT32 volume starting at sector 0 (no partition table;
    FatFs accepts both). 512-byte sectors, 1 sector per cluster for small cards."""
    n = len(img) // 512
    spc = 1 if n <= 0x40000 else 8
    rsvd, nfats = 32, 2
    fatsz = 1
    while True:                                   # FAT size so that FAT + data fit
        ncl = (n - rsvd - nfats * fatsz) // spc
        need = ((ncl + 2) * 4 + 511) // 512
        if need <= fatsz:
            break
        fatsz = need
    if ncl < 65525:
        raise FatError("card too small for FAT32")
    img[:] = bytes(len(img))
    bs = bytearray(512)
    bs[0:3] = b"\xEB\x58\x90"
    bs[3:11] = b"MSDOS5.0"
    struct.pack_into("<HBHBHHBHHHII", bs, 11, 512, spc, rsvd, nfats, 0, 0, 0xF8, 0, 63, 255, 0, n)
    struct.pack_into("<IHHIHH", bs, 36, fatsz, 0, 0, 2, 1, 6)
    bs[64], bs[66] = 0x80, 0x29
    struct.pack_into("<I", bs, 67, int(time.time()) & 0xFFFFFFFF)
    bs[71:82] = label[:11].ljust(11)
    bs[82:90] = b"FAT32   "
    bs[510:512] = b"\x55\xAA"
    fsinfo = bytearray(512)
    struct.pack_into("<I", fsinfo, 0, 0x41615252)
    struct.pack_into("<III", fsinfo, 484, 0x61417272, ncl - 1, 3)
    struct.pack_into("<I", fsinfo, 508, 0xAA550000)
    for base in (0, 6 * 512):                     # boot sector + backup
        img[base:base + 512] = bs
        img[base + 512:base + 1024] = fsinfo
    for k in range(nfats):
        o = (rsvd + k * fatsz) * 512
        struct.pack_into("<III", img, o, 0x0FFFFFF8, 0x0FFFFFFF, 0x0FFFFFFF)
    return {"clusters": ncl, "cluster_size": spc * 512}
