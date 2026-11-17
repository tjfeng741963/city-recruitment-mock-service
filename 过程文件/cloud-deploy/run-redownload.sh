#!/bin/bash
# 推送断点续传安装脚本并脱离会话执行
cd "C:/Users/a2436/Desktop/code/city-recruitment-mock-service/过程文件/cloud-deploy"
export SSH_ASKPASS_REQUIRE=force
export SSH_ASKPASS="$(pwd)/askpass.sh"
python -c "src=open('redownload.cmd','rb').read(); open('redownload.cmd','wb').write(src.replace(b'\r\n', b'\n').replace(b'\n', b'\r\n'))"
scp -o StrictHostKeyChecking=no redownload.cmd Administrator@124.221.39.160:C:/cloud-agent/redownload.cmd
ssh -o StrictHostKeyChecking=no Administrator@124.221.39.160 'start "rdl" /min "C:\cloud-agent\redownload.cmd"'
echo 已启动，稍后用 poll-install.sh 查日志
