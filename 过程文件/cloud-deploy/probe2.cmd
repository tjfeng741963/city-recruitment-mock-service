@echo off
chcp 65001 >nul
schtasks /Query /TN CloudSetup /V /FO LIST > C://cloud-agent//probe-out.txt 2>&1
dir C://cloud-agent >> C://cloud-agent//probe-out.txt 2>&1
