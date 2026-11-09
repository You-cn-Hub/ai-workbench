/**
 * 代理设置 —— 本程序只访问本机（127.0.0.1），不需要走代理。
 *
 * 问题：Electron 会自动读环境变量里的 HTTP_PROXY / HTTPS_PROXY。
 * 如果机器上设了代理（公司网络、部分 VPN 会设），
 * 连本机 127.0.0.1 也会被塞进代理，结果就是网络服务崩溃、页面加载不出来。
 *
 * 之前靠 start.bat 里清环境变量绕开，但直接双击 exe 就绕不过去了。
 * 现在在进程内直接清掉，两种启动方式都稳。
 */

const PROXY_VARS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
];

/** 清掉进程环境里的代理变量（要在 app ready 前调用） */
function clearProxyEnv() {
  for (const k of PROXY_VARS) delete process.env[k];
}

/**
 * 让 Electron 的所有会话都不使用代理。
 * @param {object} session Electron 的 session 模块
 */
function disableProxy(session) {
  try {
    session.defaultSession.setProxy({ proxyRules: "direct://" });
  } catch {}
  try {
    // 部分版本需要额外的 resolveProxy，否则某些请求仍会走系统代理
    session.defaultSession.resolveProxy = () => Promise.resolve("DIRECT");
  } catch {}
}

module.exports = { clearProxyEnv, disableProxy, PROXY_VARS };
