@echo off
cd /d C:\Users\a2436\Desktop\code\city-recruitment-mock-service
set REA_MESSAGE_CHANNEL_PROVIDER=bridge
set AGENT_LLM_API_KEY=sk-41e328edaaa64ae7b0a7553410a1a445
set AGENT_LLM_MODEL=deepseek-chat
call npm run dev > npm-dev.log 2>&1
