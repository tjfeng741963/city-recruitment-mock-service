#!/bin/bash
# 在 Console 会话跑窗口探针（计划任务 /IT），拉回结果
set -a
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
export SSH_ASKPASS_REQUIRE=force
export SSH_ASKPASS="C:/Users/a2436/Desktop/code/city-recruitment-mock-service/过程文件/cloud-deploy/askpass.sh"
cd "C:/Users/a2436/Desktop/code/city-recruitment-mock-service/过程文件/cloud-deploy" || exit 1

scp -o StrictHostKeyChecking=no task-probe.cmd Administrator@124.221.39.160:C:/cloud-agent/task-probe.cmd || exit 1
ssh -o StrictHostKeyChecking=no Administrator@124.221.39.160 "schtasks /Delete /TN CloudProbe /F >nul 2>&1 & schtasks /Create /TN CloudProbe /TR \"C:\cloud-agent\task-probe.cmd\" /SC ONCE /ST 23:58 /RU Administrator /IT /F & schtasks /Run /TN CloudProbe" > /dev/null 2>&1
sleep 8
scp -o StrictHostKeyChecking=no Administrator@124.221.39.160:C:/cloud-agent/probe-win-out.txt probe-win-out.txt || exit 1
echo "=== Console 会话窗口结构 ==="
iconv -f GBK -t UTF-8 probe-win-out.txt 2>/dev/null || cat probe-win-out.txt
