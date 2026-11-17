#!/bin/bash
# 补装 pycryptodome 并重跑 push-qr
cd "C:/Users/a2436/Desktop/code/city-recruitment-mock-service/过程文件/cloud-deploy"
export SSH_ASKPASS_REQUIRE=force
export SSH_ASKPASS="$(pwd)/askpass.sh"
ssh -o StrictHostKeyChecking=no Administrator@124.221.39.160 'C:\Python312\python.exe -m pip install -q --disable-pip-version-check -i https://pypi.tuna.tsinghua.edu.cn/simple pycryptodome 2>&1'
echo "--- 依赖就绪，前台调试 push-qr（60 秒）---"
timeout 60 ssh -o StrictHostKeyChecking=no Administrator@124.221.39.160 'C:\Python312\python.exe C:\cloud-agent\push-qr.py' 2>&1
