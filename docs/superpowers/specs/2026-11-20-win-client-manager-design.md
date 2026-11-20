# Windows 客户端管理窗口

用户已确认上一轮提出的窗口方案并要求现在实施：显示当前版本、可用版本；独立提供检查更新、下载安装、启动与停止自动回复。使用现有 Python 3.11 自带 Tkinter 原生窗口，避免增加依赖；备选的浏览器本地服务需要端口维护，Electron 需要额外运行时，均不用于本次。

界面默认只读取本地版本和进程状态。网络检查由用户点击，后台线程执行，不阻塞窗口。检查只读取当前 main 与同 SHA 已发布包的元数据；包未发布时明确提示。更新再次确认同一版本，复用已有哈希、冻结核心、备份与回滚；安装前拒绝已有 autopilot 进程，下载完成再复查。更新永远不自动启动发送。

启动由独立按钮及明确确认触发，沿原 `pilot-hidden.vbs` 链启动；先检查本地必要文件、冻结核心和单实例，并确认后台进程出现。停止只终止本目录 autopilot，按进程命令行、PID、创建时间重新验证，绝不按 python.exe 批量杀进程；现有客户端无优雅退出 API，因此确认框说明停止可能中断本条处理，应检查未确定的发送记录。本功能不修改 agent 或冻结动作层，也不更改 CloudPilot.Enabled。

一个只读状态区显示运行/停止、自动登录任务启用状态、完整提交号（支持复制）、发布源和操作阶段。检查/更新失败显示中文原因和查看日志入口，保留原文件。重复点击在操作结束前禁用；关闭窗口不停止自动回复。新启动器 `client-manager.vbs` 使用已部署 Python311/pythonw 隐藏控制台，并由 bootstrap 创建桌面快捷方式；旧自动登录更新入口保留。

国内 COS 分发未配置，本次界面如实显示 GitHub 下载源和网络故障，不伪装已接入国内源。PR72 尚未合并时界面必须显示未发布而非允许安装。安装 GUI 后 CloudPilot 保持禁用，不执行真实启动/停止发送测试。

测试覆盖：检查不下载、不启动；更新不启动/不变更任务；重复实例/候选版本漂移/下载失败阻止安装；进程精确匹配/停止重验；GUI 按钮状态、异步错误与无自动发送；打包包含 GUI 和启动器。Windows 实机测试只打开窗口、读状态、检查元数据，合成客户端目录测试实际安装/回滚。记录测试、备份与入口位置。


## Implementation status

Implemented on `codex/win-client-release`. The existing server still uses GitHub Release as the source; COS remains a separate distribution task. First GUI migration requires the reviewed bootstrap because the previous updater allowlist cannot safely accept GUI files. A manager protocol manifest gate prevents an older release from overwriting a GUI-capable updater.
