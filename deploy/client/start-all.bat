@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
title 城市招聘 · 一键启动 

rem ============================================================
rem  城市招聘 · 一键启动（后端 :8090 + 自动回复） 
rem  位置：<仓库根>\deploy\client\start-all.bat
rem  实际动作复用仓库根的两个启动脚本，日志仍写 logs\backend.log / logs\agent.log
rem  用法：双击；start-all.bat --check-only 只检查不启动 
rem ============================================================

cd /d "%~dp0"
for %%I in ("%~dp0..\..") do set "ROOT=%%~fI"
set "BACKEND=%ROOT%\backend"
set "AGENT=%ROOT%\agent"
set "PORT=8090"
set "SYS=%SystemRoot%\System32"
set "CHECKONLY=0"
if /I "%~1"=="--check-only" set "CHECKONLY=1"

echo ============================================================
echo  城市招聘 · 一键启动 
echo  仓库根：%ROOT%
echo ============================================================
echo.

rem ---------- 1. 基本检查 ----------
if not exist "%ROOT%\start-后端.bat"   goto :no_scripts
if not exist "%ROOT%\start-自动回复.bat" goto :no_scripts
if not exist "%BACKEND%\pyproject.toml" goto :no_scripts
if not exist "%AGENT%\autopilot.py"     goto :no_scripts
where uv >nul 2>&1
if errorlevel 1 goto :no_uv
echo [检查] 目录、启动脚本、uv 均正常 

rem ---------- 2. 后端是否已在监听 ----------
set "BACKEND_RUNNING=0"
netstat -ano | findstr /R /C:":%PORT% " | findstr /I "LISTEN" >nul 2>&1
if not errorlevel 1 set "BACKEND_RUNNING=1"
if "!BACKEND_RUNNING!"=="1" (
    echo [检查] 端口 %PORT% 已在监听，本次跳过后端 
) else (
    echo [检查] 端口 %PORT% 空闲，需要启动后端 
)

rem ---------- 3. agent 配置 ----------
set "HAS_AGENT_CFG=0"
if exist "%AGENT%\config.json" set "HAS_AGENT_CFG=1"
if "!HAS_AGENT_CFG!"=="1" (
    echo [检查] agent\config.json 已存在 
) else (
    echo [警告] 缺少 agent\config.json，本次只启动后端 
)

echo.
if "!CHECKONLY!"=="1" (
    if "!HAS_AGENT_CFG!"=="0" (
        echo [检查通过] 缺少 agent\config.json：只会确保后端运行，不启动自动回复 
    ) else (
        if "!BACKEND_RUNNING!"=="1" (
            echo [检查通过] 将跳过 后端，仅启动 自动回复 
        ) else (
            echo [检查通过] 将依次启动：后端 -^> 等 5 秒 -^> 自动回复 
        )
    )
    exit /b 0
)

rem ---------- 4. 启动后端 ----------
if "!BACKEND_RUNNING!"=="0" (
    echo [1/2] 启动「后端 :8090」窗口 ...
    start "后端 :8090" cmd /k ""%ROOT%\start-后端.bat""
    echo       等待后端就绪（5 秒）...
    %SYS%\timeout.exe /t 5 /nobreak >nul
) else (
    echo [1/2] 跳过后端（%PORT% 已在监听） 
)

rem ---------- 5. 启动自动回复 ----------
if "!HAS_AGENT_CFG!"=="0" (
    echo [2/2] 跳过自动回复：先把 agent\config.json 配好 
    echo        做法见 docs\部署说明.md 第 3 节 
    echo.
    if "!BACKEND_RUNNING!"=="1" (
        echo 后端本来就在运行，本次没有启动新的自动回复进程。 
    ) else (
        echo 本次只启动了后端。 
    )
    echo 窗口将在 8 秒后关闭 ...
    %SYS%\timeout.exe /t 8 /nobreak >nul
    exit /b 0
)

echo [2/2] 启动「自动回复」窗口 ...
start "自动回复" cmd /k ""%ROOT%\start-自动回复.bat""

echo.
echo [完成] 已拉起窗口。关闭窗口即停止对应进程，或运行 stop-all.bat。 
echo        看板：http://127.0.0.1:%PORT%/api/v1/leads/board
exit /b 0


rem ===================== 错误分支 =====================

:no_scripts
echo [错误] 缺少启动脚本或目录。请确认仓库结构完整： 
echo        %ROOT%\start-后端.bat
echo        %ROOT%\start-自动回复.bat
echo        %BACKEND%\pyproject.toml
echo        %AGENT%\autopilot.py
goto :fail

:no_uv
echo [错误] PATH 里找不到 uv，先装：https://docs.astral.sh/uv/
goto :fail

:fail
echo.
if "!CHECKONLY!"=="1" echo [检查失败] 请先解决上面提示的问题。 
if "!CHECKONLY!"=="0" (
    echo 按任意键关闭窗口 ...
    pause >nul
)
exit /b 1
