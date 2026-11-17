#!/bin/bash
# 启动服务器上的 setup 安装（独立窗口，断开 SSH 不影响）
cd "C:/Users/a2436/Desktop/code/city-recruitment-mock-service/过程文件/cloud-deploy"
export SSH_ASKPASS_REQUIRE=force
export SSH_ASKPASS="$(pwd)/askpass.sh"
exec ssh -o StrictHostKeyChecking=no Administrator@124.221.39.160 'start "setup" "C:\cloud-agent\run-setup.cmd"'
