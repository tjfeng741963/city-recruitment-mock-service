@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
title 后端 :8090

rem ============================================================
rem  城市招聘 · 后端 API（FastAPI）
rem  用法：双击运行；或 start-后端.bat --check-only 只做前置检查
rem ============================================================

cd /d "%~dp0backend"
if errorlevel 1 goto :no_dir

set "ROOT=%~dp0"
set "LOGDIR=%ROOT%logs"
set "LOG=%LOGDIR%\backend.log"
set "PORT=8090"
set "CHECKONLY=0"
if /I "%~1"=="--check-only" set "CHECKONLY=1"

echo ============================================================
echo  城市招聘 · 后端 API
echo  地址：http://127.0.0.1:%PORT%
echo  目录：%CD%
echo ============================================================
echo.

rem ---------- 1. uv 是否可用 ----------
where uv >nul 2>&1
if errorlevel 1 goto :no_uv
for /f "delims=" %%V in ('uv --version 2^>nul') do set "UVVER=%%V"
echo [检查] uv 可用：!UVVER!

rem ---------- 2. 端口是否已被占用 ----------
rem 只看 LISTEN 状态，避免把「已建立连接」误判成端口被占
netstat -ano | findstr /R /C:":%PORT% " | findstr /I /C:"LISTEN" >nul 2>&1
if not errorlevel 1 goto :port_taken
echo [检查] 端口 %PORT% 未被占用

rem ---------- 3. 日志目录 ----------
if not exist "%LOGDIR%" mkdir "%LOGDIR%" >nul 2>&1
if not exist "%LOGDIR%" goto :no_logdir
echo [检查] 日志目录：%LOGDIR%
echo.

if "!CHECKONLY!"=="1" (
    echo [检查通过] 依赖与端口均正常，准备启动：
    echo            uv run uvicorn app.main:app --host 127.0.0.1 --port %PORT%
    goto :ok
)

echo [启动] uvicorn 正在启动，首次运行 uv 可能要装依赖，请稍候 ...
echo [日志] %LOG%
echo [停止] 在本窗口按 Ctrl+C
echo.
>>"%LOG%" echo.
>>"%LOG%" echo ===== %DATE% %TIME% 后端启动 =====

for /f "usebackq delims=" %%L in (`uv run uvicorn app.main:app --host 127.0.0.1 --port %PORT% 2^>^&1`) do (
    set "LN=%%L"
    echo(!LN!
    >>"%LOG%" echo(!LN!
)

echo.
echo [退出] 后端进程已结束
>>"%LOG%" echo ===== %DATE% %TIME% 后端退出 =====
goto :ok


rem ===================== 错误分支 =====================

:port_taken
echo [错误] 端口 %PORT% 已被占用，为避免端口冲突，本窗口不再启动第二个后端。
echo.
echo        查看占用：netstat -ano ^| findstr ":%PORT% "
echo        结束进程：taskkill /PID 进程号 /F
echo        或者：关掉已存在的「后端 :8090」窗口后重试。
goto :fail

:no_uv
echo [错误] 找不到 uv 命令，无法拉起后端。
echo        请先安装：winget install --id=astral-sh.uv -e
echo        装完重开一个命令行窗口，执行 uv --version 确认能看到版本号。
goto :fail

:no_dir
echo [错误] 找不到 backend 目录：%~dp0backend
echo        请确认本 bat 放在项目根目录 city-recruitment-mock-service 下。
goto :fail

:no_logdir
echo [错误] 无法创建日志目录：%LOGDIR%
echo        请检查该目录是否有写权限，或手动新建 logs 文件夹后重试。
goto :fail

:fail
echo.
if "!CHECKONLY!"=="1" echo [检查失败] 请先解决上面提示的问题。
if "!CHECKONLY!"=="0" (
    echo 按任意键关闭窗口 ...
    pause >nul
)
exit /b 1

:ok
if "!CHECKONLY!"=="0" (
    echo 按任意键关闭窗口 ...
    pause >nul
)
exit /b 0
