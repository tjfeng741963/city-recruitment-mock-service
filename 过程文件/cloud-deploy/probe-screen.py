import ctypes
import win32gui

u = ctypes.windll.user32
g = ctypes.windll.gdi32

w = u.GetSystemMetrics(0)
h = u.GetSystemMetrics(1)
print("SM 屏幕:", w, "x", h)

hdc = u.GetDC(0)
print("桌面 DC:", hdc)
px = g.GetPixel(hdc, w // 2, h // 2)
print("中心像素: 0x%08X" % (px & 0xFFFFFFFF))
u.ReleaseDC(0, hdc)

wins = []


def cb(hwd, _):
    if win32gui.IsWindowVisible(hwd):
        t = win32gui.GetWindowText(hwd)
        if t.strip():
            wins.append(t[:40])
    return True


win32gui.EnumWindows(cb, None)
print("可见窗口数:", len(wins))
for t in wins[:10]:
    print("  -", t)
fg = win32gui.GetForegroundWindow()
print("前台窗口:", win32gui.GetWindowText(fg)[:40] if fg else "(无)")
