#!/bin/bash
# 推送 push-qr.py 与 deploy-app.cmd，执行部署
cd "C:/Users/a2436/Desktop/code/city-recruitment-mock-service/过程文件/cloud-deploy"
export SSH_ASKPASS_REQUIRE=force
export SSH_ASKPASS="$(pwd)/askpass.sh"
python -c "src=open('deploy-app.cmd','rb').read(); open('deploy-app.cmd','wb').write(src.replace(b'\r\n', b'\n').replace(b'\n', b'\r\n'))"
scp -o StrictHostKeyChecking=no cloud-agent/push-qr.py Administrator@124.221.39.160:C:/cloud-agent/push-qr.py
scp -o StrictHostKeyChecking=no deploy-app.cmd Administrator@124.221.39.160:C:/cloud-agent/deploy-app.cmd
ssh -o StrictHostKeyChecking=no Administrator@124.221.39.160 'C:\cloud-agent\deploy-app.cmd'
