@echo off
rem 本地一键启动：8080 主服务 + 8090 旧后端 + 云服务器反向隧道
rem （服务器侧的企微/autopilot/推送器由计划任务 CloudQR/CloudPilot 常驻，无需这里管）

cd /d "%~dp0..\.."

echo [1/3] 启动 8080 主服务（npm run dev）...
start "8080-主服务" cmd /c "set AGENT_LLM_API_KEY=sk-41e328edaaa64ae7b0a7553410a1a445&& set AGENT_LLM_MODEL=deepseek-chat&& npm run dev"

echo [2/3] 启动 8090 旧后端（uvicorn）...
start "8090-旧后端" cmd /c "cd /d %~dp0..\..\backend&& .venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8090"

echo [3/3] 启动云服务器反向隧道（18080→8080，18090→8090）...
start "SSH隧道" cmd /c "cd /d %~dp0&& bash tunnel.sh"

echo.
echo 全部启动完成：
echo   后台管理  http://127.0.0.1:8080
echo   调试台    http://127.0.0.1:8080/dev
echo   服务器侧企微/autopilot 由计划任务值守，掉登录网页 /dev 会出现二维码
pause
