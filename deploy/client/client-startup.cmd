@echo off
chcp 65001 >nul
setlocal
cd /d C:\agent
if errorlevel 1 exit /b 1
set "PYTHON=C:\PROGRA~1\Python311\python.exe"
if not exist "%PYTHON%" (
    echo [更新器错误] 未找到配置的 Python 3.11，未启动自动回复。
    exit /b 1
)
"%PYTHON%" C:\agent\client_updater.py
if errorlevel 1 (
    echo [更新器错误] 更新未完成，未启动自动回复。请保留此窗口与日志以便排查。
    exit /b 1
)
endlocal
exit /b 0
