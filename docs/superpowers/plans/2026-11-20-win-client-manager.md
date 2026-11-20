# Windows 客户端管理窗口 Implementation Plan

> 在现有独立 worktree 内逐项执行，按检查点验证；不合并 main，不启动真实发送。

**Goal:** Windows 桌面点击管理窗口，独立检查/安装更新和控制回复进程。

**Architecture:** updater 负责发布查询及事务安装；client_manager_service 负责带互斥的管理操作及精确进程识别；client_manager 使用 Tkinter 和工作线程队列呈现状态；VBS 为无控制台入口。包构建器显式加入模块及 VBS，bootstrap 安装它们且保留禁用任务。

**Tech Stack:** Python 3.11 标准库 Tkinter/threading/queue、PowerShell CIM、既有 GitHub Release。

## Global Constraints

- 不改 agent 或 wecom_io_core，不添加任何发送动作。
- 更新与启动分离；打开窗口、检查和更新均不得调用发送启动器。
- CloudPilot 保持原 Enabled；不清理账本或重排 unknown。
- 使用现有 GitHub 发布路径，网络故障明确反馈；COS 为独立后续。
- 只提交本次路径，完整本地/CI 验证后推送现有 PR72。

## Task 1: 更新与进程控制服务

- [ ] 在 `backend/tests/test_windows_client_manager.py` 写测试：`check_release()` 仅读取元数据，`ManagerService.update(expected_commit)` 持互斥、核对版本、复查进程、安装后不启动；`is_client_process(row, root)` 只匹配本目录 Python autopilot。
- [ ] 执行 focused pytest，确认新增 API 缺失而失败。
- [ ] 修改 `deploy/client/client_updater.py` 提供 `check_release()`；保留既有 `fetch_release_package()` / 自动登录行为。
- [ ] 新建 `deploy/client/client_manager_service.py`，实现 `status/check/update/start/stop`；PowerShell 超时和错误 fail closed。进程停止重新核对创建时间和路径；启动等待进程出现，失败输出本地日志位置。
- [ ] focused 测试通过，包括已有 updater 测试；更新 bootstrap 哈希。

## Task 2: 窗口与分发

- [ ] GUI 行为测试先断言 ManagerWindow 无自动网络/发送、按钮检查/更新分离、操作忙碌时阻止重入、错误可见。
- [ ] 新建 `deploy/client/client_manager.py`，中文标签、版本状态、独立更新与启动/停止、阶段进度、日志入口；网络后台线程，Tk 只在主线程更新。
- [ ] 新建 `deploy/client/客户端管理.vbs`；更新 package builder、updater allowlist 和 bootstrap 资产，创建唯一桌面快捷方式。全流程无运行任务动作。
- [ ] 打包测试包含管理文件；PowerShell fixture 同步模拟快捷方式，干跑不创建文件。
- [ ] 本地和 Windows 隔离目录验证 GUI。实机只部署管理文件、打开窗口及检查状态，不发送。

## Task 3: 验收与 PR

- [ ] 运行 npm ci、迁移/API 文档检查、tsc、前端构建、vitest、完整 pytest、workflow 检查。
- [ ] 独立代码复核并解决阻塞；显式路径提交，构建提交对应包，验证 GUI 文件入包及运行数据保留。
- [ ] 更新 PR72 描述、推送并等待 Ubuntu/Windows/package 检查全绿；记录桌面入口、操作步骤和未发布限制。
