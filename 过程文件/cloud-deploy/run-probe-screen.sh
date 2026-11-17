#!/bin/bash
# 推送探针 → 服务器执行 → 拉回结果
set -a
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
export SSH_ASKPASS_REQUIRE=force
export SSH_ASKPASS="C:/Users/a2436/Desktop/code/city-recruitment-mock-service/过程文件/cloud-deploy/askpass.sh"
cd "C:/Users/a2436/Desktop/code/city-recruitment-mock-service/过程文件/cloud-deploy" || exit 1
scp -o StrictHostKeyChecking=no probe-screen.cmd Administrator@124.221.39.160:C:/cloud-agent/probe-screen.cmd || exit 1
ssh -o StrictHostKeyChecking=no Administrator@124.221.39.160 "C:\cloud-agent\probe-screen.cmd" >/dev/null 2>&1
scp -o StrictHostKeyChecking=no Administrator@124.221.39.160:C:/cloud-agent/probe-screen.txt probe-screen.txt || exit 1
echo "=== probe-screen.txt ==="
cat probe-screen.txt
