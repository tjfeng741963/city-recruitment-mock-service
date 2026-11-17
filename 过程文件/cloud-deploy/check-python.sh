#!/bin/bash
# 查服务器 Python 安装进度（简单命令，无链式管道）
cd "C:/Users/a2436/Desktop/code/city-recruitment-mock-service/过程文件/cloud-deploy"
export SSH_ASKPASS_REQUIRE=force
export SSH_ASKPASS="$(pwd)/askpass.sh"
echo "--- python ---"
ssh -o StrictHostKeyChecking=no Administrator@124.221.39.160 'C:\Python312\python.exe --version 2>&1'
echo "--- 安装包大小 ---"
ssh -o StrictHostKeyChecking=no Administrator@124.221.39.160 'dir C:\cloud-agent\python-inst.exe 2>&1'
echo "--- 进程 ---"
ssh -o StrictHostKeyChecking=no Administrator@124.221.39.160 'tasklist /FI "IMAGENAME eq curl.exe" 2>&1'
