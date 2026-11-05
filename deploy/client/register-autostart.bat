@echo off
chcp 65001 >nul
setlocal EnableExtensions
title 城市招聘 · 注册开机自启 

rem ============================================================
rem  城市招聘 · 注册开机自启（二选一） 
rem  [1] 客户端模式（推荐）：登录时运行 客户端模式.bat，只连服务器 
rem  [2] 单机模式（旧行为）：登录时运行 start-all.bat，本机跑后端+采集 
rem  注意：不是 Windows 服务 —— 服务在 SYSTEM 会话，无法操作桌面键鼠 
rem  用法：右键「以管理员身份运行」；加 --check-only 只打印命令不执行 
rem ============================================================

cd /d "%~dp0"
set "SYS=%SystemRoot%\System32"
set "TASK_CLIENT=城市招聘-客户端"
set "TASK_ALL=城市招聘-自动回复"

if /I "%~1"=="--check-only" goto :check_only

echo ============================================================
echo  注册开机自启 
echo ============================================================
echo.
echo  请选择开机后自动启动的模式： 
echo    [1] 客户端模式（推荐）—— 只跑自动回复，数据在服务器 
echo    [2] 单机模式 —— 后端 + 自动回复都在本机跑 
echo.
%SYS%\choice.exe /C 12 /N /T 30 /D 1 /M "输入 1 或 2（30 秒后默认选 1）："
if errorlevel 2 goto :mode_all

:mode_client
set "TASK=%TASK_CLIENT%"
set "TARGET=%~dp0客户端模式.bat"
goto :mode_chosen

:mode_all
set "TASK=%TASK_ALL%"
set "TARGET=%~dp0start-all.bat"

:mode_chosen
echo.
echo ============================================================
echo  已选：%TASK%
echo  程序：  %TARGET%
echo ============================================================
echo.

if not exist "%TARGET%" goto :no_target

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
echo [完成] 已注册。下次登录 Windows 会自动启动：%TASK% 
echo        查看：schtasks /query /tn "%TASK%" /fo LIST
echo        取消：双击 取消开机自启-客户端.bat（客户端）或 unregister-autostart.bat（单机）
echo.
schtasks /query /tn "%TASK%" /fo LIST
echo.
echo 按任意键关闭窗口 ...
pause >nul
exit /b 0


:check_only
echo [检查] 客户端模式将执行： 
echo schtasks /create /tn "%TASK_CLIENT%" /tr "\"%~dp0客户端模式.bat\"" /sc onlogon /rl highest /f
echo.
echo [检查] 单机模式将执行： 
echo schtasks /create /tn "%TASK_ALL%" /tr "\"%~dp0start-all.bat\"" /sc onlogon /rl highest /f
echo.
echo [检查] 当前用户：%USERNAME%
exit /b 0

:no_target
echo [错误] 找不到 %TARGET%
echo        请确认本脚本和目标 .bat 在同一个目录（deploy\client\）。 
goto :fail

:fail
echo.
echo 按任意键关闭窗口 ...
pause >nul
exit /b 1
