@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
title 城市招聘 · 状态 

rem ============================================================
rem  城市招聘 · 状态检查（只读，不改任何东西） 
rem  输出：端口 / 进程数 / 健康检查 / 最近日志 
rem ============================================================

cd /d "%~dp0"
for %%I in ("%~dp0..\..") do set "ROOT=%%~fI"
set "LOGDIR=%ROOT%\logs"
set "PORT=8090"
set "SYS=%SystemRoot%\System32"
if exist "%SYS%\curl.exe" (set "CURL=%SYS%\curl.exe") else (set "CURL=curl")

echo ============================================================
echo  城市招聘 · 运行状态 
echo  %DATE% %TIME%
echo ============================================================
echo.

rem ---------- 1. 端口 ----------
echo [1/4] 端口 %PORT%
set "BACKPID="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":%PORT% " ^| findstr /I "LISTEN"') do set "BACKPID=%%P"
if defined BACKPID (
    echo        正在监听，PID=!BACKPID!
) else (
    echo        未监听（后端没在跑） 
)
echo.

rem ---------- 2. python 进程 ----------
echo [2/4] python.exe 进程 
set "PYCOUNT=0"
for /f %%C in ('%SYS%\tasklist.exe /FI "IMAGENAME eq python.exe" /NH 2^>nul ^| %SYS%\find.exe /C /I "python.exe"') do set "PYCOUNT=%%C"
echo        共 !PYCOUNT! 个（含 autopilot；0 = 两个都没跑） 
if !PYCOUNT! GTR 0 (
    %SYS%\tasklist.exe /FI "IMAGENAME eq python.exe" /FO TABLE /NH 2>nul
)
echo.

rem ---------- 3. 健康检查 ----------
echo [3/4] 后端健康检查 http://127.0.0.1:%PORT%/healthz
where curl >nul 2>&1
if errorlevel 1 (
    echo        未找到 curl.exe，跳过（Windows 10/11 自带 curl） 
) else (
    "%CURL%" --noproxy "*" -s -m 3 "http://127.0.0.1:%PORT%/healthz"
    if errorlevel 1 (
        echo        请求失败：后端未启动，或端口不是 %PORT%
    ) else (
        echo.
        echo        正常 
    )
)
echo.

rem ---------- 4. 日志 ----------
echo [4/4] 最近日志 
if not exist "%LOGDIR%" (
    echo        没有 logs 目录（用 start-all.bat 启动后才会生成） 
    goto :done
)
call :tail "%LOGDIR%\backend.log" "后端"
call :tail "%LOGDIR%\agent.log" "自动回复"

:done
echo.
echo ============================================================
echo  排查入口： 
echo    后端日志  %LOGDIR%\backend.log
echo    自动回复  %LOGDIR%\agent.log
echo    看板      http://127.0.0.1:%PORT%/api/v1/leads/board
echo ============================================================
exit /b 0


rem ===================== 子过程 =====================

:tail
if not exist "%~1" (
    echo        [%~2] 暂无日志文件 
    exit /b 0
)
echo        --- %~2 · 最后 10 行 ---
powershell -NoProfile -Command "Get-Content -LiteralPath '%~1' -Tail 10 -Encoding UTF8" 2>nul
if errorlevel 1 echo        [%~2] 读取失败（文件被占用或 PowerShell 不可用） 
echo.
exit /b 0
