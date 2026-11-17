@echo off
chcp 65001 >nul
echo ===APPPATHS=== > C:\cloud-agent\wxwork-path.txt 2>&1
reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\WXWork.exe" >> C:\cloud-agent\wxwork-path.txt 2>&1
echo ===UNINSTALL=== >> C:\cloud-agent\wxwork-path.txt 2>&1
reg query "HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\WXWork" >> C:\cloud-agent\wxwork-path.txt 2>&1
echo ===PF86=== >> C:\cloud-agent\wxwork-path.txt 2>&1
dir "C:\Program Files (x86)\WXWork" >> C:\cloud-agent\wxwork-path.txt 2>&1
echo ===SEARCH=== >> C:\cloud-agent\wxwork-path.txt 2>&1
where /R "C:\Program Files (x86)" WXWork.exe >> C:\cloud-agent\wxwork-path.txt 2>&1
where /R "C:\Program Files" WXWork.exe >> C:\cloud-agent\wxwork-path.txt 2>&1
