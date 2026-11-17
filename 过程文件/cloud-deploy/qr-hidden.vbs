' 隐藏运行批处理：计划任务用这个跑，避免 cmd 黑窗口出现在桌面上
CreateObject("WScript.Shell").Run """C:\cloud-agent\start-qr.cmd""", 0, False
