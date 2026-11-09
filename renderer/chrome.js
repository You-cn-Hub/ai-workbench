const addr = document.getElementById("addr");
const back = document.getElementById("back");
const fwd = document.getElementById("fwd");
const tag = document.getElementById("tag");

let current = "";
let editing = false;

// 地址栏聚焦时不要被页面跳转刷掉用户正在输入的内容
addr.addEventListener("focus", () => {
  editing = true;
  addr.select();
});
addr.addEventListener("blur", () => {
  editing = false;
  addr.value = current;
});

addr.addEventListener("keydown", async (e) => {
  if (e.key === "Escape") {
    addr.value = current;
    addr.blur();
    return;
  }
  if (e.key !== "Enter") return;
  const v = addr.value.trim();
  if (!v) return;
  editing = false;
  addr.blur();
  await window.br.go(v);
});

document.getElementById("back").addEventListener("click", () => window.br.back());
document.getElementById("fwd").addEventListener("click", () => window.br.forward());
document.getElementById("reload").addEventListener("click", () => window.br.reload());
document.getElementById("home").addEventListener("click", () => window.br.home());
document.getElementById("ext").addEventListener("click", () => window.br.external());
document.getElementById("hide").addEventListener("click", () => window.br.hide());

// 快捷键：Alt+← 后退，Alt+→ 前进，F5 / Ctrl+R 刷新
window.addEventListener("keydown", (e) => {
  if (e.altKey && e.key === "ArrowLeft") {
    e.preventDefault();
    window.br.back();
  } else if (e.altKey && e.key === "ArrowRight") {
    e.preventDefault();
    window.br.forward();
  } else if (e.key === "F5" || (e.ctrlKey && e.key.toLowerCase() === "r")) {
    e.preventDefault();
    window.br.reload();
  }
});

window.br.onState((s) => {
  if (!s) return;
  back.disabled = !s.canBack;
  fwd.disabled = !s.canForward;

  current = s.url || "";
  if (!editing) addr.value = current;

  // 只在确实是本地服务时提示，避免长标题挤掉地址栏
  const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)/i.test(current);
  tag.textContent = isLocal ? "本地" : "";
  tag.style.color = isLocal ? "#3fbf8f" : "";
  addr.title = s.title || current;
});
