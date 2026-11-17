#!/bin/bash
# 云服务器反向隧道：服务器 18080→本地 8080，18090→本地 8090
# 依赖 askpass.sh（SSH_ASKPASS），保活用 ServerAliveInterval
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
export SSH_ASKPASS_REQUIRE=force
export SSH_ASKPASS="C:/Users/a2436/Desktop/code/city-recruitment-mock-service/过程文件/cloud-deploy/askpass.sh"
exec ssh -N \
  -o StrictHostKeyChecking=no \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=6 \
  -o ExitOnForwardFailure=yes \
  -R 18080:127.0.0.1:8080 \
  -R 18090:127.0.0.1:8090 \
  Administrator@124.221.39.160
