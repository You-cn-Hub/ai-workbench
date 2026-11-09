/**
 * 图标提取 —— 全部纯 JS，不依赖 Python，也不依赖 Pillow。
 *
 * 为什么要自己写：
 *   用户的机器上 Python 可能没装 Pillow，而 Electron 的 nativeImage
 *   读不了 .ico、app.getFileIcon 最大只有 48×48。
 *   所以 .ico 和 .exe 内嵌图标都得自己解析格式。
 *
 * 支持的来源（按"越准越靠前"）：
 *   1. 程序目录里的图标文件（png / ico）
 *   2. exe 内嵌图标（解析 PE 资源表）
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

/**
 * 工厂：把外部依赖注入进来，模块本身不碰全局状态。
 * @param {object} deps
 * @param {string} deps.iconDir     图标输出目录
 * @param {string} deps.logFile     提取日志文件
 * @param {Function} deps.nativeImage  Electron 的 nativeImage
 * @param {Function} deps.runWinMgr    调用 winmgr.py（仅作兜底）
 */
function createIconService(deps) {
const { iconDir: ICON_DIR, logFile: ICON_LOG, nativeImage, runWinMgr } = deps;

const ICON_GOOD = /^(icon|app|logo|application|main|shell|brand|splash|app[-_ ]?icon|logo[-_ ]?icon|icon[-_ ]?\d+)/;
const ICON_BAD = /^(canvas|md|file|folder|document|menu|close|min|max|restore|tray|pointer|tree|zoom|search|settings|base|blank|empty)/;

function findIconFiles(exe) {
  const base = path.basename(exe).replace(/\.(exe|bat|cmd)$/i, "").toLowerCase();
  const root = path.dirname(exe);

  const dirs = [
    path.join(root, "resources"),
    path.join(root, "resources", "assets"),
    path.join(root, "data", "flutter_assets", "assets"),
    path.join(root, "assets"),
    root,
    path.join(path.dirname(root), "resources"),
    path.dirname(root),
  ];

  const seen = new Set();
  const scored = [];

  for (const d of dirs) {
    // 系统目录里全是无关的图标文件，跳过，否则记事本会配上 OneDrive 的图标
    if (/^[a-z]:\\windows(\\system32)?$/i.test(d)) continue;
    if (!fs.existsSync(d)) continue;

    let files = [];
    try {
      files = fs.readdirSync(d);
    } catch {
      continue;
    }

    for (const f of files) {
      if (!/\.(ico|png)$/i.test(f)) continue;
      const full = path.join(d, f);
      if (seen.has(full)) continue;
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {
        continue;
      }
      if (size < 3000) continue;   // 太小的不是应用图标

      const stem = path.basename(f).replace(/\.(ico|png)$/i, "").toLowerCase();
      let score = 0;
      if (base && stem.includes(base)) score += 100;
      if (ICON_GOOD.test(stem)) score += 80;
      if (ICON_BAD.test(stem)) score -= 100;
      scored.push({ full, score, size });
      seen.add(full);
    }
  }

  // 只要 positively 像应用图标的；剩下那些宁可交给 exe 内嵌图标
  const good = scored.filter((x) => x.score > 0);
  good.sort((a, b) => b.score - a.score || b.size - a.size);
  return good.slice(0, 6).map((x) => x.full);
}

// 同一个 id 的图标提取串行化：启动自愈和「添加文件」可能同时跑，
// 两条链都用同一批临时文件名，互相 rename 掉就会莫名失败。
const iconJobs = new Map();

function extractIcon(exe, id, iconHint) {
  const prev = iconJobs.get(id) || Promise.resolve(false);
  const job = prev
    .catch(() => false)
    .then(() => doExtractIcon(exe, id, iconHint));
  iconJobs.set(id, job);
  job
    .catch(() => false)
    .then(() => {
      if (iconJobs.get(id) === job) iconJobs.delete(id);
    });
  return job;
}

// 覆盖写一个文件。Windows 上目标正被别的进程读着时 rename 会失败，
// 重试几次就好——不能因为一次 EPERM 就把整张图丢掉。
function replaceFile(tmp, out) {
  for (let i = 0; i < 5; i++) {
    try {
      fs.renameSync(tmp, out);
      return true;
    } catch {}
    try {
      // rename 不成，退一步：直接拷内容过去（目标不存在时这条一定成功）
      fs.copyFileSync(tmp, out);
      fs.unlinkSync(tmp);
      return true;
    } catch {}
    const until = Date.now() + 80;
    while (Date.now() < until) {
      /* 稍等再试，文件名被占用的时间通常很短 */
    }
  }
  return false;
}

// 图标提取的流水账，出问题时有据可查（用户那边看不到控制台）
function iconLog(msg) {
  try {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}\n`;
    fs.appendFileSync(ICON_LOG, line, "utf-8");
    // 太长就砍掉前半，别无限长
    const st = fs.statSync(ICON_LOG);
    if (st.size > 40000) {
      const all = fs.readFileSync(ICON_LOG, "utf-8").split("\n");
      fs.writeFileSync(ICON_LOG, all.slice(-150).join("\n"), "utf-8");
    }
  } catch {}
}

// 把一张 png / ico / jpg 转成 256 的 png。**纯 JS，不依赖 Python**。
// 这是最关键的一条路：程序目录里那张高清 logo 只要能被它读到，
// 图标就一定能出来，跟 Python 装在哪、PATH 里有没有完全无关。
function toIconPng(src, dst) {
  try {
    // Electron 的 nativeImage 读不了 .ico（读出来是空图），所以 ico 走自己解析
    if (/\.ico$/i.test(src)) return icoToPng(src, dst);
    const img = nativeImage.createFromPath(src);
    if (!img || img.isEmpty()) return null;
    const s = img.getSize();
    if (!s.width || !s.height) return null;

    const big = Math.max(s.width, s.height);
    const out = big === 256 ? img : img.resize({ width: 256, height: 256, quality: "best" });
    const buf = out.toPNG();
    if (!buf || buf.length < 600) return null;   // 太小说明读出来是空的
    fs.writeFileSync(dst, buf);
    return { srcSize: [s.width, s.height] };
  } catch {
    return null;
  }
}

// ---------- 纯 JS 解析 .ico ----------
// Electron 读不了 ico，但 ico 格式本身很简单：
//   ICONDIR(6字节) + ICONDIRENTRY(每项16字节) + 每项的图像数据
// 图像数据要么是 PNG（直接就是 PNG 字节），要么是 BMP（DIB）需要自己转。
// 只取尺寸最大的那一项。

function icoToPng(src, dst) {
  try {
    const buf = fs.readFileSync(src);
    if (buf.length < 6) return null;
    if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) return null;  // 0=图标, 1=游标
    const count = buf.readUInt16LE(4);
    if (!count) return null;

    let best = null;
    for (let i = 0; i < count; i++) {
      const off = 6 + i * 16;
      if (off + 16 > buf.length) break;
      // 宽高各占 1 字节，0 表示 256
      const w = buf.readUInt8(off) || 256;
      const h = buf.readUInt8(off + 1) || 256;
      const size = buf.readUInt32LE(off + 8);
      const dataOff = buf.readUInt32LE(off + 12);
      if (!size || dataOff + size > buf.length) continue;
      const area = w * h;
      if (!best || area > best.area) best = { area, w, h, size, dataOff };
    }
    if (!best) return null;

    const data = buf.subarray(best.dataOff, best.dataOff + best.size);
    let png;
    // PNG 格式的 ico（Vista 之后常见）：数据本身就是 PNG，直接用
    if (data.length > 8 && data.readUInt32BE(0) === 0x89504e47) {
      png = Buffer.from(data);
    } else {
      const bmp = dibToRgba(data, best.w, best.h);
      if (!bmp) return null;
      png = rgbaToPng(bmp, best.w, best.h);
    }
    if (!png || png.length < 600) return null;
    fs.writeFileSync(dst, png);
    return { srcSize: [best.w, best.h] };
  } catch {
    return null;
  }
}

// ico 里存的是 DIB：BITMAPINFOHEADER(40字节) + 像素 + 可选的 AND 掩码。
// 只处理 32 位 BGRA（现代图标基本都是），够用了。
// 注意两种来源的差异：
//   - .ico 文件里的 DIB：高度是 2×h（XOR 位图 + AND 掩码各占一半）
//   - exe 资源 RT_ICON 里的 DIB：只有 XOR 位图，高度就是 h，没有掩码
function dibToRgba(data, w, h) {
  try {
    if (data.length < 40) return null;
    const headerSize = data.readUInt32LE(0);
    const bpp = data.readUInt16LE(14);
    const clrUsed = data.readUInt32LE(32);
    if (bpp !== 32) return null;

    const dibH = Math.abs(data.readInt32LE(8));
    const hasMask = dibH === h * 2;
    const realH = hasMask ? h : dibH;
    if (realH !== h) return null;

    let pixelOff = headerSize;
    // 调色板（bpp<=8 才有），32 位没有
    if (clrUsed && bpp <= 8) pixelOff += clrUsed * 4;
    const need = w * h * 4;
    if (pixelOff + need > data.length) return null;

    // DIB 自下而上存储，要翻转成自上而下
    const out = Buffer.alloc(need);
    for (let y = 0; y < h; y++) {
      const srcY = h - 1 - y;
      data.copy(out, y * w * 4, pixelOff + srcY * w * 4, pixelOff + (srcY + 1) * w * 4);
    }

    // BGRA → RGBA
    for (let i = 0; i < need; i += 4) {
      const b = out[i];
      out[i] = out[i + 2];
      out[i + 2] = b;
    }

    // AND 掩码（1 位/像素）在像素区之后：位为 1 表示透明。
    // 很多图标 alpha 全 0，得靠这个掩码补回来。
    if (hasMask) {
      const maskOff = pixelOff + need;
      if (maskOff < data.length) {
        const rowBytes = Math.ceil(w / 32) * 4;
        let anyMask = false;
        for (let y = 0; y < h; y++) {
          const mo = maskOff + y * rowBytes;
          if (mo + rowBytes > data.length) break;
          for (let x = 0; x < w; x++) {
            const byte = data[mo + (x >> 3)];
            const bit = (byte >> (7 - (x & 7))) & 1;
            if (bit) {
              out[(y * w + x) * 4 + 3] = 0;
              anyMask = true;
            }
          }
        }
        if (anyMask) return out;
      }
    }

    // 没有掩码，但 alpha 全是 0 —— 当成不透明
    let allZero = true;
    for (let i = 3; i < need; i += 4) {
      if (out[i] !== 0) { allZero = false; break; }
    }
    if (allZero) {
      for (let i = 3; i < need; i += 4) out[i] = 255;
    }
    return out;
  } catch {
    return null;
  }
}

// 把 RGBA 原始像素包成 PNG（标准库 zlib 压缩，无外部依赖）
function rgbaToPng(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;   // filter type 0 = None
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  const chunks = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // color type = RGBA
  ihdr[10] = 0;   // compression
  ihdr[11] = 0;   // filter
  ihdr[12] = 0;   // interlace
  chunks.push(pngChunk("IHDR", ihdr));
  chunks.push(pngChunk("IDAT", idat));
  chunks.push(pngChunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ---------- 纯 JS 从 exe 里抠图标 ----------
// 走 PE 资源表：RT_GROUP_ICON(14) 描述有哪些尺寸，RT_ICON(3) 是真正的图像数据。
// 不依赖 Python，也就不依赖用户机器上装没装 Pillow。
const RT_ICON = 3;
const RT_GROUP_ICON = 14;

function exeIconToPng(exe, dst) {
  try {
    const fd = fs.openSync(exe, "r");
    const size = fs.fstatSync(fd).size;
    // PE 头在文件头，但资源表(.rsrc)常常在文件很靠后的地方
    // （大型 Electron 应用能有几百 MB，资源表在文件末尾），所以整段读进来。
    // 图标一般在几 MB 量级，内存开销可以接受。
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, 0);
    fs.closeSync(fd);
    return peIconToPng(buf, dst, size);
  } catch {
    return null;
  }
}

function peIconToPng(buf, dst, fileSize) {
  try {
    // --- DOS 头 → PE 头 ---
    if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) return null;  // "MZ"
    const peOff = buf.readUInt32LE(0x3c);
    if (peOff + 24 > buf.length) return null;
    if (buf.readUInt32LE(peOff) !== 0x00004550) return null;              // "PE\0\0"

    const coff = peOff + 4;
    const nsec = buf.readUInt16LE(coff + 2);
    const optSize = buf.readUInt16LE(coff + 16);
    const opt = coff + 20;
    const magic = buf.readUInt16LE(opt);
    const isPE32plus = magic === 0x20b;
    // 数据目录起始：PE32+ 是 +112，PE32 是 +96
    const ddOff = opt + (isPE32plus ? 112 : 96);
    const secOff = opt + optSize;

    // --- 节表：RVA → 文件偏移 ---
    const sections = [];
    for (let i = 0; i < nsec; i++) {
      const o = secOff + i * 40;
      if (o + 40 > buf.length) break;
      const va = buf.readUInt32LE(o + 12);
      const vsize = buf.readUInt32LE(o + 8);
      const rawSize = buf.readUInt32LE(o + 16);
      const rawPtr = buf.readUInt32LE(o + 20);
      sections.push({ va, vsize, rawSize, rawPtr });
    }
    const rvaToOff = (rva) => {
      for (const s of sections) {
        const span = Math.max(s.vsize, s.rawSize);
        if (rva >= s.va && rva < s.va + span) return s.rawPtr + (rva - s.va);
      }
      return -1;
    };

    // --- 资源表 RVA ---
    if (ddOff + 2 * 8 + 8 > buf.length) return null;
    const resRva = buf.readUInt32LE(ddOff + 2 * 8);
    if (!resRva) return null;
    const resBase = rvaToOff(resRva);
    if (resBase < 0) return null;

    // --- 遍历资源目录 ---
    // 目录项: Name/ID(4) + Offset(4)，Offset 高位为 1 表示是子目录
    const readDir = (dirOff) => {
      const nName = buf.readUInt16LE(dirOff + 12);
      const nId = buf.readUInt16LE(dirOff + 14);
      const items = [];
      for (let i = 0; i < nName + nId; i++) {
        const o = dirOff + 16 + i * 8;
        if (o + 8 > buf.length) break;
        const id = buf.readUInt32LE(o);
        const raw = buf.readUInt32LE(o + 4);
        items.push({ id, off: raw & 0x7fffffff, isDir: (raw & 0x80000000) !== 0 });
      }
      return items;
    };

    const topLevel = readDir(resBase);
    const groupDir = topLevel.find((t) => t.id === RT_GROUP_ICON && t.isDir);
    const iconDir = topLevel.find((t) => t.id === RT_ICON && t.isDir);
    if (!groupDir || !iconDir) return null;

    // RT_GROUP_ICON 的下一层：每个 ID 是一个图标组
    const groups = readDir(resBase + groupDir.off);
    // 找面积最大的那个组
    let bestGroup = null;
    for (const g of groups) {
      if (!g.isDir) continue;
      // 组目录下面直接就是语言 ID 的数据项（不再多一层子目录）
      const langs = readDir(resBase + g.off);
      const lang = langs.find((l) => !l.isDir);
      if (!lang) continue;
      const de = resBase + lang.off;
      if (de + 16 > buf.length) continue;
      const dataRva = buf.readUInt32LE(de);
      const dataSize = buf.readUInt32LE(de + 4);
      const off = rvaToOff(dataRva);
      if (off < 0 || off + 6 > buf.length) continue;

      // GRPICONDIR: reserved(2) type(2) count(2)，然后 count 个 GRPICONDIRENTRY
      const count = buf.readUInt16LE(off + 4);
      let maxArea = 0;
      for (let i = 0; i < count; i++) {
        const e = off + 6 + i * 14;
        if (e + 14 > buf.length) break;
        const w = buf.readUInt8(e) || 256;
        const h = buf.readUInt8(e + 1) || 256;
        if (w * h > maxArea) maxArea = w * h;
      }
      if (maxArea > 0 && (!bestGroup || maxArea > bestGroup.maxArea)) {
        bestGroup = { maxArea, groupDir: g, langDir: lang };
      }
    }
    if (!bestGroup) return null;

    // GROUP_ICON 数据：按顺序列出该组用到的每一个 ICON 的 ID
    const gde = resBase + bestGroup.langDir.off;
    const gDataRva = buf.readUInt32LE(gde);
    const gOff = rvaToOff(gDataRva);
    if (gOff < 0 || gOff + 6 > buf.length) return null;
    const gCount = buf.readUInt16LE(gOff + 4);

    // 在 RT_ICON 目录里找对应 ID 的图像数据
    // 结构同样是：ID 目录 → 语言 ID 数据项
    const iconLangDirs = readDir(resBase + iconDir.off);
    const iconMap = new Map();
    for (const idDir of iconLangDirs) {
      if (!idDir.isDir) continue;
      const langDirs = readDir(resBase + idDir.off);
      for (const ld of langDirs) {
        if (ld.isDir) continue;
        const de = resBase + ld.off;
        if (de + 16 > buf.length) continue;
        const dataRva = buf.readUInt32LE(de);
        const dataSize = buf.readUInt32LE(de + 4);
        const off = rvaToOff(dataRva);
        if (off < 0 || off + dataSize > buf.length) continue;
        if (!iconMap.has(idDir.id)) iconMap.set(idDir.id, { off, size: dataSize });
      }
    }

    // 按 GROUP_ICON 里给的顺序，挑尺寸最大的那个 ICON
    let bestIcon = null;
    for (let i = 0; i < gCount; i++) {
      const e = gOff + 6 + i * 14;
      if (e + 14 > buf.length) break;
      const w = buf.readUInt8(e) || 256;
      const h = buf.readUInt8(e + 1) || 256;
      const iconId = buf.readUInt16LE(e + 12);
      const img = iconMap.get(iconId);
      if (!img) continue;
      const area = w * h;
      if (!bestIcon || area > bestIcon.area) bestIcon = { area, w, h, ...img };
    }
    if (!bestIcon) return null;

    // RT_ICON 的数据：Vista 之后通常是 PNG，早期是 DIB
    const data = buf.subarray(bestIcon.off, bestIcon.off + bestIcon.size);
    let png;
    if (data.length > 8 && data.readUInt32BE(0) === 0x89504e47) {
      png = Buffer.from(data);
    } else {
      const bmp = dibToRgba(data, bestIcon.w, bestIcon.h);
      if (!bmp) return null;
      png = rgbaToPng(bmp, bestIcon.w, bestIcon.h);
    }
    if (!png || png.length < 600) return null;
    fs.writeFileSync(dst, png);
    return { srcSize: [bestIcon.w, bestIcon.h] };
  } catch {
    return null;
  }
}

async function doExtractIcon(exe, id, iconHint) {
  try {
    fs.mkdirSync(ICON_DIR, { recursive: true });
  } catch {}
  const out = path.join(ICON_DIR, `${id}.png`);

  // 临时文件名带上随机尾巴，避免和并发的另一条链撞名
  const tag = `${id}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

  // 快捷方式里的图标字段常写成 `C:\x\App.exe,0` 这种带资源索引的形式，
  // 直接把整串当路径会找不到文件，得把 `,N` 去掉。
  if (iconHint) iconHint = String(iconHint).replace(/,\s*-?\d+$/, "").trim();

  // 候选来源，按"大概率是应用主图标"排序
  const sources = [];
  if (iconHint && fs.existsSync(iconHint)) {
    // 图标字段也可能指向另一个 exe，那种要走 exe 内嵌图标那条路
    sources.push({
      kind: /\.(exe|dll)$/i.test(iconHint) ? "exe" : "file",
      src: iconHint,
    });
  }
  const dirIcons = findIconFiles(exe);
  for (const f of dirIcons) sources.push({ kind: "file", src: f });
  if (exe && fs.existsSync(exe)) sources.push({ kind: "exe", src: exe });

  iconLog(
    `开始 ${id} | exe=${exe} | hint=${iconHint || "-"} | 目录候选=${dirIcons.length}(${dirIcons.map((f) => path.basename(f)).join(",") || "无"})`
  );

  const rm = (p) => {
    try {
      fs.unlinkSync(p);
    } catch {}
  };

  let best = null;   // { px, tmp }
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const tmp = path.join(ICON_DIR, `.tmp_${tag}_${i}.png`);
    let r = { ok: false };

    if (s.kind === "exe") {
      // exe 内嵌图标：纯 JS 解析 PE 资源表，读不出来再叫 Python
      const js = exeIconToPng(s.src, tmp);
      if (js) {
        r = { ok: true, srcSize: js.srcSize };
        iconLog(`  exe 内嵌 ${path.basename(s.src)} → js ${JSON.stringify(js.srcSize)}`);
      } else {
        r = await runWinMgr(["exeicon", "--src", s.src, "--out", tmp, "--isize", "256"], 25000);
        iconLog(`  exe 内嵌 ${path.basename(s.src)} → python ${r.ok ? JSON.stringify(r.srcSize) : r.error}`);
      }
    } else {
      // 图标文件先走纯 JS，读不出来再叫 Python（ico 里的多尺寸需要它）
      const js = toIconPng(s.src, tmp);
      if (js) {
        r = { ok: true, srcSize: js.srcSize };
        iconLog(`  文件 ${path.basename(s.src)} → js ${JSON.stringify(js.srcSize)}`);
      } else {
        r = await runWinMgr(["icon", "--src", s.src, "--out", tmp], 25000);
        iconLog(`  文件 ${path.basename(s.src)} → python ${r.ok ? JSON.stringify(r.srcSize) : r.error}`);
      }
    }

    if (!r.ok) {
      rm(tmp);
      continue;
    }
    const px = r.srcSize && r.srcSize.length === 2 ? Math.max(r.srcSize[0], r.srcSize[1]) : 0;
    if (!best || px > best.px) {
      if (best) rm(best.tmp);
      best = { px, tmp };
    } else {
      rm(tmp);
    }
    // 已经拿到高清图（512 以上）就别再费时间。
    // 256 不算——exe 内嵌图标常见就是 256，而有些程序在目录里放了更大的真图标。
    if (best.px >= 512) break;
  }

  if (!best) {
    // 最后退到 Electron 自己的取值（一般 32~48，糊但总比没有强）。
    // 它本身就是 PNG，直接放大写出去，同样不需要 Python。
    try {
      const img = await app.getFileIcon(exe, { size: "large" });
      if (img && !img.isEmpty()) {
        const s = img.getSize();
        const big = img.resize({ width: 256, height: 256, quality: "best" });
        fs.writeFileSync(out, big.toPNG());
        iconLog(`  兜底 getFileIcon ${s.width}x${s.height} → 已放大`);
        return true;
      }
    } catch (e) {
      iconLog(`  兜底失败 ${e.message}`);
    }
    iconLog(`  放弃 ${id}：没有任何可用来源`);
    return false;
  }

  const ok = replaceFile(best.tmp, out);
  if (!ok) rm(best.tmp);
  iconLog(ok ? `  完成 ${id}，用 ${best.px}px 源` : `  写入失败 ${id}`);
  return ok;
}


// ---------- 对外接口 ----------

return {
  findIconFiles,
  extractIcon,
  toIconPng,
  icoToPng,
  exeIconToPng,
};
}

module.exports = { createIconService };
