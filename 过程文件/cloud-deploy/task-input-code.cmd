@echo off
rem 在 Console 会话输入验证码（参数 %1）
C:\Python312\python.exe C:\cloud-agent\input-code.py %1 > C:\cloud-agent\input-code-out.txt 2>&1
C:\Python312\python.exe C:\cloud-agent\probe-windows.py >> C:\cloud-agent\input-code-out.txt 2>&1
