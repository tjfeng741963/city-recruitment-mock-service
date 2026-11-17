@echo off
chcp 65001 >nul
rem 启动企微客户端：常驻循环（采集 + 领指令 + 掉登录自动推二维码）
rem 先确保本地侧反向隧道在跑（见 README 第 3 步）
cd /d %~dp0agent
if not exist logs mkdir logs
python main.py >> logs\client-run.log 2>&1
