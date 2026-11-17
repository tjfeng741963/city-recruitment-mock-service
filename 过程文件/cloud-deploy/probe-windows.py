"""探测企微登录/验证窗口的控件结构：窗口类、标题、子控件（Edit/按钮文本）。"""
import ctypes
import win32gui
import win32process

u = ctypes.windll.user32


def wxwork_pids():
    import subprocess
    out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq WXWork.exe", "/FO", "CSV"],
                         capture_output=True, text=True).stdout
    pids = []
    for line in out.splitlines():
        if "WXWork" in line:
            parts = line.split('","')
            if len(parts) > 1:
                try:
                    pids.append(int(parts[1].strip('"')))
                except ValueError:
                    pass
    return pids


def window_info(hwnd):
    pid = win32process.GetWindowThreadProcessId(hwnd)[1]
    return {
        "class": win32gui.GetClassName(hwnd),
        "title": win32gui.GetWindowText(hwnd),
        "pid": pid,
        "rect": win32gui.GetWindowRect(hwnd),
        "visible": win32gui.IsWindowVisible(hwnd),
    }


def child_texts(hwnd, depth=0, out=None):
    """递归收集子控件：类名 + 文本（文本里常有「验证码」「获取验证码」等线索）。"""
    if out is None:
        out = []
    if depth > 6:
        return out

    def cb(child, _):
        cls = win32gui.GetClassName(child)
        txt = win32gui.GetWindowText(child)
        rect = win32gui.GetWindowRect(child)
        if txt.strip() or cls.lower() in ("edit", "atl:edit", "richedit", "richedit20w"):
            out.append({"cls": cls, "txt": txt.strip()[:60], "rect": rect})
        win32gui.EnumChildWindows(child, cb, None) if False else None
        # 手动递归
        for grand in _children(child):
            child_texts(grand, depth + 1, out)
        return True

    for c in _children(hwnd):
        cls = win32gui.GetClassName(c)
        txt = win32gui.GetWindowText(c)
        rect = win32gui.GetWindowRect(c)
        if txt.strip() or cls.lower() in ("edit", "atl:edit", "richedit", "richedit20w"):
            out.append({"cls": cls, "txt": txt.strip()[:60], "rect": rect})
        child_texts(c, depth + 1, out)
    return out


def _children(hwnd):
    kids = []

    def cb(c, _):
        kids.append(c)
        return True

    try:
        win32gui.EnumChildWindows(hwnd, cb, None)
    except Exception:
        pass
    return kids


def main():
    pids = wxwork_pids()
    print("WXWork PIDs:", pids)
    windows = []

    def cb(hwnd, _):
        try:
            info = window_info(hwnd)
            if info["pid"] in pids and info["visible"]:
                windows.append((hwnd, info))
        except Exception:
            pass
        return True

    win32gui.EnumWindows(cb, None)
    for hwnd, info in windows:
        print("=" * 60)
        print("窗口:", info["class"], "|", info["title"][:40], "|", info["rect"])
        kids = child_texts(hwnd)
        print("  子控件", len(kids), "个:")
        for k in kids[:20]:
            print("   ", k["cls"], "|", repr(k["txt"]), "|", k["rect"])


if __name__ == "__main__":
    main()
