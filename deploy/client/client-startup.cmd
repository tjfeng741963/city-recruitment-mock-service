@echo off
chcp 65001 >nul
setlocal
cd /d C:\agent
if errorlevel 1 exit /b 1
set "PYTHON=C:\PROGRA~1\Python311\python.exe"
if not exist "%PYTHON%" (
    echo [启动错误] 未找到配置的 Python 3.11，未启动自动回复。
    exit /b 1
)
"%PYTHON%" C:\agent\client_updater.py --supervise
if errorlevel 1 (
    echo [启动错误] 本机客户端启动未确认。请在客户端管理器中查看状态和日志。
    exit /b 1
)
endlocal
exit /b 0
