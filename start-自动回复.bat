@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
title 自动回复

rem ============================================================
rem  城市招聘 · 企业微信自动回复（agent/autopilot.py --watch）
rem  前提：后端已在 8090 运行、企微 PC 已登录且窗口能被置前
rem  用法：双击运行；或 start-自动回复.bat --check-only 只做前置检查
rem ============================================================

cd /d "%~dp0agent"
if errorlevel 1 goto :no_dir

set "ROOT=%~dp0"
set "LOGDIR=%ROOT%logs"
set "LOG=%LOGDIR%\agent.log"
set "PORT=8090"
set "CHECKONLY=0"
if /I "%~1"=="--check-only" set "CHECKONLY=1"

echo ============================================================
echo  城市招聘 · 企业微信自动回复
echo  目录：%CD%
echo ============================================================
echo.

rem ---------- 1. uv 是否可用 ----------
where uv >nul 2>&1
if errorlevel 1 goto :no_uv
for /f "delims=" %%V in ('uv --version 2^>nul') do set "UVVER=%%V"
echo [检查] uv 可用：!UVVER!

rem ---------- 2. 后端是否已在 8090 监听 ----------
rem 只看 LISTEN 状态，避免把「已建立连接」误判成后端在跑
netstat -ano | findstr /R /C:":%PORT% " | findstr /I /C:"LISTEN" >nul 2>&1
if errorlevel 1 goto :no_backend
echo [检查] 后端 %PORT% 已在监听

rem ---------- 3. config.json ----------
if not exist "config.json" goto :no_config
echo [检查] config.json 已存在

rem ---------- 4. 日志目录 ----------
if not exist "%LOGDIR%" mkdir "%LOGDIR%" >nul 2>&1
if not exist "%LOGDIR%" goto :no_logdir
echo [检查] 日志目录：%LOGDIR%
echo.

if "!CHECKONLY!"=="1" (
    echo [检查通过] 依赖、后端端口、配置文件均正常，准备启动：
    echo            uv run python autopilot.py --watch
    goto :ok
)

echo [提醒] 请确保企业微信 PC 端已登录，运行期间不要最小化或锁屏。
echo [启动] autopilot 正在启动 ...
echo [日志] %LOG%
echo [停止] 在本窗口按 Ctrl+C
echo.
>>"%LOG%" echo.
>>"%LOG%" echo ===== %DATE% %TIME% 自动回复启动 =====

for /f "usebackq delims=" %%L in (`uv run python autopilot.py --watch 2^>^&1`) do (
    set "LN=%%L"
    echo(!LN!
    >>"%LOG%" echo(!LN!
)

echo.
echo [退出] 自动回复进程已结束
>>"%LOG%" echo ===== %DATE% %TIME% 自动回复退出 =====
goto :ok


rem ===================== 错误分支 =====================

:no_backend
echo [错误] 后端没有在 127.0.0.1:%PORT% 监听，请先启动后端。
echo        做法：先双击根目录的 start-后端.bat，等窗口出现
echo              Uvicorn running on http://127.0.0.1:%PORT%
echo              之后再运行本脚本；或直接双击 start-全部.bat。
goto :fail

:no_config
echo [错误] 缺少 agent\config.json，自动回复无法读取配置。
echo        做法：在 agent 目录复制模板后再填内容
echo              copy config.example.json config.json
echo        必填：device_token（后端下发的设备令牌）、brain.password（后端管理员密码）
echo        brain.mode = kb 走知识库；brain.mode = fixed 只用固定文本
goto :fail

:no_uv
echo [错误] 找不到 uv 命令，无法拉起自动回复。
echo        请先安装：winget install --id=astral-sh.uv -e
echo        装完重开一个命令行窗口，执行 uv --version 确认能看到版本号。
goto :fail

:no_dir
echo [错误] 找不到 agent 目录：%~dp0agent
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
