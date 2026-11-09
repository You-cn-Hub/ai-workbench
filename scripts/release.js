#!/usr/bin/env node
/**
 * 发布脚本 —— 打包 + 整理产物。
 *
 * 产物结构（exe 放一级目录，其余各归各位）：
 *
 *   dist/
 *     AI-Workbench/                 ← 整个文件夹拷走就能用
 *       AI-Workbench.exe            ← 主启动文件（唯一需要双击的）
 *       resources/                  ← Electron 运行时 + 应用资源
 *       data/                       ← 用户数据（插件、图标、设置）
 *       logs/                       ← 运行日志
 *       启动.bat                     ← 备用启动器（一般用不上）
 *
 * 为什么 data/ 在 exe 旁边：
 *   便携模式。整个文件夹拷到别的机器，配置和图标一起跟着走，
 *   不用再重新添加一遍程序。
 *
 * 注意：Electron 的 dll / pak 必须和 exe 同级，这部分没法藏进子目录。
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const UNPACKED = path.join(DIST, "win-unpacked");
const OUT = path.join(DIST, "AI-Workbench");

const step = (msg) => console.log(`  ${msg}`);

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch (e) {
    console.error(`  ! 删除失败 ${p}: ${e.message}`);
  }
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    const s = path.join(src, f);
    const d = path.join(dst, f);
    const st = fs.statSync(s);
    if (st.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// ---------- 1. 打包 ----------
console.log("[1/4] 打包");
execSync("npm run dist", { cwd: ROOT, stdio: "inherit" });

if (!fs.existsSync(UNPACKED)) {
  console.error("[x] 打包产物不存在");
  process.exit(1);
}

// ---------- 2. 清理无用文件 ----------
console.log("[2/4] 清理无用文件");

// Electron 的兜底应用，用不到
const defaultApp = path.join(UNPACKED, "resources", "default_app.asar");
if (fs.existsSync(defaultApp)) {
  fs.unlinkSync(defaultApp);
  step("删掉 resources/default_app.asar");
}

// crashpad 的运行日志，会一直累积
for (const f of ["debug.log"]) {
  const p = path.join(UNPACKED, f);
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
    step(`删掉 ${f}`);
  }
}

// 许可证文件：Electron 自带的，法律上要留着，只挪到子目录
const licDir = path.join(UNPACKED, "licenses");
fs.mkdirSync(licDir, { recursive: true });
for (const f of ["LICENSE.electron.txt", "LICENSES.chromium.html"]) {
  const p = path.join(UNPACKED, f);
  if (fs.existsSync(p)) {
    fs.renameSync(p, path.join(licDir, f));
    step(`${f} → licenses/`);
  }
}

// 语言包：只留中文和英文，其余用不上
const localesDir = path.join(UNPACKED, "locales");
if (fs.existsSync(localesDir)) {
  const keep = new Set(["zh-CN.pak", "en-US.pak", "en-GB.pak"]);
  let removed = 0;
  for (const f of fs.readdirSync(localesDir)) {
    if (!keep.has(f)) {
      fs.unlinkSync(path.join(localesDir, f));
      removed++;
    }
  }
  step(`locales/ 只留中英文，删掉 ${removed} 个`);
}

// ---------- 3. 整理成发布目录 ----------
console.log("[3/4] 整理发布目录");
rmrf(OUT);
fs.mkdirSync(OUT, { recursive: true });

// Electron 运行时必须在 exe 同级，原样搬
for (const f of fs.readdirSync(UNPACKED)) {
  const s = path.join(UNPACKED, f);
  const d = path.join(OUT, f);
  if (fs.statSync(s).isDirectory()) copyDir(s, d);
  else fs.copyFileSync(s, d);
}
step(`复制 ${fs.readdirSync(OUT).length} 个顶层项目`);

// 用户数据目录（便携模式）
const dataDir = path.join(OUT, "data");
fs.mkdirSync(path.join(dataDir, "plugins"), { recursive: true });
fs.mkdirSync(path.join(dataDir, "icons"), { recursive: true });
step("建好 data/（plugins + icons）");

// 日志目录
fs.mkdirSync(path.join(OUT, "logs"), { recursive: true });
step("建好 logs/");

// ---------- 4. 启动器 ----------
console.log("[4/4] 写启动器");

// 主启动器：其实双击 exe 就够了，这个只是保险
const cmd = `@echo off
rem 备用启动器。正常直接双击 AI-Workbench.exe 就行。
rem 注意：本文件保持纯 ASCII —— cmd.exe 按 GBK 读 .bat，
rem 注释里写中文会变成乱码把脚本搞坏。
setlocal
set "EXE=%~dp0AI-Workbench.exe"
if not exist "%EXE%" (
  echo Executable not found.
  pause
  exit /b 1
)
rem 便携模式：数据放在 exe 旁边的 data\\
set "WB_DATA_DIR=%~dp0data"
start "" "%EXE%"
`;
fs.writeFileSync(path.join(OUT, "启动.bat"), cmd, "ascii");
step("写好 启动.bat（ASCII，避免 cmd 按 GBK 读出乱码）");

// 说明文件
fs.writeFileSync(
  path.join(OUT, "使用说明.txt"),
  [
    "AI-Workbench —— 本地程序悬浮台",
    "",
    "启动：双击 AI-Workbench.exe",
    "",
    "目录说明：",
    "  AI-Workbench.exe   主程序",
    "  resources/          程序资源（不要改）",
    "  data/               你的配置和图标（可整个文件夹一起拷贝）",
    "  logs/               运行日志",
    "  启动.bat            备用启动器，平时用不上",
    "",
    "怎么加程序：",
    "  界面右下角「+ 添加文件」，选一个 exe 就行。",
    "  列表里按住某一条可以上下拖动调整顺序。",
    "",
    "怎么彻底退出：",
    "  点右上角 × 只是收进托盘，程序还在跑。",
    "  真要退出：右键托盘图标 → 退出。",
  ].join("\r\n"),
  "utf-8"
);
step("写好 使用说明.txt");

// ---------- 汇总 ----------
console.log("\n发布目录已就绪：");
console.log(`  ${OUT}`);
const size = (function du(p) {
  let t = 0;
  for (const f of fs.readdirSync(p)) {
    const s = path.join(p, f);
    const st = fs.statSync(s);
    t += st.isDirectory() ? du(s) : st.size;
  }
  return t;
})(OUT);
console.log(`  总体积 ${(size / 1024 / 1024).toFixed(1)} MB`);
console.log("\n顶层结构：");
for (const f of fs.readdirSync(OUT)) {
  const st = fs.statSync(path.join(OUT, f));
  console.log(`  ${st.isDirectory() ? "[D]" : "[F]"} ${f}`);
}
