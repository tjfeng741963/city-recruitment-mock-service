#!/bin/bash
# 服务器前台运行 push-qr（调试），60 秒后杀掉
cd "C:/Users/a2436/Desktop/code/city-recruitment-mock-service/过程文件/cloud-deploy"
export SSH_ASKPASS_REQUIRE=force
export SSH_ASKPASS="$(pwd)/askpass.sh"
timeout 60 ssh -o StrictHostKeyChecking=no Administrator@124.221.39.160 'C:\Python312\python.exe C:\cloud-agent\push-qr.py' 2>&1
