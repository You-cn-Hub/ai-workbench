/**
 * 日志 —— 分两路：
 *   trace  排查用，写临时文件，设了 WB_TRACE=1 才开
 *   error  真出错了，要让用户能自己看到
 *
 * 用户那边没有控制台，所以关键信息必须落到文件里。
 */

const fs = require("fs");
const path = require("path");

/**
 * @param {object} deps
 * @param {string} deps.traceFile  trace 日志路径
 * @param {boolean} deps.enabled   是否开启 trace
 */
function createLogger(deps) {
  const { traceFile: TRACE_FILE, enabled = false } = deps;

  function trace(msg) {
    if (!enabled) return;
    try {
      const line = `[${new Date().toISOString()}] ${msg}\n`;
      fs.appendFileSync(TRACE_FILE, line, "utf-8");
    } catch {}
  }

  function error(msg, err) {
    const line = `[${new Date().toISOString()}] ${msg}${err ? " " + (err.stack || err.message || err) : ""}\n`;
    try {
      console.error(line.trim());
    } catch {}
    try {
      fs.appendFileSync(TRACE_FILE, line, "utf-8");
    } catch {}
  }

  return { trace, error };
}

module.exports = { createLogger };
