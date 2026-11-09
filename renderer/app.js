window.addEventListener("error", (e) => {
  console.log(`[app] ERROR: ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
});
const listEl = document.getElementById("list");
const tipEl = document.getElementById("tip");

let plugins = [];
let activeId = null;
let tipTimer = null;

function tip(msg, isErr) {
  tipEl.textContent = msg || "";
  tipEl.style.color = isErr ? "#E24B4A" : "";
  clearTimeout(tipTimer);
  if (msg) tipTimer = setTimeout(() => (tipEl.textContent = ""), 2600);
}

function render(list) {
  plugins = list;
  listEl.innerHTML = "";

  if (!list.length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.innerHTML = "<b>还没有程序</b><span>点下面「添加文件」选一个文件，<br>会自动认出该用哪个程序打开</span>";
    listEl.appendChild(e);
    return;
  }

  list.forEach((p) => {
    const row = document.createElement("div");
    row.className = "item" + (p.exeOk ? "" : " missing") + (p.id === activeId ? " active" : "");
    row.dataset.id = p.id;
    row.title = `${p.name}${p.hotkey ? "  " + p.hotkey : ""}\n点这一行：显示 / 收起\n点胶囊：启动 / 结束\n右键：图标 / 删除`;

    const iconHtml = p.icon
      ? `<img class="ico" src="${p.icon}" alt="">`
      : `<span class="ico ph" style="background:${p.color}">${p.short}</span>`;

    const statusText = !p.exeOk
      ? "找不到程序"
      : p.running
        ? "运行中"
        : "未启动";

    row.innerHTML = `
      ${iconHtml}
      <span class="meta">
        <span class="nm">${p.name}</span>
        <span class="st">${statusText}</span>
      </span>
      <span class="switch${p.running ? " on" : ""}" role="switch" aria-checked="${p.running}"></span>
    `;

    // 点整行：显示 / 收起界面
    row.addEventListener("click", async (e) => {
      if (e.target.closest(".switch")) return;
      if (justDragged()) return;        // 刚拖完，这一下不算点击
      const r = await window.wb.activate(p.id);
      if (r.silent) {
        // 没在运行：点这一行不作声，启动请用胶囊开关
        return;
      }
      if (!r.ok) {
        tip(r.error || "操作失败", true);
      } else if (r.mode === "minimize") {
        activeId = null;
        tip(`已最小化 ${p.name}`);
      } else if (r.mode === "hide") {
        activeId = null;
        tip(`已收起 ${p.name}`);
      } else {
        activeId = p.id;
        tip(`已置顶 ${p.name}`);
      }
      setTimeout(refresh, 1200);
    });

    // 右键：弹出菜单
    // 用 contextmenu 和 mousedown(button=2) 两条路都接上——
    // 无边框 + 永不激活的窗口在部分环境下 contextmenu 不一定派发，mousedown 一定到。
    const onRight = (e) => {
      e.preventDefault();
      openRowMenu(p, e.clientX, e.clientY);
    };
    row.addEventListener("contextmenu", onRight);
    row.addEventListener("mousedown", (e) => {
      if (e.button === 2) onRight(e);
    });
    row.addEventListener("mouseup", (e) => {
      if (e.button === 2) e.preventDefault();
    });

    // 点胶囊：启动 / 结束
    const sw = row.querySelector(".switch");
    sw.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (sw.classList.contains("busy")) return;
      sw.classList.add("busy");
      tip(p.running ? `正在结束 ${p.name}…` : `正在启动 ${p.name}…`);
      const r = p.running ? await window.wb.quit(p.id) : await window.wb.launch(p.id);
      tip(r.msg || r.error || "", !r.ok);
      setTimeout(refresh, 1800);
    });

    // 按住上下拖 = 换位置。横向基本不动，所以只看 Y。
    row.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest(".switch")) return;
      beginDrag(e, row);
    });

    listEl.appendChild(row);
  });
}

// ---------- 拖动换位 ----------
let lastDragEnd = 0;
const justDragged = () => Date.now() - lastDragEnd < 320;

function beginDrag(e, row) {
  const startY = e.clientY;
  const rect = row.getBoundingClientRect();
  let started = false;
  let mark = null;

  // 抓住指针：这样鼠标滑出窗口边缘也不会断，松手照样能收到
  try {
    row.setPointerCapture(e.pointerId);
  } catch {}

  const onMove = (ev) => {
    if (!started) {
      // 动了几像素才算拖，否则单击会被吃掉
      if (Math.abs(ev.clientY - startY) < 5) return;
      started = true;

      mark = document.createElement("div");
      mark.className = "dropmark";
      mark.style.height = rect.height + "px";
      listEl.insertBefore(mark, row);

      row.classList.add("dragging");
      Object.assign(row.style, {
        position: "fixed",
        left: rect.left + "px",
        top: rect.top + "px",
        width: rect.width + "px",
        height: rect.height + "px",
        zIndex: "50",
      });
    }

    row.style.top = rect.top + (ev.clientY - startY) + "px";

    // 指针落在谁的上班部分，就插到谁前面
    const others = [...listEl.querySelectorAll(".item:not(.dragging)")];
    let target = null;
    for (const r of others) {
      const b = r.getBoundingClientRect();
      if (ev.clientY < b.top + b.height / 2) {
        target = r;
        break;
      }
    }
    if (target) listEl.insertBefore(mark, target);
    else listEl.appendChild(mark);
  };

  const onUp = async () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    if (!started) return;
    lastDragEnd = Date.now();

    row.classList.remove("dragging");
    row.removeAttribute("style");
    listEl.insertBefore(row, mark);
    mark.remove();

    const ids = [...listEl.querySelectorAll(".item")].map((r) => r.dataset.id);
    const r = await window.wb.reorder(ids);
    if (!r.ok) {
      tip(r.error || "顺序没保存", true);
      setTimeout(refresh, 200);
    }
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}

async function refresh() {
  try {
    const list = await window.wb.list();
    render(list);
    return list;
  } catch (e) {
    tip("加载失败：" + ((e && e.message) || e), true);
  }
}

window.wb.onHotkey((id) => {
  // 主进程已经执行过 activate 了，这里只刷新高亮，不要再调一次，
  // 否则会连着切换两次（开了又收）。
  activeId = id;
  setTimeout(refresh, 600);
});

window.wb.onState((d) => {
  if (d && d.msg) tip(d.msg);
});

// 后台补齐图标后刷新一次，避免要等到 12 秒轮询才出现
window.wb.onIconsHealed(() => refresh());

refresh();
setInterval(refresh, 12000);

// ---------- 拖动 ----------
// 用指针捕获自己算位移，不依赖 -webkit-app-region：
// 窗口带 WS_EX_NOACTIVATE，系统拖动不可靠
const railEl = document.querySelector(".rail");
let drag = null;

railEl.addEventListener("pointerdown", async (e) => {
  // 告诉主进程"我刚被点了"，避免自动隐藏把这次交互误判成点了别的窗口
  window.wb.touch();
  if (e.button !== 0) return;
  // 按钮上不做拖动：setPointerCapture 会把随后的 click 也劫持到 rail，按钮就点不动了
  if (e.target.closest(".item, .hbtn, .add, .rmenu, .settings")) return;
  const [wx, wy] = await window.wb.getPos();
  drag = { id: e.pointerId, mx: e.screenX, my: e.screenY, wx, wy };
  try { railEl.setPointerCapture(e.pointerId); } catch {}
  document.body.classList.add("dragging");
});

railEl.addEventListener("pointermove", (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  window.wb.setPos(drag.wx + (e.screenX - drag.mx), drag.wy + (e.screenY - drag.my));
});

const endDrag = (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  try { railEl.releasePointerCapture(e.pointerId); } catch {}
  drag = null;
  document.body.classList.remove("dragging");
};
railEl.addEventListener("pointerup", endDrag);
railEl.addEventListener("pointercancel", endDrag);

// 点空白处关闭文件浮层
// ---------- 右键菜单 ----------

let rowMenu = null;
let lastRcAt = 0;   // 上次弹菜单的时间，用来去重

function closeRowMenu() {
  if (rowMenu) {
    rowMenu.remove();
    rowMenu = null;
  }
}

function openRowMenu(p, clientX, clientY) {
  // 同一秒内的重复触发（原生 contextmenu + 主进程转发）只弹一次
  if (Date.now() - lastRcAt < 400) return;
  lastRcAt = Date.now();

  closeRowMenu();

  const menu = document.createElement("div");
  menu.className = "rmenu";

  const mk = (label, cls, fn) => {
    const it = document.createElement("div");
    it.className = "rmi" + (cls ? " " + cls : "");
    it.textContent = label;
    it.addEventListener("click", async (e) => {
      e.stopPropagation();
      closeRowMenu();
      await fn();
    });
    menu.appendChild(it);
    return it;
  };

  mk("重建图标", "", async () => {
    const r = await window.wb.rebuildIcon(p.id);
    tip(r.ok ? `已重建 ${p.name} 的图标` : r.error || "重建失败", !r.ok);
    setTimeout(refresh, 600);
  });

  menu.appendChild(Object.assign(document.createElement("div"), { className: "rsep" }));
  mk("删除", "danger", async () => {
    const r = await window.wb.removeProgram(p.id);
    tip(r.ok ? `已删除 ${r.name}` : r.error || "删除失败", !r.ok);
    setTimeout(refresh, 600);
  });

  document.querySelector(".rail").appendChild(menu);

  // 定位到光标处，并保证不超出窗口
  const railR = document.querySelector(".rail").getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let left = clientX - railR.left;
  let top = clientY - railR.top;
  if (left + mw > railR.width - 6) left = railR.width - mw - 6;
  if (left < 6) left = 6;
  if (top + mh > railR.height - 6) top = railR.height - mh - 6;
  if (top < 30) top = 30;
  menu.style.left = left + "px";
  menu.style.top = top + "px";

  rowMenu = menu;
}

document.addEventListener("click", (e) => {
  if (!e.target.closest(".rmenu")) closeRowMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeRowMenu();
  }
});

// ---------- 置顶 ----------
const pinBtn = document.getElementById("pin");
function paintPin(on) {
  pinBtn.classList.toggle("on", on);
  pinBtn.title = on ? "已置顶 · 点击取消置顶" : "未置顶 · 点击置顶";
}
pinBtn.addEventListener("click", async (e) => {
  e.stopPropagation();
  const on = await window.wb.pin();
  paintPin(on);
  tip(on ? "已置顶" : "已取消置顶");
});
window.wb.isPinned().then(paintPin);

// ---------- 关闭 ----------
// 点 × 只收进托盘，不退出进程。真要退出在托盘右键里。
document.getElementById("close").addEventListener("click", async (e) => {
  e.stopPropagation();
  await window.wb.toTray();
});

// ---------- 设置 ----------

const gearBtn = document.getElementById("gear");
const settingsEl = document.getElementById("settings");
const hkBtn = document.getElementById("hkBtn");
const hkHint = document.getElementById("hkHint");

let settingsOpen = false;
let recording = false;

function prettyAccel(acc) {
  if (!acc) return "未设置";
  return acc
    .replace(/\bCtrl\b/g, "Ctrl")
    .replace(/\bAlt\b/g, "Alt")
    .replace(/\bShift\b/g, "Shift")
    .replace(/\bSuper\b/g, "Win")
    .replace(/\+/g, " + ");
}

async function paintHotkey() {
  const s = await window.wb.getSettings();
  const acc = s.toggleHotkey || "";
  hkBtn.textContent = prettyAccel(acc);
  hkBtn.classList.toggle("unset", !acc);
}

function setHint(msg, isErr) {
  hkHint.innerHTML =
    msg ||
    "点上面按钮，然后按下组合键。<br>必须含 Ctrl / Alt / Shift；按同一个键可以再收起。";
  hkHint.classList.toggle("err", !!isErr);
}

function toggleSettings(force) {
  const next = typeof force === "boolean" ? force : !settingsOpen;
  settingsOpen = next;
  settingsEl.hidden = !next;
  gearBtn.classList.toggle("active", next);
  if (next) {
    paintHotkey();
    setHint("");
  } else if (recording) {
    stopRecording();
  }
}

gearBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleSettings();
});

// 录制中点到别处就取消，免得一直在等键盘
document.addEventListener("click", (e) => {
  if (recording && !e.target.closest(".settings")) {
    stopRecording();
    setHint("");
  }
});

document.getElementById("settingsClose").addEventListener("click", (e) => {
  e.stopPropagation();
  toggleSettings(false);
});

// 把键盘事件翻译成 Electron 的 accelerator
function accelFromEvent(e) {
  const mods = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Super");

  const k = e.key;
  // 只按下修饰键，等真正的键
  if (["Control", "Alt", "Shift", "Meta"].includes(k)) return null;

  let key = null;
  if (/^[a-zA-Z]$/.test(k)) key = k.toUpperCase();
  else if (/^[0-9]$/.test(k)) key = k;
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(k)) key = k;
  else {
    const map = {
      " ": "Space",
      ArrowUp: "Up",
      ArrowDown: "Down",
      ArrowLeft: "Left",
      ArrowRight: "Right",
      Enter: "Return",
      Escape: "Escape",
      Tab: "Tab",
      Backspace: "Backspace",
      Delete: "Delete",
      Home: "Home",
      End: "End",
      PageUp: "PageUp",
      PageDown: "PageDown",
      Insert: "Insert",
      "`": "`",
      "-": "-",
      "=": "=",
      "[": "[",
      "]": "]",
      "\\": "\\",
      ";": ";",
      "'": "'",
      ",": ",",
      ".": ".",
      "/": "/",
    };
    key = map[k] || null;
  }
  if (!key) return null;
  if (!mods.length) return null;   // 不带修饰键会抢走正常输入
  return [...mods, key].join("+");
}

async function startRecording() {
  recording = true;
  hkBtn.classList.add("recording");
  hkBtn.classList.remove("unset");
  hkBtn.textContent = "按下组合键…";
  setHint("");
  await window.wb.beginCapture();   // 临时解除"永不激活"，否则收不到键盘
}

async function stopRecording() {
  recording = false;
  hkBtn.classList.remove("recording");
  await window.wb.endCapture();
  paintHotkey();
}

hkBtn.addEventListener("click", async (e) => {
  e.stopPropagation();
  if (recording) {
    await stopRecording();
    return;
  }
  await startRecording();
});

window.addEventListener("keydown", async (e) => {
  if (!recording) return;
  e.preventDefault();
  e.stopPropagation();

  if (e.key === "Escape") {
    await stopRecording();
    setHint("");
    return;
  }
  if (e.key === "Backspace") {
    hkBtn.classList.remove("recording");
    recording = false;
    const r = await window.wb.setHotkey("");
    await window.wb.endCapture();
    paintHotkey();
    setHint(r.ok ? "已清除。" : r.error || "清除失败", !r.ok);
    return;
  }

  const acc = accelFromEvent(e);
  if (!acc) {
    setHint("这个键不行——必须带 Ctrl / Alt / Shift 之一，而且要有个主键。", true);
    return;
  }

  hkBtn.textContent = prettyAccel(acc);
  const r = await window.wb.setHotkey(acc);
  recording = false;
  hkBtn.classList.remove("recording");
  await window.wb.endCapture();

  if (r.ok) {
    setHint(`已设为 ${prettyAccel(acc)}。按它可以把悬浮台唤出 / 收起。`);
  } else {
    setHint(r.error || "设置失败", true);
  }
  paintHotkey();
});

// ---------- 添加文件 ----------
// 把文件直接拖进悬浮台
window.addEventListener("dragover", (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
});
window.addEventListener("drop", async (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (!f) return;
  const p = window.wb.getPathForFile(f);
  if (!p) {
    tip("读不到这个文件的路径", true);
    return;
  }
  tip(`正在添加 ${f.name}…`);
  const r = await window.wb.addFile(p);
  tip(r.ok ? `已添加 ${f.name} → ${r.name}` : r.error || "添加失败", !r.ok);
  setTimeout(refresh, 500);
});

const addBtn = document.getElementById("add");

addBtn.addEventListener("click", async (e) => {
  e.stopPropagation();
  addBtn.disabled = true;
  tip("选一个文件…");
  try {
    const r = await window.wb.pickFile();
    if (!r.ok) {
      tip(r.canceled ? "" : r.error || "没选中文件", !r.canceled);
      return;
    }
    const a = await window.wb.addFile(r.path);
    if (!a.ok) {
      tip(a.error || "添加失败", true);
      return;
    }
    tip(`已添加 ${a.file} → ${a.name}`);
    setTimeout(refresh, 500);
  } catch (err) {
    tip("出错了：" + ((err && err.message) || err), true);
  } finally {
    addBtn.disabled = false;
  }
});
