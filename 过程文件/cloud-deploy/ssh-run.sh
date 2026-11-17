#!/bin/bash
# 非交互 SSH 助手：SSH_ASKPASS 提供密码，执行远端命令
set -a
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'
export SSH_ASKPASS_REQUIRE=force
export SSH_ASKPASS="C:/Users/a2436/Desktop/code/city-recruitment-mock-service/过程文件/cloud-deploy/askpass.sh"
exec ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 Administrator@124.221.39.160 "$@"
