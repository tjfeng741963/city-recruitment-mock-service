@echo off
C:\Python312\python.exe -c "
import ctypes, ctypes.wintypes as wt
u = ctypes.windll.user32
g = ctypes.windll.gdi32
# 屏幕尺寸
w = u.GetSystemMetrics(0); h = u.GetSystemMetrics(1)
print('SM 屏幕:', w, 'x', h)
# 桌面 DC 是否可取
hdc = u.GetDC(0)
print('桌面 DC:', hdc)
ok = g.GetPixel(hdc, w//2, h//2)
print('中心像素: 0x%08X' % (ok & 0xFFFFFFFF))
u.ReleaseDC(0, hdc)
# 可见窗口数量与前台窗口
import win32gui
wins = []
def cb(hwd, _):
    if win32gui.IsWindowVisible(hwd):
        t = win32gui.GetWindowText(hwd)
        if t.strip():
            wins.append(t[:30])
    return True
win32gui.EnumWindows(cb, None)
print('可见窗口数:', len(wins))
for t in wins[:8]: print('  -', t)
fg = win32gui.GetForegroundWindow()
print('前台窗口:', win32gui.GetWindowText(fg)[:40] if fg else '(无)')
" > C:\cloud-agent\probe-screen.txt 2>&1
