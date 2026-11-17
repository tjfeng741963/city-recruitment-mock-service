#!/bin/bash
# 推送并脱离会话执行 Python 安装，轮询结果
cd "C:/Users/a2436/Desktop/code/city-recruitment-mock-service/过程文件/cloud-deploy"
export SSH_ASKPASS_REQUIRE=force
export SSH_ASKPASS="$(pwd)/askpass.sh"
python -c "src=open('install-python.cmd','rb').read(); open('install-python.cmd','wb').write(src.replace(b'\r\n', b'\n').replace(b'\n', b'\r\n'))"
scp -o StrictHostKeyChecking=no install-python.cmd Administrator@124.221.39.160:C:/cloud-agent/install-python.cmd
ssh -o StrictHostKeyChecking=no Administrator@124.221.39.160 'start "pyinstall" "C:\cloud-agent\install-python.cmd"'
echo 已启动，90 秒后查询
sleep 90
ssh -o StrictHostKeyChecking=no Administrator@124.221.39.160 'C:\Python312\python.exe --version 2>&1 & C:\Python312\python.exe -m pip show httpx 2>&1 | findstr Name'
