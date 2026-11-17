@echo off
chcp 65001 >nul
taskkill /IM curl.exe /F >nul 2>&1
if exist C:\Python312\python.exe goto :pip
echo 开始静默安装 Python...
C:\cloud-agent\python-inst.exe /quiet InstallAllUsers=1 PrependPath=1 TargetDir=C:\Python312 Include_pip=1 Include_test=0
if not exist C:\Python312\python.exe (
  echo PYTHON-INSTALL-FAILED
  exit /b 1
)
:pip
C:\Python312\python.exe -m pip install -q --disable-pip-version-check httpx psutil
echo PYTHON-READY
C:\Python312\python.exe --version
