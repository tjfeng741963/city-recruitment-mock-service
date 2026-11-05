@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
title 城市招聘 · 客户端模式 

rem ============================================================
rem  城市招聘 · 客户端模式一键启动（只跑自动回复，数据全在服务器） 
rem  位置：<仓库根>\deploy\client\客户端模式.bat
rem  本脚本【不】启动本地后端 —— 8090 的后端跑在服务器上 
rem  用法：双击；客户端模式.bat --check-only 只检查不启动 
rem ============================================================

cd /d "%~dp0"
for %%I in ("%~dp0..\..") do set "ROOT=%%~fI"
set "AGENT=%ROOT%\agent"
set "CFG=%AGENT%\config.json"
set "SYS=%SystemRoot%\System32"
set "CHECKONLY=0"
if /I "%~1"=="--check-only" set "CHECKONLY=1"

echo ============================================================
echo  城市招聘 · 客户端模式 
echo  仓库根：%ROOT%
echo ============================================================
echo.

rem ---------- 1. 目录与 uv ----------
if not exist "%AGENT%\autopilot.py" goto :bad_layout
where uv >nul 2>&1
if errorlevel 1 goto :no_uv
echo [检查] 目录结构与 uv 正常 

rem ---------- 2. agent\config.json ----------
set "SERVER="
set "DEVICE_TOKEN="
set "DEVICE_CODE="
if not exist "%CFG%" goto :no_cfg
for /f "usebackq delims=" %%S in (`powershell -NoProfile -Command "try { (Get-Content -Raw -LiteralPath '%CFG%' | ConvertFrom-Json).server } catch { '' }"`) do set "SERVER=%%S"
for /f "usebackq delims=" %%S in (`powershell -NoProfile -Command "try { (Get-Content -Raw -LiteralPath '%CFG%' | ConvertFrom-Json).device_token } catch { '' }"`) do set "DEVICE_TOKEN=%%S"
for /f "usebackq delims=" %%S in (`powershell -NoProfile -Command "try { (Get-Content -Raw -LiteralPath '%CFG%' | ConvertFrom-Json).device_code } catch { '' }"`) do set "DEVICE_CODE=%%S"
if not defined SERVER   goto :no_cfg
if not defined DEVICE_TOKEN goto :no_cfg
if not defined DEVICE_CODE  goto :no_cfg
echo [检查] agent\config.json 已配置（server / device_token / device_code 均非空） 

rem ---------- 3. 企业微信 ----------
%SYS%\tasklist.exe /FI "IMAGENAME eq WXWork.exe" 2>nul | %SYS%\find.exe /I "WXWork.exe" >nul 2>&1
if errorlevel 1 goto :no_wxwork
echo [检查] 企业微信 PC 版正在运行 

rem ---------- 4. 防重复启动 ----------
set "AUTO_RUNNING=0"
%SYS%\WindowsPowerShell\v1.0\powershell.exe -NoProfile -Command "if (Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like ('*autopilo' + 't.py*') }) { exit 0 } else { exit 1 }" >nul 2>&1
if not errorlevel 1 set "AUTO_RUNNING=1"
if "!AUTO_RUNNING!"=="1" (
    echo [检查] 检测到 autopilot 已在运行 
) else (
    echo [检查] 当前没有 autopilot 进程，可以启动 
)

echo.
if "!CHECKONLY!"=="1" (
    if "!AUTO_RUNNING!"=="1" (
        echo [检查通过] 配置、企微、防重复三项都过了一遍；autopilot 已在运行，正常启动会提示并退出。 
    ) else (
        echo [检查通过] 配置、企微、防重复三项都过了；将启动 autopilot（客户端模式，只连服务器）。 
    )
    exit /b 0
)

rem ---------- 5. 防重复：已在跑就退出 ----------
if "!AUTO_RUNNING!"=="1" (
    echo [提示] 自动回复（autopilot）已经在运行，不用重复启动。 
    echo        看板：!SERVER!/api/v1/leads/board 
    echo.
    echo 按任意键关闭窗口 ...
    pause >nul
    exit /b 0
)

rem ---------- 6. 启动（只启动 autopilot，不启动本地后端） ----------
echo [启动] 拉起「自动回复 · 客户端模式」窗口 ...
start "自动回复 · 客户端模式" cmd /k "cd /d "%AGENT%" && uv run python autopilot.py --watch"

echo.
echo ============================================================
echo  [完成] 客户端已启动 
echo    服务器：  !SERVER! 
echo    设备号：  !DEVICE_CODE! 
echo    看板：    !SERVER!/api/v1/leads/board 
echo  验证：看板顶部无红色「采集端离线」条 = 设备在线 
echo  注意：关闭拉起的窗口即停止采集；企微窗口不要最小化到托盘 
echo ============================================================
echo.
echo 按任意键关闭本窗口（不影响已启动的采集进程）...
pause >nul
exit /b 0


rem ===================== 错误分支 =====================

:bad_layout
echo [错误] 没找到 %AGENT%\autopilot.py 
echo        本脚本应位于 <仓库根>\deploy\client\ 下，当前推导的仓库根是： 
echo        %ROOT%
goto :fail

:no_uv
echo [错误] PATH 里找不到 uv。 
echo        先安装 uv：https://docs.astral.sh/uv/
echo        Windows 可执行：winget install --id=astral-sh.uv -e
goto :fail

:no_cfg
echo [错误] agent\config.json 缺失，或 server / device_token / device_code 有空的。 
echo        请先在服务器注册设备，把 server / device_token / device_code 填进 config.json。 
echo        配置文件路径：%CFG%
goto :fail

:no_wxwork
echo [错误] 没检测到企业微信进程（WXWork.exe）。 
echo        请先登录企业微信 PC 版，再重新运行本脚本。 
goto :fail

:fail
echo.
if "!CHECKONLY!"=="1" echo [检查失败] 请先解决上面提示的问题。 
if "!CHECKONLY!"=="0" (
    echo 按任意键关闭窗口 ...
    pause >nul
)
exit /b 1
