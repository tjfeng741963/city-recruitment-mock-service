#!/bin/bash
# 以常驻方式启动服务器上的二维码引导（pythonw，脱离 ssh 会话）
cd "C:/Users/a2436/Desktop/code/city-recruitment-mock-service/过程文件/cloud-deploy"
export SSH_ASKPASS_REQUIRE=force
export SSH_ASKPASS="$(pwd)/askpass.sh"
ssh -o StrictHostKeyChecking=no Administrator@124.221.39.160 'start "pushqr" /min C:\Python312\pythonw.exe C:\cloud-agent\push-qr.py'
echo "push-qr 已启动（pythonw 后台）"
