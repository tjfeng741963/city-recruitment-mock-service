@echo off
chcp 65001 >nul
setlocal EnableExtensions
title 城市招聘 · 注册开机自启（客户端） 

rem ============================================================
rem  城市招聘 · 注册开机自启（客户端模式） 
rem  当前用户登录时运行 客户端模式.bat（最高权限，避免 UAC 拦截） 
rem  注意：不是 Windows 服务 —— 服务在 SYSTEM 会话，无法操作桌面键鼠 
rem  用法：右键「以管理员身份运行」；加 --check-only 只打印命令不执行 
rem ============================================================

cd /d "%~dp0"
set "TASK=城市招聘-客户端"
set "TARGET=%~dp0客户端模式.bat"

echo ============================================================
echo  注册开机自启（客户端模式） 
echo  任务名：%TASK%
echo  程序：  %TARGET%
echo ============================================================
echo.

if not exist "%TARGET%" goto :no_target

if /I "%~1"=="--check-only" (
    echo [检查] 目标脚本存在 
    echo [检查] 当前用户：%USERNAME%
    echo.
    echo 将执行： 
    echo schtasks /create /tn "%TASK%" /tr "\"%TARGET%\"" /sc onlogon /rl highest /f
    exit /b 0
)

rem ---------- 管理员检查 ----------
whoami /groups 2>nul | findstr /C:"S-1-16-12288" >nul
if errorlevel 1 (
    echo [警告] 当前窗口不是管理员，创建「最高权限」任务大概率失败。 
    echo        请关掉本窗口，右键本文件 → 以管理员身份运行。 
    echo.
)

rem ---------- 创建任务 ----------
schtasks /create /tn "%TASK%" /tr "\"%TARGET%\"" /sc onlogon /rl highest /f
if errorlevel 1 goto :fail

echo.
echo [完成] 已注册。下次登录 Windows 会自动以客户端模式启动（只连服务器）。 
echo        查看：schtasks /query /tn "%TASK%" /fo LIST
echo        取消：双击 取消开机自启-客户端.bat
echo.
schtasks /query /tn "%TASK%" /fo LIST
echo.
echo 按任意键关闭窗口 ...
pause >nul
exit /b 0


:no_target
echo [错误] 找不到 %TARGET%
echo        请确认本脚本和 客户端模式.bat 在同一个目录。 
goto :fail

:fail
echo.
echo 按任意键关闭窗口 ...
pause >nul
exit /b 1
