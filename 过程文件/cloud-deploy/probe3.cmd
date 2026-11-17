@echo off
chcp 65001 >nul
echo ===DIR=== > C:\cloud-agent\probe-out.txt
dir C:\cloud-agent >> C:\cloud-agent\probe-out.txt 2>&1
echo ===TASKLIST=== >> C:\cloud-agent\probe-out.txt
tasklist | findstr /I "python curl setup cmd" >> C:\cloud-agent\probe-out.txt 2>&1
echo ===RUNSETUP=== >> C:\cloud-agent\probe-out.txt
type C:\cloud-agent\run-setup.cmd >> C:\cloud-agent\probe-out.txt 2>&1
echo ===LOG=== >> C:\cloud-agent\probe-out.txt
if exist C:\cloud-agent\setup.log (type C:\cloud-agent\setup.log >> C:\cloud-agent\probe-out.txt) else echo NO-LOG >> C:\cloud-agent\probe-out.txt
