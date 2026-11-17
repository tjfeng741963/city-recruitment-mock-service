#!/bin/bash
# 在 Console 会话输入验证码：run-input-code.sh <code>
set -a
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
export SSH_ASKPASS_REQUIRE=force
export SSH_ASKPASS="C:/Users/a2436/Desktop/code/city-recruitment-mock-service/过程文件/cloud-deploy/askpass.sh"
cd "C:/Users/a2436/Desktop/code/city-recruitment-mock-service/过程文件/cloud-deploy" || exit 1

CODE="${1:?用法: run-input-code.sh <验证码>}"

python -c "
src = open('task-input-code.cmd', 'rb').read().replace(b'\r\n', b'\n').replace(b'\n', b'\r\n')
open('task-input-code.cmd', 'wb').write(src)
print('CRLF ok')"

scp -o StrictHostKeyChecking=no task-input-code.cmd input-code.py Administrator@124.221.39.160:C:/cloud-agent/ || exit 1
ssh -o StrictHostKeyChecking=no Administrator@124.221.39.160 "schtasks /Delete /TN CloudInput /F >nul 2>&1 & schtasks /Create /TN CloudInput /TR \"C:\cloud-agent\task-input-code.cmd $CODE\" /SC ONCE /ST 23:57 /RU Administrator /IT /F & schtasks /Run /TN CloudInput" > /dev/null 2>&1
sleep 10
scp -o StrictHostKeyChecking=no Administrator@124.221.39.160:C:/cloud-agent/input-code-out.txt input-code-out.txt || exit 1
echo "=== 输入结果 ==="
iconv -f GBK -t UTF-8 input-code-out.txt 2>/dev/null || cat input-code-out.txt
