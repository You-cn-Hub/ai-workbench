/**
 * 与 winmgr.py 的桥接 —— 负责定位 Python、执行窗口管理命令。
 *
 * 为什么需要 Python：
 *   Windows 上按进程名找窗口、读窗口位置、置顶这些操作，
 *   Node 没有直接 API，只能调 Win32。winmgr.py 用 ctypes 干这件事。
 *
 * 注意：图标提取**不**走这里（那是纯 JS 的），这里的 Python 只用于窗口管理。
 */

const { execFile } = require("child_process");
const path = require("path");

/**
 * @param {object} deps
 * @param {string} deps.winmgrPath  winmgr.py 的绝对路径
 * @param {string} deps.cwd         执行时的工作目录
 * @param {Function} deps.log       日志回调
 */
function createWinMgr(deps) {
  const { winmgrPath: WINMGR, cwd: CWD, log = () => {} } = deps;

  // 打包后没有 node 的 __dirname 里那份解释器，得自己找
  const candidates = [];
  let pyExe = null;

  function initCandidates() {
    candidates.length = 0;
    candidates.push("python", "py");
    // 常见的每用户安装位置（Python 3.10 ~ 3.14）
    const local = process.env.LOCALAPPDATA || "";
    for (let v = 14; v >= 9; v--) {
      candidates.push(path.join(local, "Programs", "Python", `Python3${v}`, "python.exe"));
    }
    candidates.push("C:\\Python314\\python.exe", "C:\\Python313\\python.exe", "C:\\Python312\\python.exe");
  }

  async function resolvePython() {
    if (pyExe) return pyExe;
    initCandidates();
    for (const c of candidates) {
      const ok = await new Promise((resolve) => {
        try {
          execFile(c, ["-c", "print(1)"], { windowsHide: true, timeout: 6000 }, (err, out) => {
            resolve(!err && String(out).trim() === "1");
          });
        } catch {
          resolve(false);
        }
      });
      if (ok) {
        pyExe = c;
        log("[python] 使用", c);
        return c;
      }
    }
    log("[python] 没找到可用的 Python，窗口管理功能不可用");
    return null;
  }

  /**
   * 执行一条 winmgr 命令，返回解析后的 JSON。
   * 失败时返回 { ok: false, error }，永远不抛异常。
   */
  async function run(args, timeout = 9000, hide = true) {
    const py = await resolvePython();
    if (!py) return { ok: false, error: "no_python" };
    return new Promise((resolve) => {
      execFile(
        py,
        [WINMGR, ...args],
        { windowsHide: hide, timeout, cwd: CWD },
        (err, stdout) => {
          if (err) return resolve({ ok: false, error: err.message });
          const line = String(stdout).trim().split("\n").pop();
          try {
            resolve(JSON.parse(line));
          } catch {
            resolve({ ok: false, error: "parse_failed", raw: line });
          }
        }
      );
    });
  }

  /** 按插件配置拼出「找窗口」的参数 */
  function findArgs(p) {
    const a = ["find", "--hidden", "--process", p.find.process];
    if (p.find.class) a.push("--class", p.find.class);
    if (p.find.title) a.push("--title", p.find.title);
    return a;
  }

  return { run, findArgs, resolvePython };
}

module.exports = { createWinMgr };
