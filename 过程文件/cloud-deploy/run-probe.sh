#!/bin/bash
# 推送并执行探针，拉回结果
cd "C:/Users/a2436/Desktop/code/city-recruitment-mock-service/过程文件/cloud-deploy"
export SSH_ASKPASS_REQUIRE=force
export SSH_ASKPASS="$(pwd)/askpass.sh"
python -c "src=open('probe3.cmd','rb').read(); open('probe3.cmd','wb').write(src.replace(b'\r\n', b'\n').replace(b'\n', b'\r\n'))"
scp -o StrictHostKeyChecking=no probe3.cmd Administrator@124.221.39.160:C:/cloud-agent/probe3.cmd
ssh -o StrictHostKeyChecking=no Administrator@124.221.39.160 'C:\cloud-agent\probe3.cmd'
scp -o StrictHostKeyChecking=no Administrator@124.221.39.160:C:/cloud-agent/probe-out.txt probe-out3.txt
