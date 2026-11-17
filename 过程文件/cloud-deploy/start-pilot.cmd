@echo off
rem 启动 autopilot 接管企微对话（由 pilot-hidden.vbs 隐藏拉起）
cd /d C:\cloud-agent
if not exist logs mkdir logs
set PYTHONUNBUFFERED=1
C:\Python312\python.exe C:\cloud-agent\autopilot.py --watch >> C:\cloud-agent\logs\pilot.log 2>&1
