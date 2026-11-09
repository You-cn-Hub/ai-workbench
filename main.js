/**
 * 主进程入口 —— 只负责「装配」：把各模块接起来，注册 IPC，管窗口和托盘。
 *
 * 具体职责拆到了 modules/ 里：
 *   paths.js     路径常量与占位符
 *   logger.js    日志
 *   settings.js  设置读写
 *   winmgr.js    Python 定位与 winmgr.py 调用
 *   plugins.js   程序条目的增删改查与排序
 *   icons.js     图标提取（纯 JS，不依赖 Python）
 *   launcher.js  启动 / 退出程序
 *
 * 这里只保留必须由主进程持有的东西：窗口、托盘、界面状态。
 */

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, globalShortcut, WebContentsView, screen, shell, dialog, session } = require("electron");
const { execFile, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const { buildPaths, makeExpander, seedDataDirs } = require("./modules/paths");
const { createLogger } = require("./modules/logger");
const { createSettings } = require("./modules/settings");
const { createWinMgr } = require("./modules/winmgr");
const { createPluginService } = require("./modules/plugins");
const { createIconService } = require("./modules/icons");
const { createLauncher, sleep } = require("./modules/launcher");
const { clearProxyEnv, disableProxy } = require("./modules/proxy");

// ---------- 路径 ----------
const PATHS = buildPaths({
  isPackaged: app.isPackaged,
  appDir: __dirname,
  userDataDir: app.getPath("userData"),
  resourcesPath: process.resourcesPath,
  exeDir: app.isPackaged ? path.dirname(process.execPath) : null,
});
const {
  APP_DIR, DATA_DIR, RES_DIR,
  PLUGIN_DIR, ICON_DIR, POS_FILE, ORDER_FILE, WINMGR,
} = PATHS;

const expandPath = makeExpander(PATHS);

// ---------- 日志 ----------
const logger = createLogger({
  traceFile: PATHS.TRACE_FILE,
  enabled: !!process.env.WB_TRACE,
});
const { trace, error: logError } = logger;
trace("module loaded");

// ---------- 设置 ----------
const settingsService = createSettings({ settingsFile: PATHS.SETTINGS_FILE });

// 本程序只连本机，代理只会添乱 —— 在 app ready 之前就清掉
clearProxyEnv();

// ---------- 悬浮台尺寸 ----------
const BAR_W = 214;
const BAR_H = 496;
const PANEL_W = 880;
const PANEL_H = 620;

// 单实例：拿到锁的才是主进程，后来者直接退出并唤醒已有实例
const isSecondInstance = !app.requestSingleInstanceLock();
trace("lock acquired=" + !isSecondInstance);
if (isSecondInstance) app.quit();

let plugins = [];
let tray = null;
let isQuitting = false;
let activeId = null;
let panelVisible = false;
let panelView = null;
let win = null;

let lastTouch = 0;          // 最近一次点悬浮台的时间
let lastFg = 0;             // 上一次看到的前台窗口
let graceUntil = 0;         // 宽限期：托盘恢复后不急着藏
let autoHideEnabled = true; // 点别的窗口时是否沉到底层
let sunk = false;           // 是否已沉到别的窗口之下（此时仍算"可见"）
let selfHwnd = 0;           // 自己的窗口句柄
let autoHideTimer = null;
let fgDaemon = null;
let fgBuf = "";

const iconCache = new Map();

// ---------- 模块接线 ----------

// 窗口管理（走 Python）
const winmgr = createWinMgr({
  winmgrPath: WINMGR,
  cwd: APP_DIR,
  log: trace,
});
const runWinMgr = winmgr.run;

// 程序条目
const pluginService = createPluginService({
  pluginDir: PLUGIN_DIR,
  iconDir: ICON_DIR,
  orderFile: ORDER_FILE,
  onChange: (list) => {
    plugins = list;
  },
});
const resolveExe = pluginService.resolveExe;
const findArgs = winmgr.findArgs;

// 图标提取（纯 JS）
const iconService = createIconService({
  iconDir: ICON_DIR,
  logFile: PATHS.ICON_LOG,
  nativeImage,
  runWinMgr,
});
const { extractIcon } = iconService;

// 启动 / 退出
const launcher = createLauncher({
  runWinMgr,
  findArgs,
  resolveExe,
  expandPath,
  getPlugin: (id) => pluginService.get(id),
});
const { portOpen, launchDetached, resolveWindow, launchOnly, quitApp } = launcher;

// ---------- 数据目录初始化 ----------

// 打包版第一次运行：把内置的程序配置和图标种到 userData 里，
// 否则新装的用户打开是一片空白。开发模式数据本来就在程序目录，什么都不做。
function ensureDataDirs() {
  seedDataDirs(PATHS, { isPackaged: app.isPackaged, log: (m) => console.log(m) });
}

// ---------- 图标 ----------

// 已经试过自动补图标的 id，避免每次刷新都重跑一遍
const iconAutoTried = new Set();

// 图标优先级：应用自带图标库 > 插件配置的图标 > exe 内嵌图标
async function iconFor(p) {
  const key = p.id;
  if (iconCache.has(key)) return iconCache.get(key);

  const local = path.join(ICON_DIR, `${p.id}.png`);
  if (fs.existsSync(local)) {
    try {
      const img = nativeImage.createFromPath(local);
      if (img && !img.isEmpty()) {
        const u = img.toDataURL();
        iconCache.set(key, u);
        return u;
      }
    } catch {}
  }

  if (p.icon) {
    const f = p.icon.includes("*") ? pluginService.expandGlob(p.icon) : p.icon;
    if (f && fs.existsSync(f)) {
      try {
        const img = nativeImage.createFromPath(f);
        if (img && !img.isEmpty()) {
          const u = img.toDataURL();
          iconCache.set(key, u);
          return u;
        }
      } catch {}
    }
  }

  const exe = resolveExe(p);
  if (exe) {
    // 走到这儿说明本地没有抽好的图标。先给个临时的，同时后台补一张真图，
    // 补到就让界面刷新——不用用户自己右键「重建图标」。
    if (!iconAutoTried.has(p.id)) {
      iconAutoTried.add(p.id);
      extractIcon(exe, p.id, p.iconHint)
        .then((ok) => {
          if (ok) {
            iconCache.delete(p.id);
            if (win) win.webContents.send("icons:healed", 1);
          }
        })
        .catch(() => {});
    }
    try {
      const img = await app.getFileIcon(exe, { size: "large" });
      if (img && !img.isEmpty()) {
        const u = img.toDataURL();
        iconCache.set(key, u);
        return u;
      }
    } catch {}
  }

  iconCache.set(key, null);
  return null;
}

// ---------- 启动 ----------

// 配置里的路径可以写占位符，换机器/换安装位置不用改配置：
//   ${app}    程序目录（开发模式 = 项目根，打包后 = resources/app）
//   ${res}    资源目录（打包后 = resources，winmgr.py 在这儿）
//   ${server} 内置工作台服务的目录
//   ${home}   用户主目录
async function activate(id, opts = {}) {
  const p = pluginService.get(id);
  if (!p) return { ok: false, error: "插件不存在" };
  // 点行：只管收放，不负责启动（allowLaunch 只给全局热键用）
  const allowLaunch = !!opts.allowLaunch;

  if (p.type === "webview") {
    const port = (p.probe && p.probe.port) || 8899;
    // 服务没跑：点行不回应；热键则顺手把它拉起来
    if (!(await portOpen(port))) {
      if (!allowLaunch) return { ok: false, silent: true };
      const lr = await launchOnly(id);
      if (!lr.ok) return lr;
    }
    if (panelVisible) {
      collapsePanel();
      return { ok: true, mode: "hidden", name: p.name };
    }
    expandPanel();
    return { ok: true, mode: "shown", name: p.name };
  }

  const proc = p.find.process;
  const st = await runWinMgr(["state", "--hidden", "--process", proc]);

  // 没在运行：点这一行不回应。启动是胶囊开关的事，
  // 点行只管"收 / 放"，不该顺手把程序拉起来。
  if (!st.ok) {
    if (!allowLaunch) return { ok: false, silent: true };
    const r = await resolveWindow(p);
    if (!r.ok) return { ok: false, error: r.error };
    await runWinMgr(["show", "--hidden", "--process", proc]);
    await runWinMgr(["focus", "--process", proc]);
    activeId = id;
    return { ok: true, mode: "shown", name: p.name, title: r.title };
  }

  // 三态切换的判断全在窗口层：开着→最小化；收着→置顶显示
  const r = await runWinMgr(["toggle", "--hidden", "--process", proc]);
  if (!r.ok) return { ok: false, silent: true };
  activeId = r.action === "minimize" || r.action === "hide" ? null : id;
  return { ok: true, mode: r.action, name: p.name, title: st.title };
}

// 只启动进程，不切换面板
async function runningProcs() {
  const r = await runWinMgr(["procs"]);
  return new Set(r.ok ? r.procs.map((x) => x.toLowerCase()) : []);
}

// ---------- 工作台面板（内置浏览器） ----------
// 面板拆成两块：上面一条自己画的工具条（地址栏 / 前进后退），下面装网页。
// 网页里 window.open、target=_blank 都会被拦下来改成"就在面板里打开"，
// 不再弹出一个系统窗口出去。

const CHROME_H = 36;          // 工具条高度
let chromeView = null;

function navState(wc) {
  let canBack = false;
  let canForward = false;
  try {
    if (wc.navigationHistory) {
      canBack = wc.navigationHistory.canGoBack();
      canForward = wc.navigationHistory.canGoForward();
    } else {
      canBack = !!wc.canGoBack();
      canForward = !!wc.canGoForward();
    }
  } catch {}
  return { url: wc.getURL(), title: wc.getTitle(), canBack, canForward };
}

function pushBrowserState() {
  if (!chromeView || chromeView.webContents.isDestroyed()) return;
  if (!panelView || panelView.webContents.isDestroyed()) return;
  chromeView.webContents.send("browser:state", navState(panelView.webContents));
}

function ensurePanel() {
  if (panelView) return panelView;

  chromeView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "preload-browser.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  chromeView.webContents.loadFile(path.join(__dirname, "renderer", "chrome.html"));
  win.contentView.addChildView(chromeView);

  // 面板里的网页只给最基本的浏览器能力，不带 wb 那套特权接口
  panelView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.contentView.addChildView(panelView);

  const wc = panelView.webContents;

  // 核心：任何"新窗口"都取消，改成在同一块面板里跳转
  wc.setWindowOpenHandler(({ url }) => {
    if (/^(https?|file):/i.test(url)) {
      wc.loadURL(url).catch(() => {});
    }
    return { action: "deny" };
  });

  // 有些页面会主动把弹窗塞给系统浏览器，这里也拦一道
  wc.on("did-create-window", (child) => {
    try {
      child.destroy();
    } catch {}
  });

  wc.on("did-navigate", pushBrowserState);
  wc.on("did-navigate-in-page", pushBrowserState);
  wc.on("did-finish-load", pushBrowserState);
  wc.on("page-title-updated", pushBrowserState);

  return panelView;
}

function lockSize(w, h) {
  try {
    win.setResizable(true);
    win.setMinimumSize(w, h);
    win.setMaximumSize(w, h);
    win.setSize(w, h);
    win.setResizable(false);
  } catch {}
}

function expandPanel() {
  const v = ensurePanel();
  const [x, y] = win.getPosition();
  const wa = screen.getDisplayNearestPoint({ x, y }).workArea;
  const totalW = BAR_W + PANEL_W;

  let nx = x;
  let ny = y;
  if (x + totalW > wa.x + wa.width) nx = Math.max(wa.x, wa.x + wa.width - totalW);
  if (y + PANEL_H > wa.y + wa.height) ny = Math.max(wa.y, wa.y + wa.height - PANEL_H);

  win.setPosition(nx, ny);
  lockSize(totalW, PANEL_H);
  chromeView.setBounds({ x: BAR_W, y: 0, width: PANEL_W, height: CHROME_H });
  v.setBounds({ x: BAR_W, y: CHROME_H, width: PANEL_W, height: PANEL_H - CHROME_H });
  chromeView.setVisible(true);
  v.setVisible(true);
  panelVisible = true;

  // 已经开过就停在原来的页面，不要每次都跳回首页
  const cur = v.webContents.getURL();
  if (!cur) {
    const p = pluginService.get("workbench");
    const home = (p && p.url) || "http://127.0.0.1:8899";
    v.webContents.loadURL(home).catch(() => {});
  }
}

function collapsePanel() {
  panelVisible = false;
  if (panelView) panelView.setVisible(false);
  if (chromeView) chromeView.setVisible(false);
  lockSize(BAR_W, BAR_H);
}

// ---------- 主窗口 ----------

function createWindow() {
  const posFile = POS_FILE;
  let pos = {};
  try {
    pos = JSON.parse(fs.readFileSync(posFile, "utf-8"));
  } catch {}

  win = new BrowserWindow({
    width: BAR_W,
    height: BAR_H,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    title: "AI 悬浮台",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setAlwaysOnTop(true, "floating");
  win.setResizable(false);
  try {
    win.setMinimumSize(BAR_W, BAR_H);
    win.setMaximumSize(BAR_W, BAR_H);
    const b = win.getNativeWindowHandle();
    selfHwnd = b.length >= 8 ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0);
  } catch {}

  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // 让窗口永不抢焦点：否则点非活动窗口时，第一次点击只会被 Windows 用于激活
  // 进程名不能写死 electron.exe —— 打包后是 AI-Workbench.exe
  const selfExeName = path.basename(app.getPath("exe"));
  win.once("show", () => {
    setTimeout(() => runWinMgr(["noactivate", "--process", selfExeName]), 400);
  });

  const savePos = () => {
    try {
      const [x, y] = win.getPosition();
      fs.writeFileSync(posFile, JSON.stringify({ x, y }));
    } catch {}
  };
  win.on("moved", savePos);
  win.on("close", savePos);

  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.on("close", (e) => {
    // 有托盘常驻，Alt+F4 只是收起，真要退出走托盘菜单
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on("show", refreshTray);
  win.on("hide", refreshTray);
  win.on("closed", () => {
    win = null;
  });

  // transparent 窗口的 ready-to-show 不保证触发，得有三重兜底，
  // 否则会出现"进程在跑但看不到窗口"。
  let shown = false;
  const doShow = () => {
    if (shown || !win) return;
    shown = true;
    win.show();
    trace("window shown");
  };
  win.once("ready-to-show", doShow);
  win.webContents.once("did-finish-load", () => setTimeout(doShow, 400));
  setTimeout(doShow, 5000);
}

// ---------- 系统托盘 ----------

function toggleWin() {
  if (!win) return;
  if (!win.isVisible()) {
    win.show();
    try {
      win.moveTop();
    } catch {}
    sunk = false;
    lastFg = 0;                     // 重新开始观察前台
    graceUntil = Date.now() + 5000; // 回来后给 5 秒，别马上又沉下去
  } else if (sunk) {
    // 沉在别的窗口下面但还算"可见"——这时按唤出键应该是把它捞上来，不是藏起来
    try {
      win.moveTop();
    } catch {}
    if (win.isAlwaysOnTop()) win.setAlwaysOnTop(true, "floating");
    sunk = false;
    graceUntil = Date.now() + 5000;
  } else {
    win.hide();
  }
  refreshTray();
}

function buildTrayMenu() {
  const pinned = !!(win && win.isAlwaysOnTop());
  return Menu.buildFromTemplate([
    { label: win && win.isVisible() ? "隐藏悬浮台" : "显示悬浮台", click: toggleWin },
    { type: "separator" },
    {
      label: "窗口置顶",
      type: "checkbox",
      checked: pinned,
      click: (item) => {
        if (!win) return;
        // 取消置顶时 level 必须是 normal，否则 Electron 传 floating 不会真正取消
        win.setAlwaysOnTop(item.checked, item.checked ? "floating" : "normal");
        win.webContents.send("state:changed", { msg: item.checked ? "已置顶" : "已取消置顶" });
        refreshTray();
      },
    },
    {
      label: "点别的窗口时沉到底层",
      type: "checkbox",
      checked: autoHideEnabled,
      click: (item) => {
        autoHideEnabled = item.checked;
        lastFg = 0;
        graceUntil = Date.now() + 3000;
        refreshTray();
      },
    },
    { type: "separator" },
    ...(app.isPackaged
      ? [
          {
            label: "开机自启",
            type: "checkbox",
            checked: app.getLoginItemSettings().openAtLogin,
            click: (item) => {
              app.setLoginItemSettings({
                openAtLogin: item.checked,
                path: process.execPath,
                args: [],
              });
              if (win) {
                win.webContents.send("state:changed", {
                  msg: item.checked ? "已设为开机自启" : "已取消开机自启",
                });
              }
              refreshTray();
            },
          },
          { type: "separator" },
        ]
      : []),
    { label: "打开工作台", click: () => activate("workbench") },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function refreshTray() {
  if (!tray) return;
  tray.setContextMenu(buildTrayMenu());
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(RES_DIR, "assets", "tray.ico"));
  if (icon.isEmpty()) console.error("[tray] 图标加载失败");
  tray = new Tray(icon);
  tray.setToolTip("AI 悬浮台");
  tray.setContextMenu(buildTrayMenu());
  tray.on("click", toggleWin);
  tray.on("double-click", () => {
    if (win) win.show();
  });
}

// ---------- 点别的窗口时沉到底层 ----------

function applyForeground(r) {
  if (!r || r.ok === false) return;
  // 只在**前台窗口发生变化**时才隐藏。
  // 判断"当前前台不是我"会导致取消置顶后立刻消失，用户根本来不及点。
  if (!lastFg) {
    lastFg = r.hwnd;
    return;
  }
  if (r.hwnd === lastFg) return;
  lastFg = r.hwnd;

  if (!win || !win.isVisible()) return;
  if (!autoHideEnabled) return;
  if (panelVisible) return;
  if (win.isAlwaysOnTop()) return;
  if (Date.now() < graceUntil) return;
  if (Date.now() - lastTouch < 300) return;
  if (r.desktop) return;
  if (r.taskbar) return;
  if (selfHwnd && r.hwnd === selfHwnd) {
    sunk = false;
    return;
  }

  // 不藏起来，只让出上层：沉到被点窗口的下面，看得见但被盖住。
  // 直接 hide() 会让人以为程序没了，还得去托盘找回来。
  sunk = true;
  runWinMgr(["bottom", "--process", path.basename(app.getPath("exe"))]).then(() => {
    // 沉底是异步的：这中间用户可能已经按了唤出键，别把他刚捞上来的又压回去
    if (!sunk && win) {
      try {
        win.moveTop();
      } catch {}
    }
    refreshTray();
  });
}

// ---------- 设置 ----------
// 读写交给 modules/settings.js，这里只留一份内存副本给热键逻辑用。

const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
let settings = settingsService.load();
let barHotkey = null;   // 已注册的唤出快捷键

function saveSettings(patch) {
  const r = settingsService.save(patch || {});
  if (r.ok) settings = r.settings;
  return r;
}

// 注册 / 更换唤出快捷键。返回失败原因，好让界面能提示。
function applyBarHotkey() {
  if (barHotkey) {
    try {
      globalShortcut.unregister(barHotkey);
    } catch {}
    barHotkey = null;
  }
  const acc = (settings.toggleHotkey || "").trim();
  if (!acc) return { ok: true, hotkey: "" };
  let ok = false;
  try {
    ok = globalShortcut.register(acc, () => toggleWin());
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (!ok) return { ok: false, error: `${acc} 被别的程序占用了` };
  barHotkey = acc;
  return { ok: true, hotkey: acc };
}

// 常驻助手：盯前台窗口变化，10ms 级响应，比反复起 Python 轮询快一个量级
async function startFgDaemon() {
  if (fgDaemon) return;
  const py = await winmgr.resolvePython();
  if (!py) return;
  try {
    fgDaemon = spawn(py, [WINMGR, "--daemon"], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
  } catch {
    fgDaemon = null;
    return;
  }
  fgDaemon.stdout.on("data", (d) => {
    fgBuf += d.toString();
    let i;
    while ((i = fgBuf.indexOf("\n")) >= 0) {
      const line = fgBuf.slice(0, i).trim();
      fgBuf = fgBuf.slice(i + 1);
      if (!line) continue;
      try {
        applyForeground(JSON.parse(line));
      } catch {}
    }
  });
  fgDaemon.on("exit", () => {
    fgDaemon = null;
    setTimeout(startFgDaemon, 1500);
  });
  fgDaemon.on("error", () => {
    fgDaemon = null;
  });
}

function startAutoHide() {
  startFgDaemon();
  // 兜底：daemon 万一挂了，每 3 秒查一次
  if (autoHideTimer) return;
  autoHideTimer = setInterval(async () => {
    const r = await runWinMgr(["fg"]);
    applyForeground(r);
  }, 3000);
}

// ---------- 快捷键 ----------

function registerHotkeys() {
  globalShortcut.unregisterAll();
  for (const p of plugins) {
    if (!p.hotkey) continue;
    try {
      globalShortcut.register(p.hotkey, () => {
        if (!win) return;
        win.show();
        win.webContents.send("hotkey:trigger", p.id);
        // 热键是快捷启动，允许顺带把没跑的程序拉起来
        activate(p.id, { allowLaunch: true });
      });
    } catch (e) {
      console.error("[hotkey] 注册失败", p.hotkey, e.message);
    }
  }
}

// ---------- 自助添加程序 ----------

const PALETTE = ["#5B8DEF", "#3FA796", "#C0803E", "#8A6FD1", "#D1605B", "#4C9AD1", "#7BA05B", "#C46BA8"];

function slugify(name) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
      .replace(/^-+|-+$/g, "") || "app"
  );
}

function pickColor(seed) {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

// 在程序目录里找图标文件。Electron 应用的 exe 里往往只嵌了通用图标，
// 真图标通常放在 resources 或上一级目录里，所以这里翻一遍。
// Flutter / Tauri 这类程序更深（data/flutter_assets/assets/），多挖几层。
//
// 返回按"像不像应用主图标"排好序的候选列表——不返回单个，
// 因为有的程序目录里躺着一堆 canvas.ico / md.ico 这种功能性图标，
// 只挑一个很容易挑错。
//
// 关键：只返回"看起来像应用图标"的。有些应用的 resources 里只有
// base.ico / canvas.ico / md.ico，全是文件类型图标，挑哪个都错——
// 这种情况应该返回空，让上层去 exe 内嵌图标里取。
function reloadPlugins() {
  plugins = pluginService.reload();
  registerHotkeys();
}

// 自愈：图标文件不见了、或者小到明显是「糊的通用图标」，就重新抽一次。
// 覆盖三种情况——打包版升级后新多出来的程序、用户手动删过图标文件、
// 以及早期版本抽错过（存下一张 32px 的白框但一直没被覆盖）。
const ICON_MIN_BYTES = 5000;
async function healMissingIcons() {
  let healed = 0;
  for (const p of plugins) {
    // 工作台这类自带手绘图标的条目跳过，它的图标本来就不大，
    // 重抽只会把好看的那张覆盖掉。
    if (p.type === "webview" || p.keepIcon) continue;
    const f = path.join(ICON_DIR, `${p.id}.png`);
    let ok = false;
    try {
      if (fs.existsSync(f)) {
        const sz = fs.statSync(f).size;
        // 够大就当它是好的；太小说明是通用图标放大出来的，重抽
        if (sz >= ICON_MIN_BYTES) continue;
      }
    } catch {
      continue;
    }
    const exe = resolveExe(p);
    if (!exe) continue;
    ok = await extractIcon(exe, p.id, p.iconHint);
    if (ok) {
      iconCache.delete(p.id);
      healed++;
    }
  }
  if (healed && win) {
    win.webContents.send("icons:healed", healed);
  }
  return healed;
}

// 注册表里的关联路径有时是失效的（程序搬家了但注册表没改，
// 比如注册表指向 A 盘，实际装在 D 盘）。
// 路径不在了就按程序名到已知安装目录里找一遍。
const FIX_DIRS = [
  "D:\\software",
  "D:\\AI",
  "C:\\Program Files",
  "C:\\Program Files (x86)",
  path.join(process.env.LOCALAPPDATA || "", "Programs"),
];

function findProgramByName(name) {
  if (!name) return null;
  const stem = name.replace(/\.(exe|bat|cmd)$/i, "").toLowerCase();
  if (!stem) return null;

  for (const root of FIX_DIRS) {
    if (!root || !fs.existsSync(root)) continue;
    // 只看两层目录，避免全盘扫描
    const stack = [[root, 0]];
    while (stack.length) {
      const [dir, depth] = stack.pop();
      let items = [];
      try {
        items = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const it of items) {
        const full = path.join(dir, it.name);
        if (it.isDirectory()) {
          if (depth < 2) stack.push([full, depth + 1]);
          continue;
        }
        if (!/\.(exe|bat|cmd)$/i.test(it.name)) continue;
        if (it.name.replace(/\.(exe|bat|cmd)$/i, "").toLowerCase() === stem) {
          return full;
        }
      }
    }
  }
  return null;
}

// 把「选文件 → 查关联 → 挂到程序上」这条链拆成独立函数，方便单测
async function assocFor(file) {
  const ext = path.extname(file).toLowerCase();

  // 选中的文件本身就是可执行文件：它就是程序，不用查关联。
  // .exe 的注册表关联是 `"%1" %*`，查了也是白查。
  if (/\.(exe|bat|cmd)$/i.test(ext)) {
    return { ok: true, exe: file, prog: null, name: null, self: true };
  }

  // 快捷方式：解析出它真正指向的程序，参数、工作目录、图标都保留
  if (ext === ".lnk") {
    const r = await runWinMgr(["lnk", "--src", file], 30000);
    if (!r.ok || !r.target) {
      return { ok: false, error: (r && r.error) || "这个快捷方式解析不了" };
    }
    return {
      ok: true,
      exe: r.target,
      prog: null,
      name: null,
      self: false,
      lnk: file,
      args: r.args || "",
      workdir: r.workdir || "",
      icon: r.icon || null,
    };
  }

  if (!ext) return { ok: false, error: "这文件没有扩展名，不知道该用什么打开" };

  const r = await runWinMgr(["assoc", "--ext", ext]);
  if (!r.ok) return { ok: false, error: "查不到文件关联" };

  const all = r.candidates || [];
  const cands = all.filter((c) => c.exe);
  if (!cands.length) {
    return { ok: false, error: `系统里没有能打开 ${ext} 的程序` };
  }

  // 默认程序排第一（assoc 命令已经按 default → 其它候选排好序了）。
  // 它的路径可能失效，但那是"用户指定的默认"，路径修好了依然该用它。
  const order = [];
  if (r.default) {
    const d = cands.find((c) => c.prog === r.default);
    if (d) order.push(d);
  }
  for (const c of cands) if (!order.includes(c)) order.push(c);

  // 按优先级逐个试：默认程序最优先，其次是"打开方式"里的其它候选。
  // 每个候选先看原路径，再尝试修复路径——两者都不行才轮到下一个。
  // 这样 "注册表里关联的路径失效" 也能正确落到真实程序，
  // 而不是被 OpenWithProgids 里的次要候选抢走。
  for (const c of order) {
    try {
      if (fs.existsSync(c.exe)) {
        return { ok: true, exe: c.exe, prog: c.prog, name: c.name || path.basename(c.exe, ".exe") };
      }
    } catch {}
    const fixed = findProgramByName(path.basename(c.exe));
    if (fixed) {
      return { ok: true, exe: fixed, prog: c.prog, name: c.name || path.basename(fixed, ".exe"), fixed: true };
    }
  }

  // 全都找不到就用第一个，至少让用户看到候选
  const c = order[0];
  return {
    ok: true,
    exe: c.exe,
    prog: c.prog,
    name: c.name || path.basename(c.exe, ".exe"),
    missing: true,
  };
}

// 读 exe 自己的显示名（wps.exe → "WPS Writer"）
async function displayName(exe) {
  const r = await runWinMgr(["verinfo", "--src", exe], 20000);
  if (r.ok && r.name) return r.name;
  return path.basename(exe).replace(/\.(exe|bat|cmd)$/i, "");
}

// 注册一个程序（如果还没注册过），返回插件 id
async function ensureProgram(exe, opt = {}) {
  // 路径必须像个真的程序：带盘符、不是占位符、扩展名对得上
  if (!exe || /%/.test(exe) || !/^[a-z]:[\\/]/i.test(exe)) {
    return { ok: false, error: `不是有效的程序路径：${exe || "(空)"}` };
  }
  if (!/\.(exe|bat|cmd)$/i.test(exe)) {
    return { ok: false, error: `不是可执行文件：${exe}` };
  }

  const exist = pluginService.findByExe(exe);
  if (exist) {
    // 已经登记过了：把快捷方式带来的参数和工作目录补上。
    // 之前只在有 args 时才写，导致 args 为空但 workdir 有值的快捷方式会漏掉工作目录。
    const L = exist.launch || {};
    let changed = false;
    if (opt.args && !(L.args || []).length) {
      L.args = opt.args.split(/\s+/).filter(Boolean);
      changed = true;
    }
    // 已经登记过了：参数和工作目录补上，**图标也要补**。
    // 之前这条路只做参数补全、完全不管图标，于是「再添加一次已有的程序」
    // 永远拿不到图标，界面只能退回到 32px 的通用图（白框就是这么来的）。
    if (opt.workdir && !L.workdir) {
      L.workdir = opt.workdir;
      changed = true;
    }
    if (changed) {
      const file = path.join(PLUGIN_DIR, `${exist.id}.json`);
      try {
        const cfg = JSON.parse(fs.readFileSync(file, "utf-8"));
        cfg.launch = Object.assign({}, cfg.launch, {
          args: L.args || [],
          workdir: L.workdir || cfg.launch.workdir || "",
        });
        fs.writeFileSync(file, JSON.stringify(cfg, null, 2), "utf-8");
      } catch {}
    }

    // 图标缺失、或者小得明显是张糊图，就趁这次补一张
    const iconPath = path.join(ICON_DIR, `${exist.id}.png`);
    let needIcon = true;
    try {
      needIcon = !fs.existsSync(iconPath) || fs.statSync(iconPath).size < ICON_MIN_BYTES;
    } catch {}
    if (needIcon) {
      const hint = opt.iconHint || exist.iconHint || "";
      const ok = await extractIcon(exe, exist.id, hint);
      if (ok) {
        iconCache.delete(exist.id);
        if (hint && !exist.iconHint) {
          exist.iconHint = hint;
          try {
            const file = path.join(PLUGIN_DIR, `${exist.id}.json`);
            const cfg = JSON.parse(fs.readFileSync(file, "utf-8"));
            cfg.iconHint = hint;
            fs.writeFileSync(file, JSON.stringify(cfg, null, 2), "utf-8");
          } catch {}
        }
      }
    }

    return { ok: true, id: exist.id, existed: true, name: exist.name };
  }

  const name = opt.name || (await displayName(exe));
  const id = slugify(name) || slugify(path.basename(exe));
  const file = path.join(PLUGIN_DIR, `${id}.json`);
  if (fs.existsSync(file)) {
    const r2 = await registerProgram(exe);
    return { ok: r2.ok, id: r2.id, error: r2.error };
  }

  // 不给程序自动配快捷键：Ctrl+Alt+数字 很容易和别的软件撞，
  // 而且平时点一下就够了，不需要记。
  const hotkey = null;

  await extractIcon(exe, id, opt.iconHint);

  const cfg = {
    id,
    name,
    short: name.slice(0, 2),
    color: pickColor(name),
    type: "app",
    enabled: true,
    launch: {
      path: exe.replace(/\\/g, "/"),
      args: opt.args ? opt.args.split(/\s+/).filter(Boolean) : [],
      workdir: opt.workdir || "",
      pathGlob: null,
    },
    find: { process: path.basename(exe), class: null, title: null },
    hotkey,
    // 记住图标来源，以后重建时不用重新猜
    iconHint: opt.iconHint || "",
    note: opt.name ? "由快捷方式添加" : "由文件关联自动添加",
    addedAt: new Date().toISOString().slice(0, 10),
  };
  try {
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2), "utf-8");
  } catch (e) {
    return { ok: false, error: `写入配置失败：${e.message}` };
  }
  reloadPlugins();
  iconCache.delete(id);
  return { ok: true, id, name, hotkey };
}

// 加一个文件：查它该用哪个程序打开，然后把文件挂到那个程序上
async function addFile(filePath) {
  if (!filePath) return { ok: false, error: "没拿到文件路径" };
  try {
    if (!fs.existsSync(filePath)) return { ok: false, error: `文件不存在：${filePath}` };
  } catch {
    return { ok: false, error: "路径无效" };
  }

  const a = await assocFor(filePath);
  if (!a.ok) return { ok: false, error: a.error };

  // 快捷方式：名字用快捷方式自己的，图标也用快捷方式指定的
  let name = null;
  let iconHint = null;
  if (a.lnk) {
    name = path.basename(filePath).replace(/\.lnk$/i, "");
    iconHint = a.icon;
  }

  const pr = await ensureProgram(a.exe, {
    name,
    iconHint,
    args: a.args || "",
    workdir: a.workdir || "",
  });
  if (!pr.ok) return { ok: false, error: pr.error || "添加程序失败" };

  // 把文件记到该程序的 files 列表里
  const p = pluginService.get(pr.id);
  if (p) {
    p.files = p.files || [];
    if (!p.files.some((f) => f.toLowerCase() === filePath.toLowerCase())) {
      p.files.push(filePath);
    }
    const file = path.join(PLUGIN_DIR, `${p.id}.json`);
    try {
      const cfg = JSON.parse(fs.readFileSync(file, "utf-8"));
      cfg.files = p.files;
      fs.writeFileSync(file, JSON.stringify(cfg, null, 2), "utf-8");
    } catch {}
  }

  return {
    ok: true,
    id: pr.id,
    name: pr.name || (p && p.name) || a.name,
    file: path.basename(filePath),
    filePath,
    existed: !!pr.existed,
    missing: !!a.missing,
    isLnk: !!a.lnk,
  };
}

async function registerProgram(exe) {
  const name = path.basename(exe).replace(/\.(exe|bat|cmd)$/i, "");
  const id = slugify(name);
  const file = path.join(PLUGIN_DIR, `${id}.json`);
  if (fs.existsSync(file)) return { ok: false, error: `「${name}」已经在列表里了` };

  // 同样不自动配快捷键
  const hotkey = null;

  const hasIcon = await extractIcon(exe, id);

  const cfg = {
    id,
    name,
    short: name.slice(0, 2),
    color: pickColor(name),
    type: "app",
    enabled: true,
    launch: { path: exe.replace(/\\/g, "/"), args: [], pathGlob: null },
    find: { process: path.basename(exe), class: null, title: null },
    hotkey,
    note: "手动添加",
    addedAt: new Date().toISOString().slice(0, 10),
  };
  try {
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2), "utf-8");
  } catch (e) {
    return { ok: false, error: `写入配置失败：${e.message}` };
  }

  reloadPlugins();
  iconCache.delete(id);
  return { ok: true, id, name, icon: hasIcon, hotkey };
}

// 用指定程序打开某个文件
async function openFileWith(programExe, filePath) {
  // 直接 spawn 程序、把文件作为参数传过去。
  // 不用 cmd /c start：那条路上引号会被 cmd 再解析一遍，
  // 文件名里有空格或中文时经常传不对。
  try {
    spawn(programExe, [filePath], {
      detached: true,
      stdio: "ignore",
      cwd: path.dirname(programExe),
    }).unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------- IPC ----------

ipcMain.handle("plugins:list", async () => {
  const procs = await runningProcs();
  const webviewAlive = {};
  const icons = {};

  await Promise.all(
    plugins.map(async (p) => {
      if (p.type === "webview") {
        webviewAlive[p.id] = await portOpen((p.probe && p.probe.port) || 8899);
      }
      icons[p.id] = await iconFor(p);
    })
  );

  return plugins.map((p) => ({
    id: p.id,
    name: p.name,
    short: p.short || p.name.slice(0, 1),
    color: p.color || "#534AB7",
    type: p.type || "app",
    note: p.note || "",
    hotkey: p.hotkey || "",
    icon: icons[p.id] || null,
    launchPath: resolveExe(p) || "",
    files: (p.files || []).map((f) => ({
      path: f,
      name: path.basename(f),
      dir: path.dirname(f),
    })),
    exeOk: p.type === "webview" ? true : !!resolveExe(p),
    running:
      p.type === "webview"
        ? !!webviewAlive[p.id]
        : procs.has(((p.find && p.find.process) || "").toLowerCase()),
    active: p.id === activeId,
  }));
});

ipcMain.handle("plugin:activate", async (_e, id) => {
  const r = await activate(id);
  if (win) win.webContents.send("state:changed", { id, msg: r.msg || r.error || "" });
  return r;
});

ipcMain.handle("plugin:launch", async (_e, id) => {
  const r = await launchOnly(id);
  if (win) win.webContents.send("state:changed", { id, msg: r.msg || r.error || "" });
  return r;
});

ipcMain.handle("plugin:quit", async (_e, id) => {
  const r = await quitApp(id);
  if (win) win.webContents.send("state:changed", { id, msg: r.msg || r.error || "" });
  return r;
});

ipcMain.handle("plugins:reload", async () => {
  reloadPlugins();
  return { ok: true };
});

// 扫描常用目录里可直接添加的程序
const SCAN_DIRS = [
  "D:\\software",
  "C:\\Program Files",
  "C:\\Program Files (x86)",
  path.join(process.env.USERPROFILE || "", "Desktop"),
];
const SKIP_NAME = /^(unins|uninstall|repair|update|setup|install|crash|vcredist|vc_redist)/i;

ipcMain.handle("app:scanPrograms", async () => {
  const known = new Set(
    plugins.map((p) => ((p.launch && p.launch.path) || "").toLowerCase())
  );
  const out = [];
  const seen = new Set();
  const seenName = new Set();

  for (const root of SCAN_DIRS) {
    if (!root || !fs.existsSync(root)) continue;
    const stack = [[root, 0]];
    while (stack.length) {
      const [dir, depth] = stack.pop();
      let items = [];
      try {
        items = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const it of items) {
        const full = path.join(dir, it.name);
        if (it.isDirectory()) {
          if (depth < 2) stack.push([full, depth + 1]);
          continue;
        }
        if (!/\.(exe|bat|cmd)$/i.test(it.name)) continue;
        if (SKIP_NAME.test(it.name)) continue;
        const key = full.toLowerCase();
        if (seen.has(key) || known.has(key)) continue;
        const nm = path.basename(full).replace(/\.(exe|bat|cmd)$/i, "");
        // 同名程序只留第一个，免得列表被 7z、7zFM、7zG 这类刷屏
        const nk = nm.toLowerCase();
        if (seenName.has(nk)) continue;
        seenName.add(nk);
        seen.add(key);
        out.push({ path: full, name: nm, dir });
      }
    }
  }

  out.sort((a, b) => a.name.localeCompare(b.name, "zh"));
  return out.slice(0, 300);
});

ipcMain.handle("app:addProgramPath", async (_e, exe) => {
  if (!exe) return { ok: false, error: "没拿到文件路径" };
  try {
    if (!fs.existsSync(exe)) return { ok: false, error: `文件不存在：${exe}` };
  } catch {
    return { ok: false, error: "路径无效" };
  }
  return registerProgram(exe);
});

// 添加文件：查关联 → 找到该用的程序 → 把文件挂上去
ipcMain.handle("app:addFile", async (_e, filePath) => {
  return addFile(filePath);
});

// 弹出文件选择框，让用户挑一个文件
ipcMain.handle("app:pickFile", async () => {
  // 注意：不能用透明无边框窗口当 parent，那会让模态框起不来。
  // 这里不传 parent，Electron 会用独立窗口承载。
  const res = await dialog.showOpenDialog({
    title: "选一个文件",
    properties: ["openFile"],
    filters: [
      { name: "所有文件", extensions: ["*"] },
      { name: "快捷方式", extensions: ["lnk"] },
      { name: "程序", extensions: ["exe", "bat", "cmd"] },
      { name: "文档", extensions: ["md", "txt", "doc", "docx", "pdf", "csv", "xlsx", "pptx"] },
    ],
  });
  if (res.canceled || !res.filePaths || !res.filePaths.length) {
    return { ok: false, canceled: true };
  }
  return { ok: true, path: res.filePaths[0] };
});

// 打开该程序的某个文件
ipcMain.handle("app:openFile", async (_e, id, filePath) => {
  const p = pluginService.get(id);
  if (!p) return { ok: false, error: "找不到这个程序" };
  const exe = resolveExe(p);
  if (!exe) return { ok: false, error: "找不到可执行文件" };
  try {
    if (!fs.existsSync(filePath)) return { ok: false, error: "文件已经不在了" };
  } catch {
    return { ok: false, error: "路径无效" };
  }

  // 快捷方式本身：直接跑它，参数和工作目录由快捷方式自己决定
  if (/\.lnk$/i.test(filePath)) {
    const r = await runWinMgr(["lnk", "--src", filePath], 30000);
    if (r.ok && r.target) {
      try {
        spawn(r.target, r.args ? r.args.split(/\s+/).filter(Boolean) : [], {
          detached: true,
          stdio: "ignore",
          cwd: r.workdir || path.dirname(r.target),
        }).unref();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
  }

  await openFileWith(exe, filePath);
  return { ok: true };
});

// 用任意指定的程序打开某个文件
ipcMain.handle("app:openFileWith", async (_e, exe, filePath) => {
  if (!exe) return { ok: false, error: "没指定程序" };
  try {
    if (!fs.existsSync(exe)) return { ok: false, error: "程序不存在" };
  } catch {
    return { ok: false, error: "路径无效" };
  }
  return openFileWith(exe, filePath);
});

// 重新提取某个程序的图标（右键菜单用）
ipcMain.handle("app:rebuildIcon", async (_e, id) => {
  const p = pluginService.get(id);
  if (!p) return { ok: false, error: "找不到这个程序" };
  const exe = resolveExe(p);
  if (!exe) return { ok: false, error: "找不到可执行文件" };
  const ok = await extractIcon(exe, p.id, p.iconHint);
  iconCache.delete(p.id);
  return ok ? { ok: true } : { ok: false, error: "没能提取到图标" };
});

// 解除某个文件与程序的绑定
ipcMain.handle("app:detachFile", async (_e, id, filePath) => {
  const p = pluginService.get(id);
  if (!p) return { ok: false, error: "找不到这个程序" };
  const file = path.join(PLUGIN_DIR, `${id}.json`);
  try {
    const cfg = JSON.parse(fs.readFileSync(file, "utf-8"));
    cfg.files = (cfg.files || []).filter((f) => f !== filePath);
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2), "utf-8");
  } catch (e) {
    return { ok: false, error: e.message };
  }
  p.files = (p.files || []).filter((f) => f !== filePath);
  return { ok: true };
});

// 用另一个程序打开这个文件（换一个关联）
ipcMain.handle("app:openWith", async (_e, filePath) => {
  const ext = path.extname(filePath || "").toLowerCase();
  const r = await runWinMgr(["assoc", "--ext", ext]);
  const cands = ((r && r.candidates) || []).filter((c) => c.exe);

  // 逐个修路径，保证列出来的都是能用的
  const out = [];
  for (const c of cands) {
    let exe = null;
    try {
      if (fs.existsSync(c.exe)) exe = c.exe;
    } catch {}
    if (!exe) exe = findProgramByName(path.basename(c.exe));
    if (!exe) continue;
    out.push({
      exe,
      prog: c.prog,
      name: c.name || path.basename(exe, ".exe"),
    });
  }
  return { ok: true, candidates: out };
});

// 拖动排序：记下用户排好的顺序，下次启动照这个来
ipcMain.handle("plugins:reorder", async (_e, ids) => {
  if (!Array.isArray(ids) || !ids.length) return { ok: false, error: "顺序无效" };
  const known = new Set(plugins.map((p) => p.id));
  const clean = [];
  for (const id of ids) {
    if (known.has(id) && !clean.includes(id)) clean.push(id);
  }
  // 没出现在列表里的（比如刚好被过滤掉）补到末尾，别弄丢
  for (const p of plugins) {
    if (!clean.includes(p.id)) clean.push(p.id);
  }
  try {
    fs.writeFileSync(ORDER_FILE, JSON.stringify(clean, null, 2), "utf-8");
  } catch (e) {
    return { ok: false, error: `保存顺序失败：${e.message}` };
  }
  plugins = pluginService.reload();
  return { ok: true, order: clean };
});

ipcMain.handle("app:removeProgram", async (_e, id) => {
  const p = pluginService.get(id);
  if (!p) return { ok: false, error: "找不到这个程序" };
  // 没有"内置"这回事：列表里任何一条都可以删。
  // 删掉的只是这一条快捷方式记录，不会动磁盘上的程序本体。
  // 用真实文件名，而不是拼 id —— 配置里的 id 和文件名不保证永远一致
  const file = path.join(PLUGIN_DIR, p._file || `${id}.json`);
  try {
    fs.unlinkSync(file);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  try {
    fs.unlinkSync(path.join(ICON_DIR, `${id}.png`));
  } catch {}
  // 顺手把它从排序表里去掉，别留个指向不存在条目的 id
  try {
    const order = JSON.parse(fs.readFileSync(ORDER_FILE, "utf-8"));
    if (Array.isArray(order)) {
      const left = order.filter((x) => x !== id);
      if (left.length !== order.length) {
        fs.writeFileSync(ORDER_FILE, JSON.stringify(left, null, 2), "utf-8");
      }
    }
  } catch {}
  iconCache.delete(id);
  reloadPlugins();
  return { ok: true, name: p.name };
});

ipcMain.handle("app:openExternal", async (_e, url) => {
  if (url) shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle("win:touch", () => {
  lastTouch = Date.now();
});

ipcMain.handle("win:getPos", () => (win ? win.getPosition() : [0, 0]));

ipcMain.handle("win:setPos", (_e, x, y) => {
  if (!win) return;
  // 夹在屏幕工作区内，避免把悬浮台拖到看不见的地方
  const wa = screen.getDisplayNearestPoint({ x, y }).workArea;
  const [w, h] = win.getSize();
  const nx = Math.min(Math.max(Math.round(x), wa.x), wa.x + wa.width - w);
  const ny = Math.min(Math.max(Math.round(y), wa.y), wa.y + wa.height - h);
  win.setPosition(nx, ny);
});

ipcMain.handle("win:pin", (_e, on) => {
  if (!win) return false;
  const next = typeof on === "boolean" ? on : !win.isAlwaysOnTop();
  // 取消置顶时 level 必须是 normal，否则 Electron 传 floating 不会真正取消
  win.setAlwaysOnTop(next, next ? "floating" : "normal");
  return next;
});

// ---------- 内置浏览器 ----------

// 用户输入的东西可能是网址、也可能是本机路径，统一成能 load 的 URL
function normalizeUrl(raw) {
  let s = String(raw || "").trim();
  if (!s) return null;
  if (/^(https?|file|about|data):/i.test(s)) return s;
  // 本地路径：C:\xxx 或 /xxx 或 \\server\share
  if (/^[a-z]:[\\/]/i.test(s) || s.startsWith("\\\\")) {
    return "file:///" + s.replace(/\\/g, "/");
  }
  if (/^localhost(:\d+)?/i.test(s) || /^127\.0\.0\.1(:\d+)?/.test(s)) return "http://" + s;
  // 看着像域名就补 http
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/.test(s)) return "http://" + s;
  // 其它就当成主机名硬拼 http，让它自己报错——比默默跳回首页好懂
  if (/^[\w-]+(:\d+)?(\/.*)?$/.test(s)) return "http://" + s;
  return null;
}

ipcMain.handle("browser:go", async (_e, raw) => {
  const u = normalizeUrl(raw);
  if (!u || !panelView) return { ok: false, error: "地址看不懂" };
  try {
    await panelView.webContents.loadURL(u);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle("browser:back", () => {
  try {
    const wc = panelView && panelView.webContents;
    if (!wc) return { ok: false };
    const h = wc.navigationHistory;
    if (h ? h.canGoBack() : wc.canGoBack()) (h ? h.goBack() : wc.goBack());
    return { ok: true };
  } catch {
    return { ok: false };
  }
});

ipcMain.handle("browser:forward", () => {
  try {
    const wc = panelView && panelView.webContents;
    if (!wc) return { ok: false };
    const h = wc.navigationHistory;
    if (h ? h.canGoForward() : wc.canGoForward()) (h ? h.goForward() : wc.goForward());
    return { ok: true };
  } catch {
    return { ok: false };
  }
});

ipcMain.handle("browser:reload", () => {
  try {
    panelView && panelView.webContents.reload();
    return { ok: true };
  } catch {
    return { ok: false };
  }
});

// 有些页面确实得用真正的浏览器看，留个逃生口
ipcMain.handle("browser:external", () => {
  try {
    const u = panelView && panelView.webContents.getURL();
    if (u) shell.openExternal(u);
    return { ok: true };
  } catch {
    return { ok: false };
  }
});

ipcMain.handle("browser:home", async () => {
  const p = pluginService.get("workbench");
  const home = (p && p.url) || "http://127.0.0.1:8899";
  try {
    await panelView.webContents.loadURL(home);
    return { ok: true };
  } catch {
    return { ok: false };
  }
});

ipcMain.handle("win:isPinned", () => (win ? win.isAlwaysOnTop() : false));

// ---------- 设置 ----------

ipcMain.handle("settings:get", () => ({
  toggleHotkey: settings.toggleHotkey || "",
  registered: !!barHotkey,
}));

ipcMain.handle("settings:setHotkey", async (_e, acc) => {
  const prev = settings.toggleHotkey;
  settings.toggleHotkey = String(acc || "").trim();
  const r = applyBarHotkey();
  if (!r.ok) {
    // 注册失败就退回原来的，别让设置里留一个用不了的键
    settings.toggleHotkey = prev;
    applyBarHotkey();
    return { ok: false, error: r.error };
  }
  saveSettings();
  return { ok: true, hotkey: settings.toggleHotkey };
});

// 录制快捷键时临时解除"永不激活"，否则收不到键盘
ipcMain.handle("settings:beginCapture", async () => {
  const name = path.basename(app.getPath("exe"));
  await runWinMgr(["activate", "--process", name]);
  if (win) {
    win.focus();
    win.webContents.focus();
  }
  return { ok: true };
});

ipcMain.handle("settings:endCapture", async () => {
  const name = path.basename(app.getPath("exe"));
  await runWinMgr(["noactivate", "--process", name]);
  if (win) win.blur();
  return { ok: true };
});

ipcMain.handle("app:quit", () => {
  isQuitting = true;
  app.quit();
  return { ok: true };
});

// 点 × 只是收进托盘，进程继续跑着。真要退出走托盘右键的「退出」。
let trayHinted = false;
ipcMain.handle("win:toTray", () => {
  if (!win) return { ok: false, error: "窗口不在" };
  win.hide();
  refreshTray();
  if (tray && !trayHinted) {
    trayHinted = true;
    try {
      tray.displayBalloon({
        title: "AI 悬浮台",
        content: "已收进托盘。点托盘图标可以再打开，右键选「退出」才是真的关掉。",
      });
    } catch {}
  }
  return { ok: true };
});

ipcMain.handle("panel:hide", () => {
  if (panelVisible) collapsePanel();
  return { ok: true };
});

// ---------- 生命周期 ----------

app.on("second-instance", () => {
  if (!win) return;
  win.show();
  win.setAlwaysOnTop(true, "floating");
  lastFg = 0;
  graceUntil = Date.now() + 4000;
  refreshTray();
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("window-all-closed", () => {
  // 托盘常驻，窗口全关了也不退出
  globalShortcut.unregisterAll();
  if (isQuitting && process.platform !== "darwin") app.quit();
});

const _dbg = (tag, e) => {
  try {
    require("fs").appendFileSync(
      require("path").join(require("os").tmpdir(), "wb-crash.txt"),
      `[${tag}] ${(e && e.stack) || e}\n\n`
    );
  } catch {}
};
process.on("uncaughtException", (e) => _dbg("uncaught", e));
process.on("unhandledRejection", (e) => _dbg("unhandled", e));

app.whenReady().then(async () => {
  trace("whenReady, packaged=" + app.isPackaged + " data=" + DATA_DIR + " res=" + RES_DIR);
  if (isSecondInstance) return;
  ensureDataDirs();
  trace("ensureDataDirs done");
  disableProxy(session);
  settings = settingsService.load();
  const py = await winmgr.resolvePython();
  trace("python resolved: " + py);
  plugins = pluginService.reload();
  trace("plugins loaded: " + plugins.length);
  createWindow();
  trace("window created");
  createTray();
  registerHotkeys();
  const hk = applyBarHotkey();
  trace("bar hotkey: " + JSON.stringify(hk));
  startAutoHide();
  trace("ready");
  // 图标自愈放后台跑，不拖慢启动
  healMissingIcons().catch(() => {});
});
