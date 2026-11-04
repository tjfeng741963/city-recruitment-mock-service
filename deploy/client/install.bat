@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
title 城市招聘 · 首次安装 

rem ============================================================
rem  城市招聘 · 客户端首次安装 
rem  位置：<仓库根>\deploy\client\install.bat
rem  用法：双击运行；install.bat --check-only 只做前置检查，不装依赖 
rem ============================================================

cd /d "%~dp0"
for %%I in ("%~dp0..\..") do set "ROOT=%%~fI"
set "BACKEND=%ROOT%\backend"
set "AGENT=%ROOT%\agent"
set "CFG=%~dp0config"
set "PORT=8090"
set "CHECKONLY=0"
if /I "%~1"=="--check-only" set "CHECKONLY=1"

echo ============================================================
echo  城市招聘 · 客户端首次安装 
echo  仓库根 %ROOT%
echo ============================================================
echo.

rem ---------- 1. 目录结构 ----------
if not exist "%BACKEND%\pyproject.toml" goto :bad_layout
if not exist "%AGENT%\autopilot.py" goto :bad_layout
echo [检查] 目录结构正确（backend、agent 都在） 

rem ---------- 2. uv ----------
where uv >nul 2>&1
if errorlevel 1 goto :no_uv
for /f "delims=" %%V in ('uv --version 2^>nul') do set "UVVER=%%V"
echo [检查] uv 可用：!UVVER!

rem ---------- 3. Python >= 3.11 ----------
set "PYVER="
for /f "tokens=2" %%V in ('python --version 2^>nul') do set "PYVER=%%V"
if not defined PYVER (
    for /f "tokens=2" %%V in ('py -3 --version 2^>nul') do set "PYVER=%%V"
)
if not defined PYVER (
    echo [提示] PATH 里没有 python，uv sync 会自动准备 3.11+ 解释器，继续。 
) else (
    for /f "tokens=1,2 delims=." %%A in ("!PYVER!") do (
        set "PYMAJ=%%A"
        set "PYMIN=%%B"
    )
    if not defined PYMIN goto :py_old
    set /a "PYNUM=PYMAJ*100+PYMIN" 2>nul
    if not defined PYNUM goto :py_old
    if !PYNUM! LSS 311 goto :py_old
    echo [检查] Python !PYVER!（要求 ≥ 3.11） 
)

rem ---------- 4. 端口 ----------
netstat -ano | findstr /R /C:":%PORT% " | findstr /I "LISTEN" >nul 2>&1
if not errorlevel 1 goto :port_taken
echo [检查] 端口 %PORT% 空闲 

echo.
if "!CHECKONLY!"=="1" (
    echo [检查通过] 前置条件满足。正式安装请不带参数运行本脚本。 
    exit /b 0
)

rem ---------- 5. 依赖（uv sync 自动建 .venv） ----------
echo [1/4] 同步后端依赖（backend\uv sync）...
pushd "%BACKEND%"
uv sync
if errorlevel 1 (
    popd
    goto :sync_fail
)
popd
echo [完成] 后端依赖就绪 
echo.

echo [2/4] 同步采集端依赖（agent\uv sync）...
pushd "%AGENT%"
uv sync
if errorlevel 1 (
    popd
    goto :sync_fail
)
popd
echo [完成] 采集端依赖就绪 
echo.

rem ---------- 6. backend\.env ----------
if exist "%BACKEND%\.env" (
    echo [保留] backend\.env 已存在，不覆盖 
) else (
    if not exist "%CFG%\backend.env.example" goto :no_env_tpl
    copy /y "%CFG%\backend.env.example" "%BACKEND%\.env" >nul
    if errorlevel 1 goto :copy_fail
    echo [生成] backend\.env（管理员密码、LLM Key 可在里面改） 
)
echo.

rem ---------- 7. agent\config.json ----------
if exist "%AGENT%\config.json" (
    echo [保留] agent\config.json 已存在 
) else (
    echo [待办] agent\config.json 还没生成 —— 不会自动编造 token。 
    echo        步骤： 
    echo          a. 先双击 start-all.bat，让后端跑起来（此时只启动后端） 
    echo          b. 按 docs\部署说明.md 第 3 节，注册设备并拿到 device_token
    echo          c. 复制 agent\config.example.json 为 agent\config.json
    echo          d. 填入 device_token、tool_path、brain.password
)
echo.

echo ============================================================
echo  安装完成，下一步： 
echo    1. 双击 start-all.bat 启动（后端 + 自动回复） 
echo    2. 浏览器打开 http://127.0.0.1:%PORT%/api/v1/leads/board
echo       顶部红条消失 = 采集端在线 
echo    3. 排查：双击 status.bat；细节见 docs\部署说明.md
echo ============================================================
exit /b 0


rem ===================== 错误分支 =====================

:bad_layout
echo [错误] 没找到 backend 或 agent 目录。 
echo        本脚本应位于 <仓库根>\deploy\client\ 下，当前推导的仓库根是： 
echo        %ROOT%
goto :fail

:no_uv
echo [错误] PATH 里找不到 uv。 
echo        先安装 uv：https://docs.astral.sh/uv/
echo        Windows 可执行：winget install --id=astral-sh.uv -e
echo        装完重开命令行，uv --version 能看到版本号再回来。 
goto :fail

:py_old
echo [错误] 检测到 Python !PYVER!，低于 3.11。 
echo        请安装 Python 3.11 或更高版本，或让 uv 管理解释器。 
goto :fail

:port_taken
echo [错误] 端口 %PORT% 已被占用，安装检查不通过。 
echo        查看占用：netstat -ano
echo        结束进程：taskkill /PID 进程号 /F
echo        如果是上次的后端还在跑，先双击 stop-all.bat。 
goto :fail

:sync_fail
echo [错误] uv sync 失败，请把上面的报错发出来排查。 
echo        常见原因：网络不通、uv 版本过旧、pyproject.toml 被改动。 
goto :fail

:no_env_tpl
echo [错误] 缺少模板：%CFG%\backend.env.example
goto :fail

:copy_fail
echo [错误] 复制 backend.env.example 到 backend\.env 失败，请检查写权限。 
goto :fail

:fail
echo.
if "!CHECKONLY!"=="1" echo [检查失败] 请先解决上面提示的问题。 
if "!CHECKONLY!"=="0" (
    echo 按任意键关闭窗口 ...
    pause >nul
)
exit /b 1
