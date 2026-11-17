@echo off
rem 在交互式控制台会话里启动企微 + 二维码推送器（渲染需要真实桌面）
cd /d C:\cloud-agent
if not exist logs mkdir logs
rem 先清掉旧实例
taskkill /F /IM WXWork.exe >nul 2>&1
taskkill /F /IM python.exe >nul 2>&1
rem 拉起企微（标准两个安装路径都试）
if exist "C:\Program Files (x86)\WXWork\WXWork.exe" (
  start "" "C:\Program Files (x86)\WXWork\WXWork.exe"
) else (
  start "" "C:\Program Files\WXWork\WXWork.exe"
)
rem ping 代替 timeout：timeout 在无控制台输入的任务环境里会报错中断
ping -n 9 127.0.0.1 >nul
set PYTHONUNBUFFERED=1
C:\Python312\python.exe C:\cloud-agent\push-qr.py >> C:\cloud-agent\logs\push-qr.log 2>&1
