@echo off
taskkill /IM curl.exe /F >nul 2>&1
echo [1] 开始断点续传下载 Python... > C:\cloud-agent\install.log 2>&1
curl -L -C - -o C:\cloud-agent\python-inst.exe https://mirrors.huaweicloud.com/python/3.12.8/python-3.12.8-amd64.exe >> C:\cloud-agent\install.log 2>&1
echo [2] 下载完成，开始静默安装... >> C:\cloud-agent\install.log 2>&1
C:\cloud-agent\python-inst.exe /quiet InstallAllUsers=1 PrependPath=1 TargetDir=C:\Python312 Include_pip=1 Include_test=0 >> C:\cloud-agent\install.log 2>&1
if not exist C:\Python312\python.exe (
  echo INSTALL-FAILED >> C:\cloud-agent\install.log 2>&1
  exit /b 1
)
echo [3] 安装成功，安装 httpx... >> C:\cloud-agent\install.log 2>&1
C:\Python312\python.exe -m pip install -q --disable-pip-version-check httpx psutil >> C:\cloud-agent\install.log 2>&1
C:\Python312\python.exe --version >> C:\cloud-agent\install.log 2>&1
echo INSTALL-OK >> C:\cloud-agent\install.log 2>&1
