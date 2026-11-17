@echo off
schtasks /Create /F /TN CloudSetup2 /TR "C:\cloud-agent\redownload.cmd" /SC ONCE /ST 23:59 /RU Administrator
schtasks /Run /TN CloudSetup2
schtasks /Query /TN CloudSetup2 /V /FO LIST > C:\cloud-agent\probe-out.txt 2>&1
