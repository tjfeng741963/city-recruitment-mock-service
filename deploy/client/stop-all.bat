@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
title 城市招聘 · 停止 

rem ============================================================
rem  城市招聘 · 停止后端与自动回复 
rem  先按窗口标题关（连同子进程），再按命令行清理残留 python
rem ============================================================

cd /d "%~dp0"
for %%I in ("%~dp0..\..") do set "ROOT=%%~fI"
set "PORT=8090"
set "SYS=%SystemRoot%\System32"

echo ============================================================
echo  城市招聘 · 停止 
echo ============================================================
echo.

if /I "%~1"=="--check-only" (
    echo [检查] 将关闭窗口「后端 :8090」「自动回复」 
    echo [检查] 将清理命令行含 autopilot.py / app.main:app 的 python 进程 
    exit /b 0
)

echo [1/3] 关闭「后端 :8090」窗口 ...
taskkill /FI "WINDOWTITLE eq 后端 :8090" /T /F >nul 2>&1
if errorlevel 1 (
    echo        没找到该窗口 
) else (
    echo        已关闭 
)

echo [2/3] 关闭「自动回复」窗口 ...
taskkill /FI "WINDOWTITLE eq 自动回复" /T /F >nul 2>&1
if errorlevel 1 (
    echo        没找到该窗口 
) else (
    echo        已关闭 
)

echo [3/3] 清理残留 python 进程（autopilot / app.main:app）...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'python.exe' -and $_.CommandLine -match 'autopilot\.py|app\.main:app' } | ForEach-Object { Write-Host ('        结束 PID ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" 2>nul
if errorlevel 1 echo        清理失败，可手动在任务管理器结束 python.exe

echo.
rem 给端口一点释放时间 
%SYS%\timeout.exe /t 2 /nobreak >nul
netstat -ano | findstr /R /C:":%PORT% " | findstr /I "LISTEN" >nul 2>&1
if errorlevel 1 (
    echo [完成] 端口 %PORT% 已释放 
) else (
    echo [注意] 端口 %PORT% 仍在监听，可能被其他程序占用： 
    echo        netstat -ano，找到 :%PORT% 那一行的 PID 后 taskkill /PID 进程号 /F
)

echo.
echo 按任意键关闭窗口 ...
pause >nul
exit /b 0
