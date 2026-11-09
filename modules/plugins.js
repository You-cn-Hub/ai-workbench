/**
 * 插件（程序条目）的读写 —— 一个条目就是一个本地程序的快捷方式。
 *
 * 职责边界：
 *   - 这个模块负责「条目存在哪、什么顺序、怎么存」
 *   - 启动 / 退出程序是 launcher 的事，这里不碰
 *   - 图标提取是 icons 的事，这里只负责把图标路径要用的参数传过去
 */

const fs = require("fs");
const path = require("path");

/**
 * @param {object} deps
 * @param {string} deps.pluginDir   插件配置目录
 * @param {string} deps.iconDir     图标目录
 * @param {string} deps.orderFile   排序文件
 * @param {Function} deps.onChange   插件列表变化后的回调（通常用来刷新托盘 / 界面）
 */
function createPluginService(deps) {
  const { pluginDir: PLUGIN_DIR, iconDir: ICON_DIR, orderFile: ORDER_FILE, onChange = () => {} } = deps;

  let plugins = [];

  // ---------- 路径解析 ----------

  // 通配符展开：把 "D:/app/*/App.exe" 这种模式变成实际存在的那个文件
  function expandGlob(pattern) {
    // 正反斜杠都接受：配置里手写和脚本生成的路径风格不一定一致
    const parts = pattern.replace(/\//g, "\\").split("\\");
    let cur = [parts[0] + "\\"];
    for (let i = 1; i < parts.length; i++) {
      const seg = parts[i];
      const next = [];
      for (const base of cur) {
        if (seg === "*") {
          try {
            for (const d of fs.readdirSync(base, { withFileTypes: true })) {
              next.push(path.join(base, d.name));
            }
          } catch {}
        } else next.push(path.join(base, seg));
      }
      cur = next;
    }
    return cur.filter((p) => fs.existsSync(p)).sort().pop() || null;
  }

  /** 拿到条目对应的可执行文件路径（支持 path / pathGlob 两种配置） */
  function resolveExe(p) {
    const L = (p && p.launch) || {};
    if (L.path && fs.existsSync(L.path)) return L.path;
    if (L.pathGlob) {
      const f = expandGlob(L.pathGlob);
      if (f) return f;
    }
    return null;
  }

  // ---------- 排序 ----------

  /** 用户拖动排过序就按那份顺序来；没排过退回「快捷键尾号 + 名字」 */
  function readOrder() {
    try {
      const raw = JSON.parse(fs.readFileSync(ORDER_FILE, "utf-8"));
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  function writeOrder(ids) {
    fs.writeFileSync(ORDER_FILE, JSON.stringify(ids, null, 2), "utf-8");
  }

  function rank(p) {
    const m = /(\d+)\s*$/.exec(p.hotkey || "");
    return m ? parseInt(m[1], 10) : 99;
  }

  // ---------- 读写 ----------

  function load() {
    if (!fs.existsSync(PLUGIN_DIR)) return [];
    const list = fs
      .readdirSync(PLUGIN_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          const p = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, f), "utf-8"));
          p._file = f;
          return p;
        } catch (e) {
          console.error("[plugin] 解析失败", f, e.message);
          return null;
        }
      })
      .filter((p) => p && p.enabled !== false && p.id);

    const order = readOrder();
    const idx = (p) => {
      const i = order.indexOf(p.id);
      return i < 0 ? 9999 : i;
    };
    return list.sort(
      (a, b) => idx(a) - idx(b) || rank(a) - rank(b) || a.name.localeCompare(b.name)
    );
  }

  function reload() {
    plugins = load();
    onChange(plugins);
    return plugins;
  }

  function all() {
    return plugins;
  }

  function get(id) {
    return plugins.find((x) => x.id === id) || null;
  }

  /** 按可执行文件路径查条目（路径比较不区分大小写和斜杠方向） */
  function findByExe(exe) {
    const key = String(exe).replace(/\\/g, "/").toLowerCase();
    return (
      plugins.find(
        (p) => ((p.launch && p.launch.path) || "").replace(/\\/g, "/").toLowerCase() === key
      ) || null
    );
  }

  /** 保存一个条目的配置 */
  function save(p) {
    const file = path.join(PLUGIN_DIR, p._file || `${p.id}.json`);
    const cfg = Object.assign({}, p);
    delete cfg._file;
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2), "utf-8");
    p._file = path.basename(file);
    return file;
  }

  /** 删除条目：连图标和排序表里的位置一起清掉 */
  function remove(id) {
    const p = get(id);
    if (!p) return { ok: false, error: "找不到这个程序" };
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
      const order = readOrder();
      const left = order.filter((x) => x !== id);
      if (left.length !== order.length) writeOrder(left);
    } catch {}
    reload();
    return { ok: true, name: p.name };
  }

  /** 拖动排序后保存新顺序 */
  function reorder(ids) {
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
      writeOrder(clean);
    } catch (e) {
      return { ok: false, error: `保存顺序失败：${e.message}` };
    }
    reload();
    return { ok: true, order: clean };
  }

  return {
    all,
    get,
    findByExe,
    load,
    reload,
    save,
    remove,
    reorder,
    resolveExe,
    expandGlob,
    readOrder,
    writeOrder,
  };
}

module.exports = { createPluginService };
