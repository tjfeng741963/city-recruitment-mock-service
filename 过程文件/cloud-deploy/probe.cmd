@echo off
chcp 65001 >nul
echo ===dir=== >> C://cloud-agent//probe-out.txt/r/ndir C://cloud-agent >> C://cloud-agent//probe-out.txt 2>&1
echo ===task=== >> C://cloud-agent//probe-out.txt/r/nschtasks /Query /TN CloudSetup /V /FO LIST >> C://cloud-agent//probe-out.txt 2>&1
echo ===log=== >> C://cloud-agent//probe-out.txt/r/ntype C://cloud-agent//setup.log >> C://cloud-agent//probe-out.txt 2>&1
