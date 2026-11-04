@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
title 一键启动 · 城市招聘

rem ============================================================
rem  一键拉起两个进程：先后端（8090），等 5 秒，再自动回复
rem  任一子窗口报错时，回到本窗口看提示即可
rem ============================================================

cd /d "%~dp0"
set "PORT=8090"

echo ============================================================
echo  城市招聘 · 一键启动
echo  目录：%CD%
echo ============================================================
echo.

where uv >nul 2>&1
if errorlevel 1 goto :no_uv
for /f "delims=" %%V in ('uv --version 2^>nul') do set "UVVER=%%V"
echo [检查] uv 可用：!UVVER!

if not exist "%~dp0start-后端.bat" goto :no_backend_bat
if not exist "%~dp0start-自动回复.bat" goto :no_agent_bat
if not exist "%~dp0agent\config.json" (
    echo [警告] 缺少 agent\config.json，自动回复窗口会提示复制 config.example.json
) else (
    echo [检查] agent\config.json 已存在
)

netstat -ano | findstr /R /C:":%PORT% " | findstr /I /C:"LISTEN" >nul 2>&1
if errorlevel 1 (
    echo [检查] 端口 %PORT% 空闲
) else (
    echo [提示] 端口 %PORT% 已在监听：后端窗口会提示"已被占用"后自行退出，
    echo        需要重启后端的话，先关掉已有的后端窗口再来。
)
echo.

if /I "%~1"=="--check-only" (
    echo [检查通过] 将依次启动：start-后端.bat -^> 等 5 秒 -^> start-自动回复.bat
    exit /b 0
)

echo [1/2] 启动后端窗口 ...
start "" cmd /k ""%~dp0start-后端.bat""
echo       等待后端就绪（5 秒）...
timeout /t 5 /nobreak >nul

echo [2/2] 启动自动回复窗口 ...
start "" cmd /k ""%~dp0start-自动回复.bat""

echo.
echo [完成] 两个窗口已拉起：
echo        后端 :8090    http://127.0.0.1:%PORT%/healthz
echo        自动回复      日志在 logs\agent.log
echo        停止方式：分别在各自窗口按 Ctrl+C
echo.
echo 按任意键关闭本启动窗口（不影响两个子窗口）...
pause >nul
exit /b 0


rem ===================== 错误分支 =====================

:no_uv
echo [错误] 找不到 uv 命令，两个进程都无法启动。
echo        请先安装：winget install --id=astral-sh.uv -e
echo        装完重开一个命令行窗口，执行 uv --version 确认能看到版本号。
goto :fail

:no_backend_bat
echo [错误] 缺少 start-后端.bat，请确认它和本文件在同一目录。
goto :fail

:no_agent_bat
echo [错误] 缺少 start-自动回复.bat，请确认它和本文件在同一目录。
goto :fail

:fail
echo.
echo 按任意键关闭窗口 ...
pause >nul
exit /b 1
