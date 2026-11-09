/**
 * 设置项的读写 —— 目前只有「唤出悬浮台的快捷键」一项。
 *
 * 存成 JSON 放在数据目录，损坏时退回默认值而不是崩。
 */

const fs = require("fs");

const DEFAULTS = { toggleHotkey: "Ctrl+F9" };

/**
 * @param {object} deps
 * @param {string} deps.settingsFile  设置文件路径
 */
function createSettings(deps) {
  const { settingsFile: SETTINGS_FILE } = deps;
  let cache = null;

  function load() {
    if (cache) return cache;
    try {
      const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
      cache = Object.assign({}, DEFAULTS, raw);
    } catch {
      cache = Object.assign({}, DEFAULTS);
    }
    return cache;
  }

  function save(patch) {
    cache = Object.assign({}, load(), patch);
    try {
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(cache, null, 2), "utf-8");
    } catch (e) {
      console.error("[settings] 保存失败:", e.message);
      return { ok: false, error: e.message };
    }
    return { ok: true, settings: cache };
  }

  return { load, save, get: () => load() };
}

module.exports = { createSettings, SETTINGS_DEFAULTS: DEFAULTS };
