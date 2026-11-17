#!/bin/bash
# 定位服务器上的企业微信安装路径
cd "C:/Users/a2436/Desktop/code/city-recruitment-mock-service/过程文件/cloud-deploy"
export SSH_ASKPASS_REQUIRE=force
export SSH_ASKPASS="$(pwd)/askpass.sh"
python -c "src=open('probe-wxwork.cmd','rb').read(); open('probe-wxwork.cmd','wb').write(src.replace(b'\r\n', b'\n').replace(b'\n', b'\r\n'))"
scp -o StrictHostKeyChecking=no probe-wxwork.cmd Administrator@124.221.39.160:C:/cloud-agent/probe-wxwork.cmd
ssh -o StrictHostKeyChecking=no Administrator@124.221.39.160 'C:\cloud-agent\probe-wxwork.cmd'
scp -o StrictHostKeyChecking=no Administrator@124.221.39.160:C:/cloud-agent/wxwork-path.txt wxwork-path.txt
