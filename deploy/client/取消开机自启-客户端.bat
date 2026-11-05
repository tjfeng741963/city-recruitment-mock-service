@echo off
chcp 65001 >nul
setlocal EnableExtensions
title 城市招聘 · 取消开机自启（客户端） 

rem ============================================================
rem  城市招聘 · 取消开机自启（客户端模式，删除计划任务） 
rem  用法：右键「以管理员身份运行」；加 --check-only 只看状态 
rem ============================================================

cd /d "%~dp0"
set "TASK=城市招聘-客户端"

echo ============================================================
echo  取消开机自启（客户端模式） 
echo  任务名：%TASK%
echo ============================================================
echo.

if /I "%~1"=="--check-only" (
    echo [检查] 将执行：schtasks /delete /tn "%TASK%" /f
    echo        任务是否存在可用 schtasks /query /tn "%TASK%" 查看 
    exit /b 0
)

schtasks /query /tn "%TASK%" >nul 2>&1
if errorlevel 1 (
    echo [提示] 该任务本来就没注册，无需删除。 
    echo.
    echo 按任意键关闭窗口 ...
    pause >nul
    exit /b 0
)

schtasks /delete /tn "%TASK%" /f
if errorlevel 1 goto :fail

echo.
echo [完成] 已取消客户端模式开机自启。已运行的采集进程不受影响。 
echo.
echo 按任意键关闭窗口 ...
pause >nul
exit /b 0


:fail
echo.
echo [错误] 删除失败。请确认是用管理员身份运行的。 
echo.
echo 按任意键关闭窗口 ...
pause >nul
exit /b 1
