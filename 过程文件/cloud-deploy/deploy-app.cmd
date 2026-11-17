@echo off
chcp 65001 >nul
echo [1] pip install
C:\Python312\python.exe -m pip install -q --disable-pip-version-check httpx psutil
echo [2] set path
set WXWORK=C:\Program Files (x86)\WXWork\WXWork.exe
echo [3] start WXWork
start "" "%WXWORK%"
echo [4] start push-qr (background)
start "pushqr" /min C:\Python312\pythonw.exe C:\cloud-agent\push-qr.py
echo DEPLOY-APP-DONE
