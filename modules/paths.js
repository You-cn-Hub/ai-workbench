/**
 * 路径与目录约定 —— 全项目唯一出处。
 *
 * 关键区分：
 *   APP_DIR  只读：preload / renderer / 内置资源
 *   DATA_DIR 可写：插件配置、图标、窗口位置（打包后程序目录是只读的）
 *   RES_DIR  打包后在 resources/ 下，winmgr.py 等必须放在 asar 外面
 *
 * 数据目录位置可以用环境变量 WB_DATA_DIR 覆盖：
 *   - 默认用系统的 userData（%APPDATA%\ai-workbench）
 *   - 便携版可以指向 exe 旁边的 data/ 目录，整个文件夹拷走就能用
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

function buildPaths({ isPackaged, appDir, userDataDir, resourcesPath, exeDir }) {
  const APP_DIR = appDir;
  const RES_DIR = isPackaged ? resourcesPath : APP_DIR;

  // 便携模式：数据放在 exe 旁边的 data/ 目录
  const portable = process.env.WB_DATA_DIR
    ? path.resolve(process.env.WB_DATA_DIR)
    : exeDir && isPackaged
      ? path.join(exeDir, "data")
      : null;

  const DATA_DIR = portable || (isPackaged ? userDataDir : APP_DIR);

  return {
    APP_DIR,
    DATA_DIR,
    RES_DIR,
    IS_PORTABLE: !!portable,
    PLUGIN_DIR: path.join(DATA_DIR, "plugins"),
    ICON_DIR: isPackaged ? path.join(DATA_DIR, "icons") : path.join(APP_DIR, "assets", "icons"),
    POS_FILE: path.join(DATA_DIR, "_pos.json"),
    ORDER_FILE: path.join(DATA_DIR, "_order.json"),
    SETTINGS_FILE: path.join(DATA_DIR, "settings.json"),
    WINMGR: path.join(RES_DIR, "winmgr.py"),
    SERVER_DIR: path.join(RES_DIR, "server"),
    TRACE_FILE: path.join(DATA_DIR, "_trace.log"),
    ICON_LOG: path.join(DATA_DIR, "_icon.log"),
  };
}

/**
 * 配置里的路径可以写占位符，换机器 / 换安装位置不用改配置：
 *   ${app}    程序目录（开发模式 = 项目根，打包后 = resources/app）
 *   ${res}    资源目录（打包后 = resources）
 *   ${server} 内置工作台服务的目录
 *   ${home}   用户主目录
 */
function makeExpander(paths) {
  const map = {
    app: paths.APP_DIR,
    res: paths.RES_DIR,
    server: paths.SERVER_DIR,
    home: os.homedir(),
  };
  return function expand(p) {
    if (!p || typeof p !== "string") return p;
    if (!p.includes("${")) return p;
    return p.replace(/\$\{(\w+)\}/g, (m, k) => (map[k] !== undefined ? map[k] : m));
  };
}

/**
 * 打包版第一次运行：把内置的程序配置和图标种到 userData 里。
 * 否则新装的用户打开是一片空白。
 *
 * 两条不同的规则，别混：
 *   - 图标：只补「缺的那几个」，已有的不覆盖
 *   - 程序条目：整个目录为空时才种一次，避免把用户删掉的条目复活
 */
function seedDataDirs(paths, { isPackaged, log = () => {} }) {
  const { PLUGIN_DIR, ICON_DIR, DATA_DIR, RES_DIR } = paths;

  try {
    fs.mkdirSync(PLUGIN_DIR, { recursive: true });
    fs.mkdirSync(ICON_DIR, { recursive: true });
  } catch (e) {
    log(`[data] 建目录失败: ${e.message}`);
    return;
  }

  if (!isPackaged) return;

  const seedPlugins = path.join(RES_DIR, "plugins");
  const seedIcons = path.join(RES_DIR, "assets", "icons");

  // 图标单独补齐
  try {
    if (fs.existsSync(seedIcons)) {
      for (const f of fs.readdirSync(seedIcons)) {
        if (!f.endsWith(".png")) continue;
        const dst = path.join(ICON_DIR, f);
        if (!fs.existsSync(dst)) fs.copyFileSync(path.join(seedIcons, f), dst);
      }
    }
  } catch {}

  // 程序条目只在整个 plugins 目录为空时种一次
  let empty = true;
  try {
    empty = fs.readdirSync(PLUGIN_DIR).filter((f) => f.endsWith(".json")).length === 0;
  } catch {}
  if (!empty) return;

  const copyAll = (from, to, ext) => {
    if (!fs.existsSync(from)) return 0;
    let n = 0;
    for (const f of fs.readdirSync(from)) {
      if (!f.endsWith(ext)) continue;
      try {
        fs.copyFileSync(path.join(from, f), path.join(to, f));
        n++;
      } catch {}
    }
    return n;
  };

  const pn = copyAll(seedPlugins, PLUGIN_DIR, ".json");
  const inum = copyAll(seedIcons, ICON_DIR, ".png");
  log(`[data] 首次运行，已初始化 ${pn} 个程序、${inum} 个图标 → ${DATA_DIR}`);
}

module.exports = { buildPaths, makeExpander, seedDataDirs };
