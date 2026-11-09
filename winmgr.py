#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
窗口管理辅助工具 —— 供 Electron 主进程调用，绕开原生模块编译。

用法（输出一行 JSON）：
  python winmgr.py find   --process WorkBuddy.exe
  python winmgr.py focus  --process WorkBuddy.exe
  python winmgr.py move   --process WorkBuddy.exe --x 0 --y 0 --w 800 --h 600
  python winmgr.py state  --process WorkBuddy.exe --class Chrome_WidgetWin_1
"""

import argparse
import ctypes
import ctypes.wintypes as wt
import json
import subprocess
import time
import sys

# 统一 UTF-8 输出，避免中文错误信息在 Node 侧解码时乱码
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

u = ctypes.WinDLL("user32", use_last_error=True)
k = ctypes.WinDLL("kernel32", use_last_error=True)

EnumProc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)

SW_RESTORE = 9
SW_SHOW = 5
SW_SHOWNOACTIVATE = 4
SW_HIDE = 0
HWND_TOP = 0
HWND_BOTTOM = 1
HWND_TOPMOST = -1
HWND_NOTOPMOST = -2
SWP_NOZORDER = 0x0004
SWP_NOACTIVATE = 0x0010
SWP_NOMOVE = 0x0002
SWP_NOSIZE = 0x0001
SWP_FRAMECHANGED = 0x0020
GWL_STYLE = -16
GWL_EXSTYLE = -20
WS_CAPTION = 0x00C00000
WS_THICKFRAME = 0x00040000
WS_SYSMENU = 0x00080000
WS_MINIMIZEBOX = 0x00020000
WS_MAXIMIZEBOX = 0x00010000
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_APPWINDOW = 0x00040000
WM_CLOSE = 0x0010
WM_SYSCOMMAND = 0x0112
SC_MINIMIZE = 0xF020
SW_SHOWMINIMIZED = 2


class WINDOWPLACEMENT(ctypes.Structure):
    _fields_ = [
        ("length", wt.UINT),
        ("flags", wt.UINT),
        ("showCmd", wt.UINT),
        ("ptMinPosition", wt.POINT),
        ("ptMaxPosition", wt.POINT),
        ("rcNormalPosition", wt.RECT),
    ]
GWL_EXSTYLE = -20
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_NOACTIVATE = 0x08000000


def write_png_rgba(path, data, w, h):
    """把 BGRA 原始像素写成 PNG，只用标准库，不需要 Pillow。

    图标提取是核心功能，不能因为用户的 Python 没装 Pillow 就整个瘸掉
    （实测 %LOCALAPPDATA%\\Programs\\Python\\Python312 里就没有 PIL）。
    """
    import struct
    import zlib

    px = bytearray(data)
    # BGRA -> RGBA
    px[0::4], px[2::4] = px[2::4], px[0::4]

    # 有些程序的 32 位图标 alpha 全是 0，直接用会得到一张全透明的空图
    if not max(px[3::4] or b"\x00"):
        for i in range(3, len(px), 4):
            px[i] = 255

    stride = w * 4
    raw = bytearray()
    for y in range(h):
        raw.append(0)  # 每行开头一个 filter 字节，0 表示不过滤
        raw += px[y * stride:(y + 1) * stride]

    def chunk(tag, payload):
        return (
            struct.pack(">I", len(payload))
            + tag
            + payload
            + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)  # 8bit RGBA
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", zlib.compress(bytes(raw), 6)))
        f.write(chunk(b"IEND", b""))


def visible(hwnd):
    return bool(u.IsWindowVisible(hwnd))


def owner(hwnd):
    return u.GetWindow(hwnd, 4)  # GW_OWNER


def class_name(hwnd):
    buf = ctypes.create_unicode_buffer(256)
    u.GetClassNameW(hwnd, buf, 256)
    return buf.value


def title(hwnd):
    buf = ctypes.create_unicode_buffer(512)
    u.GetWindowTextW(hwnd, buf, 512)
    return buf.value


def pid_of(hwnd):
    p = wt.DWORD()
    u.GetWindowThreadProcessId(hwnd, ctypes.byref(p))
    return p.value


def process_path(pid):
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    h = k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return ""
    try:
        size = wt.DWORD(1024)
        buf = ctypes.create_unicode_buffer(1024)
        if k.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return buf.value
    finally:
        k.CloseHandle(h)
    return ""


def windows(include_hidden=False):
    out = []

    def cb(hwnd, _):
        if (include_hidden or visible(hwnd)) and title(hwnd) and not owner(hwnd):
            out.append(hwnd)
        return True

    u.EnumWindows(EnumProc(cb), 0)
    return out


def match(process=None, klass=None, title_re=None, include_hidden=False):
    import re
    cands = []
    for hwnd in windows(include_hidden):
        pid = pid_of(hwnd)
        path = process_path(pid)
        name = path.rsplit("\\", 1)[-1] if path else ""
        if process and name.lower() != process.lower():
            continue
        if klass and klass.lower() not in class_name(hwnd).lower():
            continue
        if title_re and not re.search(title_re, title(hwnd)):
            continue
        cands.append(hwnd)
    return cands


def pick_main(hwnds):
    """挑主窗口：先排除离屏窗和极小窗，再优先可见的，最后取面积最大的。"""
    cands = []
    for h in hwnds:
        r = rect(h)
        x_, y_, w_, h_ = r[0], r[1], r[2], r[3]
        if x_ <= -10000 or y_ <= -10000:
            continue          # 挪到屏幕外的隐藏辅助窗
        if w_ < 200 or h_ < 120:
            continue          # 托盘、提示条之类的小窗
        cands.append((h, w_ * h_, bool(visible(h))))

    if not cands:
        return hwnds[0] if hwnds else None

    # 可见窗口优先，避免抓到某些应用的透明影子层（无边框全屏辅助窗口）
    shown = [c for c in cands if c[2]]
    pool = shown if shown else cands
    pool.sort(key=lambda c: c[1], reverse=True)
    return pool[0][0]


def rect(hwnd):
    r = wt.RECT()
    u.GetWindowRect(hwnd, ctypes.byref(r))
    return [r.left, r.top, r.right - r.left, r.bottom - r.top]


def focus(hwnd):
    """把窗口拉到前台。

    SetForegroundWindow 受 Windows 前台锁定限制：只有当前前台线程（或它启动的进程）
    才能设置前台窗口。标准解法是把**当前线程**的输入队列临时挂到前台线程上。
    """
    if u.GetForegroundWindow() == hwnd:
        return True

    u.ShowWindow(hwnd, SW_RESTORE)
    fg = u.GetForegroundWindow()
    my_tid = k.GetCurrentThreadId()
    fg_tid = u.GetWindowThreadProcessId(fg, None) if fg else 0
    attached = False
    if fg_tid and fg_tid != my_tid:
        attached = bool(u.AttachThreadInput(my_tid, fg_tid, True))
    try:
        u.BringWindowToTop(hwnd)
        u.SetForegroundWindow(hwnd)
    finally:
        if attached:
            u.AttachThreadInput(my_tid, fg_tid, False)

    if u.GetForegroundWindow() == hwnd:
        return True

    # 兜底：SwitchToThisWindow 虽然未公开，但对付 Electron 窗口最管用
    try:
        u.SwitchToThisWindow(hwnd, True)
    except Exception:
        pass
    return bool(u.GetForegroundWindow() == hwnd)


def placement(hwnd):
    wp = WINDOWPLACEMENT()
    wp.length = ctypes.sizeof(WINDOWPLACEMENT)
    u.GetWindowPlacement(hwnd, ctypes.byref(wp))
    return wp


def set_minimized(hwnd):
    wp = placement(hwnd)
    wp.showCmd = SW_SHOWMINIMIZED
    u.SetWindowPlacement(hwnd, ctypes.byref(wp))


def set_restored(hwnd):
    wp = placement(hwnd)
    if wp.showCmd == SW_SHOWMINIMIZED:
        wp.showCmd = 1
        u.SetWindowPlacement(hwnd, ctypes.byref(wp))
    u.ShowWindow(hwnd, SW_RESTORE)


def toggle(hwnd):
    """二态切换：窗口开着 → 最小化；收着 → 置顶显示。

    判断依据是 showCmd 和 visible，不用 foreground：
    窗口最小化后仍然是前台窗口，拿 foreground 判断会乱。
    """
    opened = visible(hwnd) and placement(hwnd).showCmd != SW_SHOWMINIMIZED

    if opened:
        set_minimized(hwnd)
        time.sleep(0.35)
        # 有些应用（无边框全屏层）不接受最小化，会立刻弹回来，
        # 这时改用隐藏，效果等同于收进托盘
        if placement(hwnd).showCmd != SW_SHOWMINIMIZED:
            u.ShowWindow(hwnd, SW_HIDE)
            return "hide"
        return "minimize"

    set_restored(hwnd)
    focus(hwnd)
    return "front"


def pid_on_port(port):
    try:
        out = subprocess.run(["netstat", "-ano", "-p", "TCP"], capture_output=True,
                             text=True, encoding="gbk", errors="ignore", timeout=10).stdout
    except Exception:
        return None
    import re
    pat = re.compile(r":%d\s+\S+\s+LISTENING\s+(\d+)" % port)
    for line in out.splitlines():
        m = pat.search(line)
        if m:
            return m.group(1)
    return None


# ---------- 常驻模式：监听前台窗口变化，实时推送 ----------

def daemon_mode():
    """常驻进程：盯住前台窗口，一变就推一行 JSON。

    Electron 侧不再反复起 Python 进程轮询（每次 350ms），
    改由这个助手以 10ms 频率检查，隐藏延迟降到十几毫秒。
    """
    import queue
    import threading

    commands = queue.Queue()

    def stdin_reader():
        for line in sys.stdin:
            commands.put(line)

    threading.Thread(target=stdin_reader, daemon=True).start()

    out = sys.stdout
    last = 0
    while True:
        fg = u.GetForegroundWindow()
        if fg != last:
            last = fg
            try:
                cls = class_name(fg)
            except Exception:
                cls = ""
            out.write(json.dumps({
                "ok": True,
                "event": "fg",
                "hwnd": int(fg),
                "class": cls,
                "desktop": cls in ("Progman", "WorkerW"),
                "taskbar": cls == "Shell_TrayWnd",
            }, ensure_ascii=False) + "\n")
            out.flush()

        while True:
            try:
                line = commands.get_nowait()
            except Exception:
                break
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except Exception:
                continue
            if req.get("action") == "quit":
                out.write(json.dumps({"ok": True}) + "\n")
                out.flush()
                return 0
            if req.get("action") == "fg":
                try:
                    cls = class_name(fg)
                except Exception:
                    cls = ""
                out.write(json.dumps({
                    "ok": True, "hwnd": int(fg), "class": cls,
                    "desktop": cls in ("Progman", "WorkerW"),
                    "taskbar": cls == "Shell_TrayWnd",
                }, ensure_ascii=False) + "\n")
                out.flush()

        time.sleep(0.01)


def main():
    if "--daemon" in sys.argv:
        return daemon_mode()

    ap = argparse.ArgumentParser()
    ap.add_argument("action",
                    choices=["find", "focus", "move", "state", "hide", "show", "chrome", "close", "procs", "kill", "killport", "minimize", "noactivate", "activate", "bottom", "toggle", "fg", "icon", "pickfile", "dlglist", "assoc", "verinfo", "lnk", "exeicon"])
    ap.add_argument("--process", default=None)
    ap.add_argument("--class", dest="klass", default=None)
    ap.add_argument("--title", dest="title_re", default=None)
    ap.add_argument("--x", type=int, default=0)
    ap.add_argument("--y", type=int, default=0)
    ap.add_argument("--w", type=int, default=0)
    ap.add_argument("--h", type=int, default=0)
    ap.add_argument("--topmost", action="store_true")
    ap.add_argument("--notopmost", action="store_true")
    ap.add_argument("--chrome", choices=["on", "off"], default="off")
    ap.add_argument("--hidden", action="store_true", help="同时匹配已隐藏的窗口")
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--src")
    ap.add_argument("--ext")
    ap.add_argument("--isize", type=int, default=0)
    ap.add_argument("--out")
    ap.add_argument("--noactivate", action="store_true", help="窗口永不抢焦点，点击直接穿透到内容")
    a = ap.parse_args()

    include_hidden = a.hidden or a.action in (
        "show", "close", "chrome", "state", "procs", "killport", "minimize", "toggle"
    )

    if a.action == "kill":
        if not a.process:
            print(json.dumps({"ok": False, "error": "missing_process"}))
            return 0
        r = subprocess.run(["taskkill", "/IM", a.process, "/F"],
                           capture_output=True, timeout=25)
        out = (r.stdout or b"").decode("gbk", errors="ignore") + (r.stderr or b"").decode("gbk", errors="ignore")
        print(json.dumps({"ok": True, "killed": r.returncode == 0,
                          "process": a.process, "detail": out.strip()[:160]}, ensure_ascii=False))
        return 0

    if a.action == "lnk":
        # 解析快捷方式（.lnk）：取出它真正指向的程序、参数、图标
        p = (a.src or "").replace("'", "''")
        ps = (
            "$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8; "
            "$s = New-Object -ComObject WScript.Shell; "
            "$l = $s.CreateShortcut('" + p + "'); "
            "[PSCustomObject]@{"
            "TargetPath=$l.TargetPath; Arguments=$l.Arguments; "
            "WorkingDirectory=$l.WorkingDirectory; IconLocation=$l.IconLocation; "
            "Description=$l.Description; Hotkey=$l.Hotkey"
            "} | ConvertTo-Json -Compress"
        )
        try:
            r = subprocess.run(
                ["powershell", "-NoProfile", "-Command", ps],
                capture_output=True, timeout=25,
            )
            raw = r.stdout or b""
            out = ""
            for enc in ("utf-8-sig", "utf-8", "gbk"):
                try:
                    out = raw.decode(enc).strip()
                    if out:
                        break
                except UnicodeDecodeError:
                    continue
            import json as _json
            d = _json.loads(out) if out else {}
            if isinstance(d, list):
                d = d[0] if d else {}
            target = (d.get("TargetPath") or "").strip()
            icon = (d.get("IconLocation") or "").strip()
            # IconLocation 形如 "C:\path\app.exe,0"，前半段是图标来源
            icon_src = icon.split(",")[0].strip().strip('"') if icon else ""
            print(json.dumps({
                "ok": bool(target),
                "target": target or None,
                "args": (d.get("Arguments") or "").strip(),
                "workdir": (d.get("WorkingDirectory") or "").strip(),
                "icon": icon_src or None,
                "description": (d.get("Description") or "").strip(),
                "hotkey": (d.get("Hotkey") or "").strip(),
                "error": None if target else "这个快捷方式没有指向任何程序",
            }, ensure_ascii=False))
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        return 0

    if a.action == "verinfo":
        # 读 exe 的版本信息，拿 FileDescription 当显示名。
        # wps.exe 这种光看文件名是认不出来的，得问它自己。
        p = (a.src or "").replace("'", "''")
        # 强制 UTF-8 输出，否则中文显示名在 Node 侧会变成乱码
        ps = (
            "$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8; "
            "(Get-Item -LiteralPath '" + p + "').VersionInfo | "
            "Select-Object FileDescription,ProductName | ConvertTo-Json -Compress"
        )
        try:
            r = subprocess.run(
                ["powershell", "-NoProfile", "-Command", ps],
                capture_output=True, timeout=20,
            )
            raw = r.stdout or b""
            for enc in ("utf-8-sig", "utf-8", "gbk"):
                try:
                    out = raw.decode(enc).strip()
                    if out:
                        break
                except UnicodeDecodeError:
                    continue
            else:
                out = raw.decode("utf-8", errors="ignore").strip()
            import json as _json
            d = _json.loads(out) if out else {}
            if isinstance(d, list):
                d = d[0] if d else {}
            desc = (d.get("FileDescription") or "").strip()
            prod = (d.get("ProductName") or "").strip()
            print(json.dumps({
                "ok": True,
                "description": desc,
                "product": prod,
                "name": desc or prod,
            }, ensure_ascii=False))
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        return 0

    if a.action == "assoc":
        # 查文件扩展名的默认打开程序，以及所有可选程序
        try:
            import winreg
        except ImportError:
            print(json.dumps({"ok": False, "error": "no_winreg"}))
            return 0

        ext = (a.ext or "").lower()
        if ext and not ext.startswith("."):
            ext = "." + ext
        if not ext:
            print(json.dumps({"ok": False, "error": "no_ext"}))
            return 0

        def qv(root, sub):
            try:
                with winreg.OpenKey(root, sub) as k:
                    try:
                        return winreg.QueryValueEx(k, "")[0]
                    except OSError:
                        return winreg.QueryValue(k, None)
            except OSError:
                return None

        def friendly(prog):
            # ProgID 的友好名，可能是 "@dll,-123" 这种引用形式，取不到就算了
            v = qv(winreg.HKEY_CLASSES_ROOT, prog + "\\FriendlyTypeName")
            if isinstance(v, str) and not v.startswith("@"):
                return v
            return None

        def command_of(prog):
            c = qv(winreg.HKEY_CLASSES_ROOT, prog + r"\shell\open\command")
            if not isinstance(c, str):
                return None, None
            c = c.strip()
            if c.startswith('"'):
                j = c.find('"', 1)
                exe = c[1:j] if j > 0 else ""
            else:
                # 命令行形如  "D:\Apps\Foo\Foo.exe" "%1"  —— 先切掉参数再剥引号
                exe = c.split('"%1"')[0].split("%1")[0].strip()
            exe = exe.strip().strip('"').strip()
            # "%1" 这种是「要打开的文件」占位符，不是程序路径。
            # .exe 的默认关联命令就是 `"%1" %*`，不排除的话会把 %1 当成程序名。
            if not exe or "%" in exe:
                exe = None
            return (exe or None), c

        # 1) 用户在"打开方式"里选过的优先
        default_prog = qv(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\%s\UserChoice" % ext,
        )

        # 2) 系统默认
        if not default_prog:
            default_prog = qv(winreg.HKEY_CLASSES_ROOT, ext)

        # 3) 所有候选
        cands = []
        seen = set()
        with_ow = None
        try:
            with winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\%s\OpenWithProgids" % ext,
            ) as k:
                i = 0
                while True:
                    try:
                        name = winreg.EnumValue(k, i)[0]
                    except OSError:
                        break
                    i += 1
                    with_ow = name
        except OSError:
            pass

        order = [default_prog]
        if with_ow:
            order.append(with_ow)

        for prog in order:
            if not prog or prog in seen:
                continue
            seen.add(prog)
            exe, cmd = command_of(prog)
            cands.append({
                "prog": prog,
                "exe": exe,
                "cmd": cmd,
                "name": friendly(prog),
            })

        print(json.dumps({
            "ok": True,
            "ext": ext,
            "default": default_prog,
            "candidates": cands,
        }, ensure_ascii=False))
        return 0

    if a.action == "dlglist":
        # 列出当前存在的对话框窗口（文件选择框、确认框等）
        found = []

        def cb(h, _):
            cls = class_name(h)
            if cls in ("#32770", "CabinetWClass", "TaskDialogXamlHost"):
                found.append({
                    "hwnd": int(h),
                    "class": cls,
                    "title": title(h),
                    "visible": bool(u.IsWindowVisible(h)),
                })
            return True

        u.EnumWindows(EnumProc(cb), 0)
        print(json.dumps(found, ensure_ascii=False))
        return 0

    if a.action == "pickfile":
        # Windows 原生文件选择框。Electron 的 showOpenDialog 在透明无边框窗口下
        # 会挂着不返回，所以这里用 Forms.OpenFileDialog 顶上。
        ps = (
            "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n"
            "Add-Type -AssemblyName System.Windows.Forms\n"
            "$dlg = New-Object System.Windows.Forms.OpenFileDialog\n"
            f"$dlg.Title = '{a.title_re or '选择文件'}'\n"
            "$dlg.Filter = '可执行文件|*.exe;*.bat;*.cmd|所有文件|*.*'\n"
            "$dlg.Multiselect = $false\n"
            "if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) "
            "{ Write-Output $dlg.FileName }"
        )
        try:
            r = subprocess.run(
                ["powershell.exe", "-NoProfile", "-STA", "-Command", ps],
                capture_output=True, timeout=300,
            )
            out = (r.stdout or b"").decode("utf-8", errors="ignore").strip()
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
            return 0
        print(json.dumps({"ok": bool(out), "path": out}, ensure_ascii=False))
        return 0

    if a.action == "exeicon":
        # 从 exe / dll 里按指定尺寸抽图标（默认 256）。
        # app.getFileIcon 只给 48×48，放大就糊；PrivateExtractIconsW 能直接要 256。
        # 注意：Pillow 是**可选**的。用户的 Python 未必装了它，
        # 所以下面拿不到 PIL 时用标准库自己写 PNG（zlib + struct），别让整条链挂掉。
        try:
            try:
                from PIL import Image as _PILImage
            except Exception:
                _PILImage = None

            size = a.isize or 256
            exe_path = a.src or ""
            if not exe_path:
                print(json.dumps({"ok": False, "error": "no_src"}))
                return 0

            # 注意 PrivateExtractIconsW 在 user32 里（容易误以为在 kernel32）
            u.PrivateExtractIconsW.restype = wt.UINT
            u.PrivateExtractIconsW.argtypes = [
                wt.LPCWSTR, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                ctypes.POINTER(wt.HICON), ctypes.POINTER(wt.UINT),
                wt.UINT, wt.UINT,
            ]

            hicon = wt.HICON()
            iconid = wt.UINT()
            n = u.PrivateExtractIconsW(
                exe_path, 0, size, size, ctypes.byref(hicon), ctypes.byref(iconid), 1, 0
            )
            if not n or not hicon.value:
                print(json.dumps({"ok": False, "error": "no_icon"}))
                return 0

            # HICON → DIB → PIL
            class ICONINFO(ctypes.Structure):
                _fields_ = [
                    ("fIcon", wt.BOOL),
                    ("xHotspot", wt.DWORD),
                    ("yHotspot", wt.DWORD),
                    ("hbmMask", wt.HBITMAP),
                    ("hbmColor", wt.HBITMAP),
                ]

            gdi = ctypes.WinDLL("gdi32")
            # 必须声明参数类型：64 位下 HBITMAP/HDC 是 8 字节句柄，
            # 不声明会被当 32 位整型，遇到大句柄直接 OverflowError。
            u.GetIconInfo.argtypes = [wt.HICON, ctypes.POINTER(ICONINFO)]
            u.GetIconInfo.restype = wt.BOOL
            u.GetDC.argtypes = [wt.HWND]
            u.GetDC.restype = wt.HDC
            u.ReleaseDC.argtypes = [wt.HWND, wt.HDC]

            ii = ICONINFO()
            if not u.GetIconInfo(hicon, ctypes.byref(ii)):
                print(json.dumps({"ok": False, "error": "get_icon_info"}))
                return 0

            class BITMAPINFOHEADER(ctypes.Structure):
                _fields_ = [
                    ("biSize", wt.DWORD), ("biWidth", wt.LONG), ("biHeight", wt.LONG),
                    ("biPlanes", wt.WORD), ("biBitCount", wt.WORD),
                    ("biCompression", wt.DWORD), ("biSizeImage", wt.DWORD),
                    ("biXPelsPerMeter", wt.LONG), ("biYPelsPerMeter", wt.LONG),
                    ("biClrUsed", wt.DWORD), ("biClrImportant", wt.DWORD),
                ]

            class BITMAPINFO(ctypes.Structure):
                _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", wt.DWORD * 3)]

            hdc = u.GetDC(None)
            bi = BITMAPINFO()
            bi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
            bi.bmiHeader.biWidth = size
            bi.bmiHeader.biHeight = -size      # 负值 = 自上而下
            bi.bmiHeader.biPlanes = 1
            bi.bmiHeader.biBitCount = 32
            bi.bmiHeader.biCompression = 0     # BI_RGB

            gdi.GetDIBits.argtypes = [
                wt.HDC, wt.HBITMAP, wt.UINT, wt.UINT,
                ctypes.c_void_p, ctypes.POINTER(BITMAPINFO), wt.UINT,
            ]
            gdi.GetDIBits.restype = ctypes.c_int

            buf = ctypes.create_string_buffer(size * size * 4)
            gdi.GetDIBits(hdc, ii.hbmColor, 0, size, buf, ctypes.byref(bi), 0)
            u.ReleaseDC(None, hdc)

            if _PILImage is not None:
                im = _PILImage.frombuffer("RGBA", (size, size), buf, "raw", "BGRA", 0, 1)
                # 有些 exe 的 32 位图标 alpha 全 0，这时用 mask 位图补
                alpha = im.split()[-1]
                if alpha.getextrema()[1] == 0:
                    im = im.convert("RGB").convert("RGBA")
                im.save(a.out)
                out_size = list(im.size)
            else:
                # 没有 Pillow：自己写 PNG，效果一样，只是少了色彩管理
                write_png_rgba(a.out, buf.raw, size, size)
                out_size = [size, size]

            print(json.dumps({"ok": True, "size": out_size, "srcSize": [size, size]}))
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        return 0

    if a.action == "icon":
        # 把 ico / 任意图片统一转成 png，供界面当图标用。
        # 关键是取最大的那一份：exe 内嵌图标常常只有 32x32，放到 30px 的显示位上会糊。
        try:
            from PIL import Image
            im = Image.open(a.src)
            im = im.convert("RGBA")

            # 多尺寸 ico 要挑最大的那个
            sizes = getattr(im, "ico", None)
            if sizes is not None:
                try:
                    candidates = sorted(
                        (s for s in im.ico.sizes() if s[0] >= 64),
                        key=lambda s: s[0] * s[1],
                        reverse=True,
                    )
                    if candidates:
                        im.ico.getimage(candidates[0])
                        im = im.ico.getimage(candidates[0]).convert("RGBA")
                except Exception:
                    pass

            w, h = im.size
            if max(w, h) < 128:
                # 太小了，放大到 256（用 LANCZOS 保住边缘）
                im = im.resize((256, 256), Image.LANCZOS)
            elif max(w, h) > 256:
                im.thumbnail((256, 256), Image.LANCZOS)

            im.save(a.out)
            print(json.dumps({"ok": True, "size": list(im.size), "srcSize": [w, h]}))
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        return 0

    if a.action == "fg":
        # 当前前台窗口是谁。用来判断"点到别的窗口了"以及"点到桌面了"。
        fg = u.GetForegroundWindow()
        cls = class_name(fg)
        pth = process_path(pid_of(fg))
        pname = pth.rsplit("\\", 1)[-1] if pth else ""
        print(json.dumps({
            "ok": True,
            "hwnd": int(fg),
            "class": cls,
            "process": pname,
            "title": title(fg),
            # 桌面窗口：Progman / WorkerW；任务栏是 Shell_TrayWnd，两者不同
            "desktop": cls in ("Progman", "WorkerW"),
            "taskbar": cls == "Shell_TrayWnd",
        }, ensure_ascii=False))
        return 0

    if a.action == "killport":
        pid = pid_on_port(a.port)
        if not pid:
            print(json.dumps({"ok": False, "error": "port_not_listening"}))
            return 0
        subprocess.run(["taskkill", "/PID", pid, "/T", "/F"], capture_output=True, timeout=15)
        print(json.dumps({"ok": True, "pid": pid, "killed": True}))
        return 0

    if a.action == "procs":
        names = set()
        for h in windows(include_hidden=True):
            pth = process_path(pid_of(h))
            if pth:
                names.add(pth.rsplit("\\", 1)[-1].lower())
        print(json.dumps({"ok": True, "procs": sorted(names)}, ensure_ascii=False))
        return 0

    try:
        hwnds = match(a.process, a.klass, a.title_re, include_hidden)
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        return 1

    if not hwnds:
        print(json.dumps({"ok": False, "error": "window_not_found"}))
        return 0

    hwnd = pick_main(hwnds)
    wp = WINDOWPLACEMENT()
    wp.length = ctypes.sizeof(WINDOWPLACEMENT)
    u.GetWindowPlacement(hwnd, ctypes.byref(wp))

    res = {"ok": True, "hwnd": int(hwnd), "title": title(hwnd),
           "class": class_name(hwnd), "rect": rect(hwnd),
           "visible": visible(hwnd),
           "foreground": bool(u.GetForegroundWindow() == hwnd),
           "showCmd": wp.showCmd,          # 2 = 已最小化
           "count": len(hwnds)}

    if a.action == "focus":
        res["focused"] = focus(hwnd)
        res["rect"] = rect(hwnd)
    elif a.action == "move":
        u.ShowWindow(hwnd, SW_RESTORE)
        if a.notopmost:
            # 只改层级，不动位置尺寸
            u.SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0,
                           SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)
            res["z"] = "normal"
        else:
            z = HWND_TOPMOST if a.topmost else HWND_TOP
            flags = SWP_NOACTIVATE if a.topmost else (SWP_NOACTIVATE | SWP_NOZORDER)
            u.SetWindowPos(hwnd, z, a.x, a.y, a.w, a.h, flags)
            res["rect"] = rect(hwnd)
            res["topmost"] = bool(a.topmost)
    elif a.action == "toggle":
        # 三态切换的决策全部收在窗口层，界面只管调用
        act = toggle(hwnd)
        res["action"] = act
        res["focused"] = bool(u.GetForegroundWindow() == hwnd)
        res["showCmd"] = placement(hwnd).showCmd
    elif a.action == "noactivate":
        # 只加 WS_EX_NOACTIVATE。之前借 chrome 动作做这件事时，
        # chrome 默认 off 会顺手剥掉 WS_MINIMIZEBOX，导致最小化永远无效。
        ex = u.GetWindowLongW(hwnd, GWL_EXSTYLE) & 0xFFFFFFFF
        ex |= WS_EX_NOACTIVATE
        u.SetWindowLongW(hwnd, GWL_EXSTYLE, ex)
        res["noactivate"] = True
        res["style"] = u.GetWindowLongW(hwnd, GWL_STYLE) & 0xFFFFFFFF
    elif a.action == "minimize":
        # ShowWindow(SW_MINIMIZE) 只隐藏不改 WINDOWPLACEMENT，GetWindowRect 不变；
        # WM_SYSCOMMAND/SC_MINIMIZE 也拦不住 Electron 窗口。
        # 唯一可靠的办法是直接改 WINDOWPLACEMENT.showCmd。
        wp = WINDOWPLACEMENT()
        wp.length = ctypes.sizeof(WINDOWPLACEMENT)
        u.GetWindowPlacement(hwnd, ctypes.byref(wp))
        wp.showCmd = SW_SHOWMINIMIZED
        u.SetWindowPlacement(hwnd, ctypes.byref(wp))
        res["minimized"] = True
        res["showCmd"] = SW_SHOWMINIMIZED
    elif a.action == "bottom":
        # 沉到所有窗口之下，但仍然可见。
        # 用于"点了别的窗口"——不藏起来，只是让出上层。
        u.SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, 0, 0,
                       SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)
        res["bottom"] = True
    elif a.action == "activate":
        # 剥掉 WS_EX_NOACTIVATE 并抢焦点。
        # 录制快捷键这种要键盘输入的场合才用，平时窗口是永不激活的。
        ex = u.GetWindowLongW(hwnd, GWL_EXSTYLE) & 0xFFFFFFFF
        ex &= ~WS_EX_NOACTIVATE
        u.SetWindowLongW(hwnd, GWL_EXSTYLE, ex)
        u.SetForegroundWindow(hwnd)
        res["activated"] = True
    elif a.action == "hide":
        u.ShowWindow(hwnd, SW_HIDE)
        res["hidden"] = True
    elif a.action == "show":
        wp = WINDOWPLACEMENT()
        wp.length = ctypes.sizeof(WINDOWPLACEMENT)
        u.GetWindowPlacement(hwnd, ctypes.byref(wp))
        if wp.showCmd == SW_SHOWMINIMIZED:
            wp.showCmd = 1
            u.SetWindowPlacement(hwnd, ctypes.byref(wp))
        u.ShowWindow(hwnd, SW_RESTORE)
        res["shown"] = True
    elif a.action == "close":
        u.PostMessageW(hwnd, WM_CLOSE, 0, 0)
        res["closed"] = True

    elif a.action == "chrome":
        style = u.GetWindowLongW(hwnd, GWL_STYLE) & 0xFFFFFFFF
        ex = u.GetWindowLongW(hwnd, GWL_EXSTYLE) & 0xFFFFFFFF
        if a.chrome == "off":
            style &= ~(WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX)
            ex = (ex | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW
        else:
            style |= (WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX)
            ex = (ex & ~WS_EX_TOOLWINDOW) | WS_EX_APPWINDOW
        if a.noactivate:
            ex |= WS_EX_NOACTIVATE
        u.SetWindowLongW(hwnd, GWL_STYLE, style)
        u.SetWindowLongW(hwnd, GWL_EXSTYLE, ex)
        u.SetWindowPos(hwnd, 0, 0, 0, 0, 0,
                       SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED)
        res["chrome"] = a.chrome
        res["rect"] = rect(hwnd)

    print(json.dumps(res, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
