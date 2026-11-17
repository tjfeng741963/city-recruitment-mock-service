@echo off
chcp 65001 >nul
rem 云企微客户端一键安装：在服务器上、于本文件所在目录执行
echo === 1. 检查 Python ===
python --version >nul 2>&1 || (echo 未找到 Python，请先安装 Python 3.11+ 并勾选 Add to PATH & pause & exit /b 1)
echo Python OK
echo === 2. 安装依赖 ===
pip install -q httpx
echo === 3. 写入配置 ===
if not exist agent\config.json copy /Y config.json agent\config.json
echo === 4. 完成 ===
echo 部署目录: %cd%\agent
echo 之后用 start-client.cmd 启动客户端（需先在本地侧把反向隧道跑起来）
pause
