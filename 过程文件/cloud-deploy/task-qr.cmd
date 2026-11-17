@echo off
rem 建交互式计划任务并立即运行（/IT = 交互令牌 → 进程落在活动控制台会话里）
schtasks /Delete /TN CloudQR /F >nul 2>&1
schtasks /Create /TN CloudQR /TR "C:\cloud-agent\start-qr.cmd" /SC ONCE /ST 23:59 /RU Administrator /IT /F
schtasks /Run /TN CloudQR
